"""WiFi tunnel service primitives shared by the api/ router and core/.

Hosts the cross-layer state and helpers the WiFi tunnel needs from
business logic (``core/tunnel_liveness``) without that layer having to
reach back up into ``api/``:

  - ``tunnel`` — process-wide :class:`TunnelRunner` singleton. The
    :mod:`api.tunnel_router` router and the liveness watcher both serialise
    against the same instance via its internal lock.
  - The tunnel-watchdog task handle (``get_watchdog`` / ``set_watchdog`` /
    ``cancel_watchdog``) — lives next to the TunnelRunner it guards so
    ``main.py``'s lifespan and the api/tunnel router both depend downward
    on this service instead of reaching into each other.
  - ``_tcp_probe`` — single-port TCP reachability probe used both by the
    /24 subnet scan and by ``tunnel_liveness`` to confirm the RSD is
    still answering.
  - ``cleanup_wifi_connections`` — drop every Network-mode device,
    terminate its engine, and emit ``device_disconnected`` so the UI
    re-renders before the next user action errors out.

Layering
--------
This module is part of the **connection-orchestration group** (see
``tools/check_layers.py``): runtime loops/coordinators that may depend on
both ``core/`` and ``services/`` and on the ``context.ctx`` app-state
singleton. Concretely it is the one ``services/`` module allowed to
import ``core/`` (``core.wifi_tunnel.TunnelRunner`` — the runner singleton
must live below ``api/`` so both the router and the liveness probe share
it). The ``ctx`` import stays because the entry points here are invoked
from many sites (api/tunnel routes, the usbmux watchdog, the liveness
loop) that don't carry an ``AppState`` handle, and the unit tests
monkeypatch ``ctx.app_state`` directly.
"""

from __future__ import annotations

import asyncio
import logging

from context import ctx
from core.wifi_tunnel import TunnelRunner
from services import connection_state
from services.location_service import DeviceLostCause

logger = logging.getLogger("wifi_tunnel")

# Process-wide tunnel runner. Serialised by its own asyncio.Lock so
# concurrent /start or /stop requests never race.
tunnel = TunnelRunner()

# Watchdog task handle (module-level since TunnelRunner is process-wide).
_tunnel_watchdog_task: "asyncio.Task | None" = None


def get_watchdog() -> "asyncio.Task | None":
    return _tunnel_watchdog_task


def set_watchdog(task: "asyncio.Task | None") -> None:
    global _tunnel_watchdog_task
    _tunnel_watchdog_task = task


def cancel_watchdog() -> None:
    """Cancel + drop the module-level watchdog task if it's still alive."""
    task = get_watchdog()
    if task is None or task.done():
        set_watchdog(None)
        return
    task.cancel()
    set_watchdog(None)


async def _tcp_probe(ip: str, port: int, timeout: float = 0.4) -> bool:
    """Open a single TCP connection to ``ip:port`` and immediately close.

    Returns True if the SYN/ACK handshake completed within ``timeout``.
    Used by the subnet scan + the liveness probe; both treat a single
    miss as transient and require multiple consecutive misses before
    declaring the endpoint dead.
    """
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(ip, port), timeout=timeout,
        )
        writer.close()
        try:
            await writer.wait_closed()
        except (OSError, ConnectionError) as exc:
            logger.debug(
                "_tcp_probe(%s:%d): wait_closed raised (%s); socket already torn down",
                ip, port, exc.__class__.__name__, exc_info=True,
            )
        return True
    except (OSError, ConnectionError, asyncio.TimeoutError):
        return False


def tunnel_udids(dm) -> list[str]:
    """UDIDs connected through the in-process WiFi tunnel.

    Excludes usbmux Network connections (Finder's Wi-Fi sync), which
    have their own CoreDevice tunnel and outlive this one.
    """
    return [
        udid for udid in dm.udids_by_connection_type("Network")
        if dm.is_via_wifi_tunnel(udid)
    ]


