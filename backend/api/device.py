from __future__ import annotations

import logging

from fastapi import APIRouter
from pymobiledevice3.exceptions import DeviceNotFoundError, PairingError

from api._deps import get_app_state, get_device_manager
from api._errors import ErrorCode, http_err, ios_unsupported_error, max_devices_error
from services import connection_state
from config import MAX_DEVICES
from core import device_forget
from core.device_forget import ForgetFailedError
from core.device_manager import (
    UnsupportedIosVersionError,
    parse_ios_version,
)
from models.schemas import DeviceInfo

router = APIRouter(prefix="/api/device", tags=["device"])

logger = logging.getLogger(__name__)


@router.get("/list", response_model=list[DeviceInfo])
async def list_devices():
    """Return every device the renderer should show on the device chip rail.

    Composed from two sources because neither alone is complete:

      1. ``dm.discover_devices()`` — usbmux's view, which sees plugged-in
         USB devices (connected or not) and lets the renderer offer a
         Connect button on a freshly trusted phone.
      2. ``connection_state.store`` — the unified SSoT for transport state.
         Picks up WiFi-tunnel connections that usbmux never enumerates,
         so a renderer reload mid-tunnel session doesn't see "no device"
         and clobber the WS ``device_snapshot`` that just told the truth.

    Anything live in the store but missing from usbmux is appended with
    metadata replayed from the store's cache (the same payload the WS
    ``device_connected`` event originally carried).
    """
    dm = get_device_manager()
    discovered = await dm.discover_devices()
    discovered_udids = {d.udid for d in discovered}

    snapshot = connection_state.store.snapshot()
    extras: list[DeviceInfo] = []
    for udid, state in snapshot.items():
        if udid in discovered_udids:
            continue
        # CONNECTED + DEGRADED both mean "this device is live"; DISCONNECTED
        # entries in the store have already been broadcast as gone and
        # would just confuse the UI if surfaced here.
        if state.value not in ("connected", "degraded"):
            continue
        md = connection_state.store.metadata_for(udid)
        extras.append(DeviceInfo(
            udid=udid,
            name=md.get("name", ""),
            ios_version=md.get("ios_version", ""),
            connection_type=md.get("connection_type", "USB"),
            is_connected=True,
        ))
    return discovered + extras


# ── Generic UDID routes (MUST be defined after all specific /wifi/* routes
#    so that /wifi/* paths do not accidentally match {udid}). ─────────────

@router.post("/{udid}/connect")
async def connect_device(udid: str):
    app_state = get_app_state()
    dm = get_device_manager()
    # Max MAX_DEVICES devices (group mode). Allow re-connect of an already-connected udid.
    if not dm.is_connected(udid) and dm.connected_count >= MAX_DEVICES:
        raise max_devices_error()
    # Already connected with a live engine: nothing to do. Rebuilding the
    # engine would stop it and abort whatever run is in progress.
    if dm.is_connected(udid) and app_state.simulation_engines.get(udid) is not None:
        return {"status": "already_connected", "udid": udid}
    try:
        # `connect_device` runs ``dm.connect`` and broadcasts
        # ``device_connected`` via the installed WS observer. The engine
        # rebuild stays here since it's not part of the transport state
        # machine — but it goes through the rollback wrapper so an engine
        # failure never leaves the store advertising a connected device
        # with no engine behind it.
        await connection_state.connect_device(dm, udid, cause="user")
        await connection_state.create_engine_with_rollback(
            dm, app_state, udid,
            cause="engine_create_failed",
            stage="connect",
            error="Simulation engine creation failed",
        )
        return {"status": "connected", "udid": udid}
    except UnsupportedIosVersionError as e:
        raise ios_unsupported_error(e.version)
    except PairingError:
        # Includes PasswordRequiredError (locked) and a declined / pending
        # Trust prompt. dm.connect already logged it without a traceback.
        raise http_err(
            409, ErrorCode.PAIRING_REQUIRED,
            "Unlock the iPhone and tap \"Trust This Computer\", then connect again",
        )
    except DeviceNotFoundError:
        raise http_err(404, ErrorCode.NO_DEVICE, "Device is no longer attached")
    except Exception:
        logger.exception("Device connect failed", extra={"udid": udid})
        raise http_err(500, ErrorCode.CONNECT_FAILED, "Device connection failed; please retry")


@router.delete("/{udid}/connect")
async def disconnect_device(udid: str):
    app_state = get_app_state()
    dm = get_device_manager()
    # Terminate the simulation engine *before* the transport goes away so
    # any running Navigate/Loop/MultiStop/RandomWalk task exits cleanly.
    await app_state.terminate_engine(udid)
    # `disconnect_device` runs ``dm.disconnect`` and broadcasts
    # ``device_disconnected`` (via dedup) through the installed WS observer.
    await connection_state.disconnect_device(dm, udid, cause="user")
    return {"status": "disconnected", "udid": udid}


