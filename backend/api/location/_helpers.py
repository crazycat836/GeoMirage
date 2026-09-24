"""Shared helpers for the /api/location/* routers — HTTP translation only.

The connection-lifecycle policy (lazy engine rebuild, hard reset,
retry-once-after-full-reconnect) lives in :mod:`services.engine_recovery`;
this module translates its domain errors into HTTP responses
(``NoDeviceError`` → 400 ``no_device``, ``DeviceLostError`` → 503
``device_lost`` with cleanup + broadcast) and hosts the background-task
spawner that survives asyncio's weak-ref GC. These primitives are shared
by every sub-router (modes, lifecycle, cooldown, settings, info) so they
live in one place.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Awaitable, Callable

from fastapi import HTTPException

from api._deps import get_app_state
from api._errors import ErrorCode, http_err
from services import connection_state, engine_recovery
from services.engine_recovery import NoDeviceError
from services.ws_broadcaster import broadcast
from services.location_service import (
    DeviceLostCause,
    DeviceLostError,
    unwrap_device_lost,
)

logger = logging.getLogger("geomirage")

# Thin re-exports — the recovery ladder moved to services.engine_recovery;
# these aliases keep historical import/patch sites working.
_resolve_target_udid = engine_recovery.resolve_target_udid
_get_or_rebuild_engine = engine_recovery.get_or_rebuild_engine
_force_reconnect = engine_recovery.force_reconnect


async def get_engine(udid: str | None = None):
    """Return the active SimulationEngine for *udid* (or the primary one if
    unspecified), lazily rebuilding when the slot is empty. Translates the
    service-level :class:`NoDeviceError` into ``400 no_device``."""
    try:
        return await engine_recovery.acquire_engine(get_app_state(), udid)
    except NoDeviceError as exc:
        raise http_err(400, ErrorCode.NO_DEVICE, str(exc))


# Default user-facing message per cause. Frontend i18n keys off the
# `cause` field for localized copy; this English fallback ships with the
# raw HTTP response so curl / API clients still see something useful.
_DEVICE_LOST_MESSAGE: dict[DeviceLostCause, str] = {
    DeviceLostCause.UNKNOWN: "Device connection lost; please reconnect and try again",
    DeviceLostCause.USB_REMOVED: "USB cable disconnected; please reconnect USB",
    DeviceLostCause.WIFI_DROPPED: "WiFi tunnel lost; check that the iPhone is on the same WiFi network and try again",
    DeviceLostCause.PHONE_LOCKED: "iPhone is locked; unlock the device and try again",
    DeviceLostCause.DDI_NOT_MOUNTED: "Developer Disk Image is not mounted; reconnect the device or restart GeoMirage",
}


def _lost_udids(app_state, exc: DeviceLostError, udid: str | None) -> list[str]:
    """Pick the device(s) a DeviceLostError refers to.

    Order: the udid the raiser stamped on the error → the caller's
    target udid → the primary engine's udid (the engine a udid-less
    request runs on). Only when none of those is known does the cleanup
    fall back to every connected device, which is also what a single
    connected device resolves to anyway.
    """
    target = exc.udid or udid
    if target is None:
        primary = app_state.simulation_engine
        if primary is not None:
            target = next(
                (u for u, e in app_state.simulation_engines.items() if e is primary),
                None,
            )
    if target is not None:
        return [target]
    return list(app_state.device_manager.connected_udids)


async def handle_device_lost(
    exc: DeviceLostError, udid: str | None = None,
) -> HTTPException:
    """Tear down the lost device (engine first, then transport), broadcast
    ``device_disconnected`` (with cause), and return a 503 ready to
    raise. Only the device the error refers to is torn down — see
    :func:`_lost_udids` — so the other phone in dual mode keeps running.
    All callers either catch ``DeviceLostError`` directly or extract a
    nested one via ``unwrap_device_lost`` before calling.
    """
    cause = exc.cause
    app_state = get_app_state()
    for lost in _lost_udids(app_state, exc, udid):
        # terminate_engine → disconnect_device → DISCONNECTED transition,
        # which broadcasts device_disconnected through the dedup'd WS
        # observer. ``cause`` is the DeviceLostCause string
        # ("usb_removed", "wifi_dropped", …) so the renderer can
        # localize the toast.
        await connection_state.teardown_device(app_state, lost, cause=cause.value)

    return http_err(
        503, ErrorCode.DEVICE_LOST,
        _DEVICE_LOST_MESSAGE.get(cause, _DEVICE_LOST_MESSAGE[DeviceLostCause.UNKNOWN]),
        cause=cause.value,
    )


async def guard(coro: Awaitable[Any], udid: str | None = None) -> Any:
    """Run an awaitable and translate DeviceLostError into the same
    broadcast + HTTP 503 flow `teleport` uses. Use on any route whose
    engine call can touch the device (location_service.set/clear),
    i.e. stop/restore/pause/resume/joystick/apply-speed. *udid* is the
    request's target device (None = primary)."""
    try:
        return await coro
    except HTTPException:
        raise
    except DeviceLostError as exc:
        raise (await handle_device_lost(exc, udid))
    except Exception as exc:
        nested = unwrap_device_lost(exc)
        if nested is not None:
            raise (await handle_device_lost(nested, udid))
        raise


