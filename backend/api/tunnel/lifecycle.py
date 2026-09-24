"""WiFi-tunnel lifecycle — status / stop / start-and-connect."""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter
from pydantic import BaseModel, Field, field_validator
from pymobiledevice3.exceptions import ConnectionTerminatedError

from api._deps import get_app_state, get_device_manager, get_tunnel_runner
from api._errors import ErrorCode, http_err, max_devices_error
from api.tunnel._helpers import (
    TeardownStep,
    connect_device_over_tunnel,
    run_teardown_steps,
    validate_local_ip,
)
from config import MAX_DEVICES, REMOTE_PAIRING_PORT
from services import connection_state
from services.wifi_discovery import discover_remotepairing_ports
from services.wifi_tunnel_service import (
    cleanup_wifi_connections,
    get_watchdog,
    set_watchdog,
    teardown_wifi_tunnel,
)

logger = logging.getLogger(__name__)
_tunnel_logger = logging.getLogger("wifi_tunnel")

router = APIRouter()


class WifiTunnelStartRequest(BaseModel):
    ip: str
    port: int = Field(default=REMOTE_PAIRING_PORT, ge=1, le=65535)
    udid: str | None = None

    @field_validator("ip")
    @classmethod
    def _check_ip(cls, v: str) -> str:
        return validate_local_ip(v)


async def _tunnel_watchdog(task: asyncio.Task, gen: int) -> None:
    """Watch the tunnel task; if it dies unexpectedly (WiFi blip, iPhone
    locked, admin revoked), clean up any dependent WiFi connections so the
    UI can recover gracefully. A 5s grace window allows the user to restart
    the tunnel before we tear down engines.

    *gen* is the tunnel epoch we were spawned to watch. Comparing the
    live ``tunnel.generation`` against this snapshot survives a
    stop + start cycle inside the grace window — the previous identity
    check against ``tunnel.task`` (which transiently goes None between
    ``stop()`` and the next ``start()``) would have torn down the
    brand-new tunnel's resources by mistake.
    """
    tunnel = get_tunnel_runner()
    try:
        try:
            await task
        except asyncio.CancelledError:
            return
        except BaseException as exc:
            _tunnel_logger.debug(
                "watchdog: tunnel task raised %s; proceeding to cleanup",
                exc.__class__.__name__, exc_info=True,
            )

        if tunnel.generation != gen:
            _tunnel_logger.info(
                "watchdog: generation mismatch (current=%d, expected=%d); "
                "stale watchdog exiting without cleanup",
                tunnel.generation, gen,
            )
            return

        _tunnel_logger.warning("Tunnel task exited unexpectedly; 5s grace period")
        try:
            from services.ws_broadcaster import broadcast
            await broadcast("tunnel_degraded", {"reason": "task_exited"})
        except Exception:
            _tunnel_logger.exception("Failed to emit tunnel_degraded event")

        await asyncio.sleep(5.0)

        async with tunnel.lock:
            if tunnel.generation != gen:
                _tunnel_logger.info(
                    "watchdog: generation mismatch after grace "
                    "(current=%d, expected=%d); bailing without cleanup",
                    tunnel.generation, gen,
                )
                if tunnel.is_running():
                    try:
                        from services.ws_broadcaster import broadcast
                        await broadcast("tunnel_recovered", {})
                    except Exception as exc:
                        _tunnel_logger.debug(
                            "watchdog: tunnel_recovered broadcast failed (%s)",
                            exc.__class__.__name__, exc_info=True,
                        )
                return
            await cleanup_wifi_connections()
            tunnel.task = None
            tunnel.info = None
            try:
                from services.ws_broadcaster import broadcast
                await broadcast("tunnel_lost", {"reason": "task_exited"})
            except Exception:
                _tunnel_logger.exception("Failed to emit tunnel_lost event")
    except asyncio.CancelledError:
        raise


# Total time spent retrying other ports after the requested one fails.
_PORT_RECOVERY_BUDGET_S = 45.0
_PORT_RETRY_TIMEOUT_S = 10.0