@router.delete("/{udid}/pair")
async def forget_device(udid: str):
    """Forget a paired device — disconnects it (if connected), tells the
    device to drop our pair record, and removes the local cached record.

    After this, the iPhone/iPad shows "Trust This Computer" again the next
    time it connects. The full flow (device-side ``unpair()``, usbmuxd
    ``DeletePairRecord``, best-effort local file sweep, three-way success
    aggregation) lives in :mod:`core.device_forget`; this route only
    translates the result into the HTTP response / ``forget_failed`` error.
    """
    try:
        result = await device_forget.forget_device(get_app_state(), get_device_manager(), udid)
    except ForgetFailedError:
        raise http_err(
            500,
            ErrorCode.FORGET_FAILED,
            "Could not forget the device. Connect it via USB and unlock it, "
            "then retry.",
        )
    return {
        "status": result.status,
        "udid": udid,
        "device_unpaired": result.device_unpaired,
        "usbmux_record_deleted": result.usbmux_record_deleted,
        "removed": result.removed,
        "failed": result.failed,
    }


@router.post("/{udid}/ddi/retry")
async def retry_ddi_mount(udid: str):
    """Mount the Developer Disk Image again after a failure (download
    timed out, phone was locked, Developer Mode just turned on).

    Rebuilds the location service and engine on the existing connection,
    which re-runs the mount. The outcome reaches the UI the same way as on
    connect: ``ddi_mounting`` → ``ddi_mounted`` or ``ddi_mount_missing``.
    """
    app_state = get_app_state()
    dm = get_device_manager()
    if not dm.is_connected(udid):
        raise http_err(404, ErrorCode.DEVICE_NOT_CONNECTED, "Device is not currently connected")
    # Engine first: it holds the location service we're about to close.
    await app_state.terminate_engine(udid)
    await dm.reset_location_service(udid)
    try:
        # Same rollback wrapper as connect: a failed rebuild must not leave
        # the store advertising a connected device with no engine behind it.
        await connection_state.create_engine_with_rollback(
            dm, app_state, udid,
            cause="engine_create_failed",
            stage="ddi_retry",
            error="Simulation engine creation failed",
        )
    except Exception:
        logger.exception("DDI retry failed to rebuild the engine", extra={"udid": udid})
        raise http_err(500, ErrorCode.CONNECT_FAILED, "Device connection failed; please retry")
    return {"status": "retried", "udid": udid}


# ── AMFI: "Reveal Developer Mode in Settings" (iOS 16+) ─────────────
#
# Same end state as sideloading a dev-signed IPA via Sideloadly / Xcode,
# but done directly through AMFI. Action 0 of the
# `com.apple.amfi.lockdown` service creates the `AMFIShowOverridePath`
# marker file on the device — no reboot, no passcode prompt, no
# sideload round-trip. Saves new users the "why doesn't the Developer
# Mode toggle appear" question entirely.
@router.post("/{udid}/amfi/reveal-developer-mode")
async def amfi_reveal_developer_mode(udid: str):
    dm = get_device_manager()
    # AMFI reads several fields off the live Connection (ios_version,
    # connection_type) via the public ConnectionInfo accessor.
    conn = dm.get_connection(udid)
    if conn is None:
        raise http_err(404, ErrorCode.DEVICE_NOT_CONNECTED, "Device is not currently connected")

    # iOS 15 and below have no Developer Mode concept, so the AMFI
    # service call would fail with a misleading error.
    ios_major = parse_ios_version(conn.ios_version or "0")[0]
    if ios_major < 16:
        raise http_err(
            400, ErrorCode.IOS_VERSION_UNSUPPORTED,
            "iOS 16 or newer is required to use Developer Mode",
            ios_version=conn.ios_version,
        )

    # WiFi tunnels don't route the AMFI lockdown service (it's a USB-only
    # advertised port). Reject up-front instead of letting the service
    # open fail deep inside pymobiledevice3.
    if (conn.connection_type or "").lower() != "usb":
        raise http_err(
            400, ErrorCode.USB_REQUIRED,
            "AMFI requires a USB connection (WiFi tunnel does not forward this service)",
        )

    try:
        from pymobiledevice3.services.amfi import AmfiService
    except ImportError:
        logger.exception("pymobiledevice3 AMFI module import failed", extra={"udid": udid})
        raise http_err(500, ErrorCode.AMFI_UNAVAILABLE, "pymobiledevice3 AMFI service failed to load")

    # On iOS 17+ ``conn.lockdown`` is the RSD; the AMFI lockdown service
    # is only reachable through the usbmux lockdown kept alongside it.
    try:
        await AmfiService(conn.usbmux_lockdown or conn.lockdown).reveal_developer_mode_option_in_ui()
    except Exception:
        logger.exception("AMFI reveal failed for %s", udid)
        raise http_err(500, ErrorCode.AMFI_REVEAL_FAILED, "AMFI operation failed; ensure the device is unlocked and trusts this computer")

    # Invalidate the cached status so the next discover pays a fresh
    # lockdown query and the frontend sees the toggle flip.
    conn.developer_mode_enabled = None
    return {"status": "ok", "udid": udid}