async def cleanup_wifi_connections(reason: str = "wifi_tunnel_stopped") -> list[str]:
    """Disconnect the devices that ride the WiFi tunnel + drop their
    simulation engines. usbmux Network devices are left alone.

    Routes every disconnect through :mod:`services.connection_state`
    (the SSoT installed in commit ``3dc3bb4``) so the state machine and
    the WS observer's ``device_disconnected`` broadcast stay in sync.
    Returns the UDIDs that were disconnected.

    *reason* is logged server-side for diagnostics
    (``tunnel_lost_liveness`` vs ``wifi_tunnel_stopped`` vs user-driven
    stop). The wire-format ``cause`` is always
    :data:`DeviceLostCause.WIFI_DROPPED` regardless of *reason* — the
    device-level effect is the same no matter who triggered teardown.
    """
    app_state = ctx.app_state
    dm = app_state.device_manager
    udids: list[str] = []
    try:
        udids = tunnel_udids(dm)
        # Stop engine tasks *before* tearing down the transport. A running
        # Navigate / RandomWalk loop would otherwise keep emitting events
        # against a dead RSD and spam "arrived at destination" log noise.
        for udid in udids:
            try:
                await app_state.terminate_engine(udid)
            except Exception:
                logger.exception("Failed to terminate engine for %s", udid)
        cause = DeviceLostCause.WIFI_DROPPED.value
        for udid in udids:
            logger.info(
                "Disconnecting WiFi device %s (reason=%s, cause=%s)",
                udid, reason, cause,
            )
            try:
                # ``connection_state.disconnect_device`` swallows transport
                # errors internally (dm.disconnect raising during a
                # device-lost cleanup is the expected case — every close
                # step against a dead socket is supposed to fail). It
                # then fires the transition, which the installed
                # ``_ws_observer`` translates into a deduped
                # ``device_disconnected`` broadcast carrying both
                # ``reason`` and ``cause``.
                await connection_state.disconnect_device(dm, udid, cause=cause)
            except Exception:
                logger.exception("Failed to disconnect %s via connection_state", udid)
    except Exception:
        logger.exception("WiFi cleanup step failed")
    return udids


async def reconnect_usb_over_wifi(udid: str) -> bool:
    """Reconnect a just-dropped USB device over an already-running WiFi
    tunnel, if one is alive. Returns True when the device is back online
    over Network transport; False when no usable tunnel exists or the
    reconnect failed (caller should fall through to a full disconnect).

    Only fires when a tunnel is already up — it does NOT establish a new
    tunnel (that needs the device's WiFi IP + a pairing handshake, which
    a freshly-unplugged device may not support). The common case (USB
    device with no tunnel running) returns False immediately, preserving
    the existing "re-plug or restart tunnel" behaviour.
    """
    if not tunnel.is_running() or tunnel.info is None:
        return False
    if hasattr(tunnel, "transport_alive") and not tunnel.transport_alive():
        return False
    info = tunnel.info
    rsd_address = info.get("rsd_address")
    rsd_port = info.get("rsd_port")
    if not rsd_address or not rsd_port:
        return False

    app_state = ctx.app_state
    dm = app_state.device_manager
    try:
        # Tear down the dead USB engine + transport before re-handshaking
        # over WiFi — mirrors the ordering in cleanup_wifi_connections.
        try:
            await app_state.terminate_engine(udid)
        except Exception:
            logger.exception("USB→WiFi fallback: terminate_engine failed for %s", udid)
        try:
            await dm.disconnect(udid)
        except Exception:
            logger.debug("USB→WiFi fallback: USB disconnect for %s raised (socket already dead)", udid, exc_info=True)

        new_info = await dm.connect_wifi_tunnel(rsd_address, rsd_port)
        # The tunnel resolves its own UDID from the RSD peer. If it points
        # at a different device, undo and bail so we don't silently swap
        # which phone the user is driving.
        if new_info.udid != udid:
            logger.warning(
                "USB→WiFi fallback: tunnel device %s != dropped %s; aborting",
                new_info.udid, udid,
            )
            try:
                await dm.disconnect(new_info.udid)
            except Exception:
                logger.debug("USB→WiFi fallback: cleanup disconnect failed", exc_info=True)
            return False
        await app_state.create_engine_for_device(udid)
    except Exception:
        logger.exception("USB→WiFi fallback failed for %s", udid)
        return False

    # Re-announce as CONNECTED over Network. The USB transport is truly
    # gone, so the SSoT transitions through DISCONNECTED first — see
    # ``connection_state.reannounce_connected`` for the rationale.
    await connection_state.reannounce_connected(
        dm, udid,
        cause="usb_to_wifi_fallback",
        disconnect_cause="usb_removed_pre_wifi_fallback",
        # The unplugged device is no longer in usbmux, so use the
        # tunnel's own DeviceInfo instead of re-discovering.
        metadata={
            "name": new_info.name or "",
            "ios_version": new_info.ios_version or "",
            "connection_type": "Network",
        },
    )
    logger.info("USB→WiFi fallback succeeded for %s (now Network)", udid)
    return True