async def _start_with_port_recovery(tunnel, udid: str, ip: str, port: int) -> dict:
    """Start the tunnel on *port*; if nothing usable answers there, find the
    port RemotePairing actually listens on and retry.

    The saved or default port goes stale when the iPhone restarts and
    RemotePairing picks a new one. A pair-verify rejection means we did
    reach RemotePairing, so it is re-raised as-is rather than retried.
    Returns the tunnel info plus the ``port`` that worked, so the UI can
    remember it.
    """
    try:
        info = await tunnel.start(udid, ip, port, timeout=20.0)
        return {**info, "port": port}
    except ConnectionTerminatedError:
        raise
    except Exception as first_exc:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + _PORT_RECOVERY_BUDGET_S
        candidates = await discover_remotepairing_ports(ip, exclude={port})
        _tunnel_logger.info(
            "Tunnel start on %s:%d failed (%s); trying other ports %s",
            ip, port, type(first_exc).__name__, candidates[:10],
        )
        for candidate in candidates:
            remaining = deadline - loop.time()
            if remaining < 3.0:
                break
            try:
                info = await tunnel.start(
                    udid, ip, candidate, timeout=min(_PORT_RETRY_TIMEOUT_S, remaining),
                )
            except ConnectionTerminatedError:
                raise
            except Exception:
                _tunnel_logger.debug("Tunnel start on %s:%d failed", ip, candidate, exc_info=True)
                continue
            _tunnel_logger.info("Tunnel started on recovered port %s:%d", ip, candidate)
            return {**info, "port": candidate}
        raise first_exc


def _tunnel_busy_error(tunnel, ip: str):
    """Return a 409 ``tunnel_busy`` error when the running tunnel serves
    a different IP than *ip*, else None.

    The WiFi tunnel is a process-wide singleton, so a request for a
    second device must fail loudly rather than be answered with the
    first device's tunnel. Compared by IP: the tunnel's udid argument
    may be a pre-resolved guess, not the device it reached.
    """
    if not tunnel.is_running() or not tunnel.info:
        return None
    current_ip = tunnel.info.get("ip")
    if current_ip and ip != current_ip:
        return http_err(
            409, ErrorCode.TUNNEL_BUSY,
            "Only one WiFi device is supported at a time; disconnect the "
            "current WiFi device first",
        )
    return None


async def _do_tunnel_start(req: WifiTunnelStartRequest) -> dict:
    """Start an in-process WiFi tunnel (requires admin). Used by the
    /wifi/tunnel/start-and-connect route."""
    tunnel = get_tunnel_runner()
    async with tunnel.lock:
        if tunnel.is_running():
            busy = _tunnel_busy_error(tunnel, req.ip)
            if busy is not None:
                raise busy
            if tunnel.info:
                return {"status": "already_running", **tunnel.info}
            return {"status": "already_running"}

        resolved_udid = req.udid
        if not resolved_udid:
            try:
                conns = get_device_manager().connected_udids
                if conns:
                    resolved_udid = conns[0]
            except (RuntimeError, AttributeError) as exc:
                _tunnel_logger.debug(
                    "wifi_tunnel_start: could not pre-resolve udid from device manager (%s)",
                    exc.__class__.__name__, exc_info=True,
                )
        if not resolved_udid:
            resolved_udid = "auto"

        _tunnel_logger.info(
            "Starting WiFi tunnel: udid=%s ip=%s port=%d",
            resolved_udid, req.ip, req.port,
        )

        try:
            info = await _start_with_port_recovery(tunnel, resolved_udid, req.ip, req.port)
        except asyncio.TimeoutError:
            raise http_err(500, ErrorCode.TUNNEL_TIMEOUT, "Tunnel startup timed out (20 s)")
        except ConnectionTerminatedError:
            # Device answered pair-verify with an ERROR TLV: the host's
            # RemotePairing record is stale/revoked, or the target IP is
            # the USB-NCM link-local interface, where remoted refuses the
            # WiFi pair record. Generic "spawn failed" hid both causes.
            _tunnel_logger.warning(
                "Tunnel pair-verify rejected by device (udid=%s ip=%s port=%d)",
                resolved_udid, req.ip, req.port,
            )
            raise http_err(
                500, ErrorCode.TUNNEL_PAIR_REJECTED,
                "Device rejected pairing verification — re-pair over USB "
                "or check the device is on the same Wi-Fi network",
            )
        except Exception:
            logger.exception(
                "Tunnel spawn failed",
                extra={"udid": resolved_udid, "ip": req.ip, "port": req.port},
            )
            raise http_err(500, ErrorCode.TUNNEL_SPAWN_FAILED, "Could not start the tunnel; see the backend log")

        _tunnel_logger.info("WiFi tunnel started: %s", info)
        existing = get_watchdog()
        if existing is None or existing.done():
            set_watchdog(asyncio.create_task(
                _tunnel_watchdog(tunnel.task, tunnel.generation)
            ))
        return {"status": "started", **info}


@router.get("/wifi/tunnel/status")
async def wifi_tunnel_status():
    """Check if the WiFi tunnel is running."""
    tunnel = get_tunnel_runner()
    if not tunnel.is_running():
        tunnel.info = None
        return {"running": False}
    return {"running": True, **(tunnel.info or {})}


