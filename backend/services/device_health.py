"""On-connect device health probes — transport + DVT channel.

Extracted from ``api/websocket.py`` so the WS endpoint stays a thin
auth / register / dispatch layer and the probe-and-reconcile business
logic lives with the rest of the device-state services (it only touches
``services.connection_state``, the WiFi tunnel, and ``ctx.app_state`` —
nothing HTTP-shaped).

Why this exists
---------------
The renderer's on-(re)connect ``device_snapshot`` is served straight
from the :mod:`services.connection_state` cache, so a device that died
while the renderer was unmounted would paint a phantom "connected" pill
until the watchdogs catch up (usbmux ~3s, tunnel liveness ~15s). The
probes scheduled here close that gap: each freshly snapshotted UDID gets
a non-blocking two-layer check —

  1. **Transport** — TCP / usbmux round-trip
     (:func:`probe_transport_alive_one`). Provably-dead transport routes
     through :func:`services.connection_state.disconnect_device` so the
     SSoT broadcasts ``device_disconnected`` immediately.
  2. **DVT channel** — :func:`probe_dvt_health_one`, which delegates to
     the public :meth:`LocationService.probe_channel_alive`. Failure
     here is the "transport alive but DVT channel dropped" case (brief
     screen-lock, instrument idle-close); the device is marked DEGRADED
     so :meth:`DvtLocationService._reconnect` picks it up on the next
     teleport.

Every probe is fail-open: anything we can't check safely is reported
alive, because a false positive flaps the device pill for no reason.

Layering: part of the **connection-orchestration group** (see
``tools/check_layers.py``) — it may depend on both ``core/`` and
``services/`` and on ``context.ctx``. The ``ctx`` import is kept (rather
than threading ``AppState`` parameters through) because the entry point
:func:`schedule_probes` is fire-and-forget from ``api/websocket.py`` with
only a UDID list, and the tests monkeypatch ``ctx.app_state`` directly.
"""

from __future__ import annotations

import asyncio
import logging
import time

from context import ctx

logger = logging.getLogger(__name__)

# Debounce window for the on-connect health probe. Renderer reloads
# fire connect → disconnect → connect within ~30ms; without a window the
# probe races with itself against the same UDID. 1s comfortably covers
# the reload burst without delaying a legitimate user-driven reconnect.
PROBE_DEBOUNCE_S = 1.0
_last_probe_at: dict[str, float] = {}

# Strong refs to in-flight probes so asyncio doesn't GC them mid-run.
# Tasks self-remove on completion via the done callback below.
_probe_tasks: set[asyncio.Task] = set()


async def probe_dvt_health_one(udid: str) -> bool:
    """Best-effort DVT instrument health check for *udid*.

    Returns ``False`` only when the DVT channel is provably dead so the
    caller can mark the device DEGRADED via
    :func:`services.connection_state.mark_degraded`, which fires the
    existing :meth:`DvtLocationService._reconnect` ladder. Returns
    ``True`` on success **and** on any "can't safely probe" case (no
    connection record yet, iOS < 17 legacy service, unknown probe
    failure) so we never false-positive into a flapping device pill.

    The actual channel check is :meth:`LocationService.probe_channel_alive`
    — public API, so this module never touches the service's privates.
    """
    try:
        dm = ctx.app_state.device_manager
        conn = dm.get_connection(udid)
    except Exception:
        return True
    if conn is None or getattr(conn, "location_service", None) is None:
        return True
    try:
        alive = bool(await conn.location_service.probe_channel_alive())
    except Exception:
        # A connection record whose location_service isn't a real
        # LocationService (older test stubs) or an unexpected probe
        # error — log but don't downgrade the device.
        logger.debug("WS connect DVT probe for %s raised", udid, exc_info=True)
        return True
    if not alive:
        logger.info(
            "WS connect DVT probe for %s failed; marking degraded", udid,
        )
    return alive


async def probe_transport_alive_one(
    udid: str, conn_type: str, via_tunnel: bool = True,
) -> bool:
    """Transport-level liveness check for *udid*.

    Returns ``False`` only when the underlying transport is provably
    dead. Closes the gap before usbmux_presence_watchdog (~3s) and
    tunnel_liveness_loop (~15s) catch a freshly-dropped device. Without
    this, a renderer reload inside that window leaves the snapshot
    painting a phantom "connected" pill — the cached DVT instrument
    check is a no-op once :attr:`DvtLocationService._location_sim` is
    populated, so it can't catch this on its own.

    Network via the in-process tunnel (*via_tunnel*): the WiFi tunnel
    must (a) be running, (b) have RSD info, (c) report
    :meth:`TunnelRunner.transport_alive` true. Any of those failing means
    pymobiledevice3 silently dropped the underlying read tasks and the
    data path is dead.

    Network over usbmux (Finder's Wi-Fi sync, no in-process tunnel): the
    device must still be listed by usbmux, same as USB.

    USB: the device must appear in :func:`pymobiledevice3.usbmux.list_devices`.
    Failure to reach usbmuxd at all falls back to "alive" so a usbmux
    blip never disconnects every USB device on a WS reconnect.
    """
    if conn_type == "Network" and via_tunnel:
        from services.wifi_tunnel_service import tunnel
        if not tunnel.is_running() or tunnel.info is None:
            return False
        if hasattr(tunnel, "transport_alive") and not tunnel.transport_alive():
            return False
        return True
    if conn_type in ("USB", "Network"):
        try:
            from pymobiledevice3.usbmux import list_devices
            raw = await asyncio.wait_for(list_devices(), timeout=2.0)
        except Exception:
            return True
        present = {
            getattr(r, "serial", None) for r in raw
            if getattr(r, "connection_type", "USB") == conn_type
        }
        return udid in present
    return True


