"""Engine recovery orchestration — connection-lifecycle policy.

Owns the lazy engine rebuild ladder shared by every /api/location/*
route: resolve a target UDID (polling discovery for a freshly-plugged
phone), attempt a lightweight rebuild on the existing transport, fall
back to a hard reset (disconnect → reconnect → rebuild), and retry a
device-touching operation exactly once after a full reconnect.

This module is pure policy: it raises domain errors (:class:`NoDeviceError`,
:class:`~services.location_service.DeviceLostError`) and never touches
HTTP. The translation to status codes / error envelopes lives in
``api/location/_helpers.py``.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Awaitable, Callable

from config import MAX_DEVICES
from services import connection_state
from services.location_service import DeviceLostError, unwrap_device_lost

logger = logging.getLogger("geomirage")

# Number of times to poll discover_devices when no UDID is known yet —
# covers the brief window after `usbmuxd` learns a freshly-plugged iPhone.
_DISCOVER_RETRY_ATTEMPTS = 10
_DISCOVER_RETRY_DELAY_S = 1.0

NO_DEVICE_MESSAGE = "No iOS device connected; connect via USB first"
ENGINE_UNRECOVERABLE_MESSAGE = (
    "Device connection invalid; try re-plugging USB or restarting "
    "GeoMirage (see ~/.geomirage/logs/backend.log)"
)


class NoDeviceError(RuntimeError):
    """No reachable device / engine could not be recovered.

    Raised instead of an HTTP error so this module stays below the API
    layer; ``api/location/_helpers.py`` maps it to ``400 no_device``
    using ``str(exc)`` as the user-facing message.
    """


async def resolve_target_udid(app_state, dm, requested_udid: str | None) -> str:
    """Pick the UDID to operate on, polling discover_devices if needed.

    Preference order: explicit *requested_udid* → first already-connected
    device → first discovered device (with retries). Raises
    :class:`NoDeviceError` when nothing is reachable.
    """
    connected = dm.connected_udids
    target_udid = requested_udid or (connected[0] if connected else None)
    if target_udid is not None:
        return target_udid

    for attempt in range(_DISCOVER_RETRY_ATTEMPTS):
        try:
            discovered = await dm.discover_devices()
            if discovered:
                if attempt > 0:
                    logger.info("discover_devices returned device on attempt %d", attempt + 1)
                return discovered[0].udid
        except Exception:
            logger.exception("discover_devices failed during lazy rebuild (attempt %d)", attempt + 1)
        await asyncio.sleep(_DISCOVER_RETRY_DELAY_S)

    raise NoDeviceError(NO_DEVICE_MESSAGE)


async def get_or_rebuild_engine(app_state, target_udid: str):
    """First-attempt rebuild on top of an *existing* device connection.

    When the udid is only discovered (not yet in `connected_udids`),
    `create_engine_for_device` would raise "Device not connected" — log
    noise without value. Skip directly to the hard-reset path in that
    case. Otherwise attempt the lightweight rebuild and let the caller
    fall through to hard reset on failure.
    """
    if target_udid not in app_state.device_manager.connected_udids:
        logger.info(
            "simulation_engine missing for %s and device not connected; "
            "skipping attempt 1, going straight to hard reset",
            target_udid,
        )
        return None

    logger.info("simulation_engine missing; attempt 1 (rebuild) for %s", target_udid)
    try:
        await app_state.create_engine_for_device(target_udid)
        # Pin to the engine for *this* udid, not the legacy primary accessor.
        # In dual-device mode the primary may be a different device, so
        # returning app_state.simulation_engine here could hand back the
        # wrong phone's engine and inject GPS into the wrong device.
        rebuilt = app_state.get_engine(target_udid) or app_state.simulation_engine
        if rebuilt is not None:
            logger.info("Engine rebuild succeeded on attempt 1")
            return rebuilt
    except Exception:
        logger.exception("Engine rebuild (attempt 1) failed for %s", target_udid)
    return None


async def force_reconnect(app_state, dm, target_udid: str):
    """Hard reset: tear down → reconnect → rebuild. Last-resort recovery
    for the iOS 17+ "RSD tunnel alive but DVT channel stale" case.

    Returns the rebuilt engine on success or None if reconnect/rebuild fails.

    Reconnects over the transport the device used: a device on the
    in-process WiFi tunnel reconnects through that tunnel's RSD (usbmux
    doesn't list it); everything else goes through usbmux. Teardown
    stops the engine before closing the transport.

    Routes the transport calls through :mod:`services.connection_state`
    so the renderer receives ``device_disconnected`` then
    ``device_connected`` exactly once (via the installed WS observer).
    Without these emits the underlying lockdown is rebuilt fresh but
    the chip stays at "重連中" because nothing tells the dispatcher the
    tunnel recovered.
    """
    logger.info("attempt 2 (hard reset) for %s", target_udid)
    try:
        if dm.is_via_wifi_tunnel(target_udid):
            if not await _reconnect_over_tunnel(app_state, dm, target_udid):
                return None
        else:
            if (
                target_udid not in dm.connected_udids
                and dm.connected_count >= MAX_DEVICES
            ):
                logger.warning(
                    "hard reset for %s skipped: already %d devices connected",
                    target_udid, dm.connected_count,
                )
                return None
            await connection_state.teardown_device(
                app_state, target_udid, cause="hard_reset",
            )
            await connection_state.connect_device(dm, target_udid, cause="hard_reset")
        await app_state.create_engine_for_device(target_udid)
        # Pin to target_udid's engine — the legacy primary accessor would
        # return the wrong device's engine in dual-device mode (see
        # get_or_rebuild_engine + exec_with_retry for the same fix).
        rebuilt = app_state.get_engine(target_udid) or app_state.simulation_engine
        if rebuilt is not None:
            logger.info("Engine rebuild succeeded on attempt 2")
            return rebuilt
    except Exception:
        logger.exception("Engine rebuild (attempt 2, hard reset) failed for %s", target_udid)
    return None


async def _reconnect_over_tunnel(app_state, dm, target_udid: str) -> bool:
    """Hard-reset transport step for a device on the WiFi tunnel.

    Leaves the connection untouched and returns False when the tunnel is
    gone: usbmux can't reach the device either, and the tunnel liveness
    loop owns that teardown.
    """
    from services.wifi_tunnel_service import live_tunnel_rsd

    rsd = live_tunnel_rsd()
    if rsd is None:
        logger.warning(
            "hard reset for %s skipped: WiFi tunnel is not alive", target_udid,
        )
        return False
    await connection_state.teardown_device(app_state, target_udid, cause="hard_reset")
    info = await dm.connect_wifi_tunnel(*rsd)
    if info.udid != target_udid:
        logger.warning(
            "hard reset: tunnel reached %s, not %s; dropping it",
            info.udid, target_udid,
        )
        await dm.disconnect(info.udid)
        return False
    await connection_state.announce_connected(
        target_udid,
        name=info.name,
        ios_version=info.ios_version,
        connection_type="Network",
        cause="hard_reset",
    )
    return True


async def acquire_engine(app_state, udid: str | None = None):
    """Return the active SimulationEngine for *udid* (or the primary one if
    unspecified), lazily rebuilding when the slot is empty.

    Raises :class:`NoDeviceError` when no device is reachable or every
    rebuild attempt fails.
    """
    if udid is not None:
        eng = app_state.get_engine(udid)
        if eng is not None:
            return eng
    if udid is None and app_state.simulation_engine is not None:
        return app_state.simulation_engine

    dm = app_state.device_manager
    target_udid = await resolve_target_udid(app_state, dm, udid)

    engine = await get_or_rebuild_engine(app_state, target_udid)
    if engine is not None:
        return engine
    engine = await force_reconnect(app_state, dm, target_udid)
    if engine is not None:
        return engine

    raise NoDeviceError(ENGINE_UNRECOVERABLE_MESSAGE)


async def exec_with_retry(
    app_state,
    udid_arg: str | None,
    engine,
    label: str,
    op: Callable[[Any], Awaitable[Any]],
) -> Any:
    """Run ``op(engine)``. On DeviceLostError (or a wrapped one), do one
    full force-reconnect cycle and retry the op exactly once. A final
    failure raises the (unwrapped) :class:`DeviceLostError` so the API
    layer can run its broadcast + 503 flow. Gives the device one more
    chance after a transient blip (screen-lock, WiFi roam) before
    surfacing a user-visible error. *udid_arg* (None = primary) is
    re-resolved on retry so the rebuilt engine is picked up correctly in
    dual-device mode.
    """
    try:
        return await op(engine)
    except DeviceLostError as exc:
        first_lost = exc
    except Exception as exc:
        nested = unwrap_device_lost(exc)
        if nested is None:
            raise
        first_lost = nested

    dm = app_state.device_manager
    try:
        target_udid = await resolve_target_udid(app_state, dm, udid_arg)
    except NoDeviceError:
        # No device left to reconnect to — original DeviceLost is the truth.
        raise first_lost
    # Name the device on the error so the API layer's cleanup tears down
    # this one only, not every connected phone.
    if first_lost.udid is None:
        first_lost.udid = target_udid

    logger.warning(
        "%s failed (DeviceLost: %s); retrying once after full reconnect",
        label, first_lost,
    )
    rebuilt = await force_reconnect(app_state, dm, target_udid)
    if rebuilt is None:
        raise first_lost

    # force_reconnect returns the legacy primary accessor; in dual mode
    # the primary may not be target_udid's engine. Pin to the udid we
    # just rebuilt explicitly.
    target_engine = app_state.get_engine(target_udid) or rebuilt
    try:
        return await op(target_engine)
    except DeviceLostError as exc:
        logger.warning("%s retry after full reconnect also failed", label)
        if exc.udid is None:
            exc.udid = target_udid
        raise
    except Exception as exc:
        nested = unwrap_device_lost(exc)
        if nested is not None:
            if nested.udid is None:
                nested.udid = target_udid
            raise nested
        raise