async def _attempt_usb_fallback(app_state, dm) -> None:
    """If a non-Network device is still attached, reconnect it over USB and
    spin up a new simulation engine. On engine-creation failure, roll back
    the half-built connection so the device list never advertises a
    connected device without a backing engine."""
    devices = await dm.discover_devices()
    usb_dev = next((d for d in devices if d.connection_type != "Network"), None)
    if usb_dev is None:
        return

    udid = usb_dev.udid
    try:
        await dm.connect(udid)
    except Exception:
        _tunnel_logger.exception("USB fallback: connect failed for %s", udid)
        return

    try:
        await app_state.create_engine_for_device(udid)
        _tunnel_logger.info("Switched back to USB connection: %s", udid)
    except Exception:
        _tunnel_logger.exception(
            "USB fallback: engine creation failed for %s; rolling back", udid,
        )
        # Shared rollback: terminate engine, disconnect, broadcast
        # device_error — each step independent. The store transition
        # inside is a no-op here (this path connects via dm.connect
        # directly, so the SSoT never went CONNECTED).
        await connection_state.rollback_failed_connect(
            dm, app_state, udid,
            cause="usb_fallback_failed",
            stage="usb_fallback",
            error="USB fallback engine creation failed",
        )


@router.post("/wifi/tunnel/stop")
async def wifi_tunnel_stop():
    """Stop the WiFi tunnel and clean up any network-based device
    connections that were routed through it."""
    app_state = get_app_state()
    dm = get_device_manager()
    tunnel = get_tunnel_runner()

    async with tunnel.lock:
        if not tunnel.is_running():
            # We may still hold stale tunnel device entries.
            await cleanup_wifi_connections()
            tunnel.info = None
            tunnel.task = None
            return {"status": "not_running"}

        # Devices first (engine → transport), then the watchdog, then the
        # tunnel task itself — the same teardown the liveness loop runs.
        await teardown_wifi_tunnel(reason="wifi_tunnel_stopped")

    # USB fallback runs outside the tunnel lock — it acquires its own
    # device-manager locks and we don't want to hold tunnel.lock across
    # a network/USB discovery + connect roundtrip.
    fallback_steps: list[TeardownStep] = [
        TeardownStep("usb_fallback", lambda: _attempt_usb_fallback(app_state, dm)),
    ]
    await run_teardown_steps(fallback_steps)

    return {"status": "stopped"}


@router.post("/wifi/tunnel/start-and-connect")
async def wifi_tunnel_start_and_connect(req: WifiTunnelStartRequest):
    """Start a WiFi tunnel and immediately connect the device through it."""
    # usbmux WiFi-sync (Finder's "Show this iPhone when on Wi-Fi") connects
    # Network devices with their own CoreDevice tunnel — no RemotePairing
    # tunnel needed. Starting one anyway races a second tunnel against the
    # live connection, or times out against a phone that is already busy.
    # Without an explicit udid we can't map the requested IP to a device,
    # so any live Network device counts as "this is the one you meant".
    busy = _tunnel_busy_error(get_tunnel_runner(), req.ip)
    if busy is not None:
        raise busy
    network_udids = get_device_manager().udids_by_connection_type("Network")
    if network_udids and (req.udid is None or req.udid in network_udids):
        udid = req.udid or network_udids[0]
        md = connection_state.store.metadata_for(udid)
        _tunnel_logger.info(
            "Tunnel start skipped: %s already connected via Network", udid,
        )
        return {
            "status": "already_connected",
            "udid": udid,
            "name": md.get("name", ""),
            "ios_version": md.get("ios_version", ""),
            "connection_type": "Network",
        }

    tunnel_result = await _do_tunnel_start(req)
    if tunnel_result.get("status") not in ("started", "already_running"):
        raise http_err(500, ErrorCode.TUNNEL_FAILED, "Tunnel startup failed")

    rsd_address = tunnel_result.get("rsd_address")
    rsd_port = tunnel_result.get("rsd_port")

    if not rsd_address or not rsd_port:
        raise http_err(500, ErrorCode.TUNNEL_NO_RSD, "Tunnel started but RSD info is missing")

    dm = get_device_manager()
    # Gate stays OUTSIDE the try so max_devices_error isn't remapped to CONNECT_FAILED.
    if dm.connected_count >= MAX_DEVICES:
        raise max_devices_error()
    try:
        # Shared connect → announce_connected (SSoT sync so the device flips
        # USB→Network and /api/device/list stops replaying the stale USB pill)
        # → create_engine sequence; merge the RSD info into the result.
        result = await connect_device_over_tunnel(rsd_address, rsd_port)
        return {
            **result, "rsd_address": rsd_address, "rsd_port": rsd_port,
            "port": tunnel_result.get("port", req.port),
        }
    except Exception:
        logger.exception(
            "Tunnel started but device connection failed",
            extra={"rsd_address": rsd_address, "rsd_port": rsd_port},
        )
        raise http_err(500, ErrorCode.CONNECT_FAILED, "Tunnel started but device connection failed")