async def exec_with_retry(
    udid_arg: str | None,
    engine,
    label: str,
    op: Callable[[Any], Awaitable[Any]],
) -> Any:
    """Run ``op(engine)`` with the retry-once-after-full-reconnect policy
    from :func:`services.engine_recovery.exec_with_retry`; a final
    DeviceLostError funnels into :func:`handle_device_lost` (cleanup +
    broadcast + 503) via :func:`guard`."""
    return await guard(
        engine_recovery.exec_with_retry(get_app_state(), udid_arg, engine, label, op),
        udid_arg,
    )


# Module-level background task set to keep strong references to fire-and-forget
# tasks. Without this, asyncio only keeps weak refs and Python can GC a task
# mid-execution (documented asyncio footgun). Tasks self-remove on completion.
_bg_tasks: set[asyncio.Task] = set()


def _track(task: asyncio.Task) -> None:
    """Keep a strong ref to a follow-up task until it completes."""
    _bg_tasks.add(task)
    task.add_done_callback(_bg_tasks.discard)


async def _broadcast_task_crash(
    label: str | None, udid: str | None, exc: BaseException
) -> None:
    """Tell the renderer a movement task died mid-run.

    Reuses the existing ``device_error`` WS event (already consumed by
    the frontend's device dispatcher → toast) with a ``simulation:<mode>``
    stage instead of introducing a new contract event. Without this the
    UI only sees the engine's bare ``state_change: idle`` and the crash
    is silent.
    """
    payload = {
        "udid": udid or "",
        "stage": f"simulation:{label or 'movement'}",
        "error": str(exc),
    }
    # Coded aborts (e.g. RouteUnavailableError.code) let the frontend pick
    # a specific toast — with the failing-leg detail — instead of the
    # generic simulation-crashed copy. Any exception exposing ``code``
    # flows through without this helper learning about it.
    code = getattr(exc, "code", None)
    if code:
        payload["code"] = code
    try:
        await broadcast("device_error", payload)
    except Exception:
        logger.exception("simulation-crash broadcast failed (mode=%s)", label)


def spawn(
    coro: Awaitable[Any],
    *,
    label: str | None = None,
    udid: str | None = None,
) -> asyncio.Task:
    """Fire-and-forget *coro* with crash reporting.

    ``label`` / ``udid`` identify the movement mode + device so a
    non-DeviceLost crash can be surfaced to the UI via ``device_error``
    (see :func:`_broadcast_task_crash`) instead of dying silently in
    the log file.
    """
    task = asyncio.create_task(coro)
    _bg_tasks.add(task)

    def _on_done(t: asyncio.Task) -> None:
        _bg_tasks.discard(t)
        if t.cancelled():
            return
        exc = t.exception()
        if exc is None:
            return
        # DeviceLostError is often re-raised wrapped — trigger the same
        # cleanup teleport already does so the frontend gets
        # device_disconnected instead of a silently-dead engine.
        nested = unwrap_device_lost(exc)
        if nested is not None:
            _track(asyncio.create_task(handle_device_lost(nested, udid)))
            return
        logger.exception("background task crashed: %s", exc, exc_info=exc)
        _track(asyncio.create_task(_broadcast_task_crash(label, udid, exc)))

    task.add_done_callback(_on_done)
    return task