async def probe_connected_devices(udids: list[str]) -> None:
    """Probe each UDID's transport + DVT channel and reconcile
    :mod:`services.connection_state` with the truth.

    Runs as a background task (see :func:`schedule_probes`) concurrently
    with the WS handshake so the renderer never waits for I/O on
    connect. Two layers, in order:

      1. **Transport** — TCP / usbmux round-trip. Provably-dead transport
         routes through :func:`connection_state.disconnect_device` so the
         SSoT broadcasts ``device_disconnected`` immediately instead of
         waiting for the watchdog cadence.
      2. **DVT channel** — the existing :func:`probe_dvt_health_one`.
         Failure here is the "transport alive but DVT channel dropped"
         case (brief screen-lock, instrument idle-close); we mark
         DEGRADED so :meth:`DvtLocationService._reconnect` picks it up
         on the next teleport.
    """
    from services import connection_state
    from services.location_service import DeviceLostCause

    app_state = ctx.app_state
    dm = getattr(app_state, "device_manager", None)

    for udid in udids:
        try:
            # Resolve connection_type defensively. Real DeviceManager
            # returns "USB" / "Network"; test stubs that pre-date this
            # path return a MagicMock — ``isinstance`` filters those out
            # so we skip transport probing and fall through to DVT-only.
            conn_type: str | None = None
            via_tunnel = True
            if dm is not None:
                try:
                    raw_type = dm.get_connection_type(udid)
                except Exception:
                    raw_type = None
                if isinstance(raw_type, str) and raw_type in ("USB", "Network"):
                    conn_type = raw_type
                try:
                    raw_via = dm.is_via_wifi_tunnel(udid)
                except Exception:
                    raw_via = None
                if isinstance(raw_via, bool):
                    via_tunnel = raw_via

            if conn_type is not None and not await probe_transport_alive_one(
                udid, conn_type, via_tunnel,
            ):
                logger.info(
                    "WS connect transport probe: %s (%s) reports dead — "
                    "disconnecting",
                    udid, conn_type,
                )
                # Engine teardown before transport teardown, mirroring
                # cleanup_wifi_connections + usbmux_presence_watchdog.
                terminate = getattr(app_state, "terminate_engine", None)
                if terminate is not None:
                    try:
                        await terminate(udid)
                    except Exception:
                        logger.exception(
                            "WS connect probe: terminate_engine for %s failed",
                            udid,
                        )
                cause = (
                    DeviceLostCause.WIFI_DROPPED.value
                    if conn_type == "Network"
                    else DeviceLostCause.USB_REMOVED.value
                )
                await connection_state.disconnect_device(dm, udid, cause=cause)
                continue

            if not await probe_dvt_health_one(udid):
                await connection_state.mark_degraded(
                    udid, cause="dvt_probe_on_connect",
                )
        except Exception:
            logger.exception(
                "WS connect probe task raised for %s", udid,
            )


def schedule_probes(udids: list[str]) -> None:
    """Kick off a debounced background health probe for *udids*.

    Fire-and-forget: filters out UDIDs probed within
    :data:`PROBE_DEBOUNCE_S` and spawns a single
    :func:`probe_connected_devices` task for the rest. Skipped entirely
    when no DeviceManager is wired up (test stubs) so snapshot-only
    callers stay deterministic.
    """
    if getattr(ctx.app_state, "device_manager", None) is None:
        return
    now = time.monotonic()
    targets: list[str] = []
    for udid in udids:
        last = _last_probe_at.get(udid)
        if last is not None and now - last < PROBE_DEBOUNCE_S:
            continue
        _last_probe_at[udid] = now
        targets.append(udid)
    if not targets:
        return
    task = asyncio.create_task(probe_connected_devices(targets))
    _probe_tasks.add(task)
    task.add_done_callback(_probe_tasks.discard)


# ─── Test helpers ────────────────────────────────────────────────────

def reset_for_tests() -> None:
    """Clear the probe debounce map so repeated tests against the same
    UDID don't poison each other."""
    _last_probe_at.clear()


async def drain_probe_tasks_for_tests() -> None:
    """Await every in-flight probe task so a test can deterministically
    assert on the side effects (mark_degraded etc.) instead of racing
    with asyncio.run cleanup."""
    while _probe_tasks:
        await asyncio.gather(*list(_probe_tasks), return_exceptions=True)
