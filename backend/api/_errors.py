"""Shared HTTP error helpers for API routers.

Centralises the `{code, message}` detail envelope used across every API so
internal exception text never leaks onto the wire. Raise the result of
``http_err(...)`` instead of ``HTTPException(detail=str(e))``.

Every code emitted by the backend lives in :class:`ErrorCode` so the
frontend i18n table (``frontend/src/i18n/strings.ts`` -> ``err.<code>``)
has a single registry to mirror. Adding a new code is one line here +
one entry in the i18n table; the type checker rejects literal strings
in ``http_err`` calls so the mirror cannot drift silently again.
"""

from enum import StrEnum

from fastapi import HTTPException

from config import MAX_DEVICES
from core.device_manager import UnsupportedIosVersionError


class ErrorCode(StrEnum):
    """Stable identifiers for every HTTP error the backend emits.

    Values are the literal strings the wire / frontend already keys on,
    so this is purely an additive registry: switching a call site from
    ``"foo"`` to ``ErrorCode.FOO`` does not change the response body.
    """

    # Validation / auth — set by api/_envelope.py before reaching a router
    VALIDATION_FAILED = "validation_failed"
    UNAUTHORIZED = "unauthorized"
    INVALID_NAME = "invalid_name"
    INVALID_COORD = "invalid_coord"
    INVALID_LANG = "invalid_lang"

    # Bookmarks / places / tags / routes / devices — 404 / 400 surface
    BOOKMARK_NOT_FOUND = "bookmark_not_found"
    PLACE_NOT_FOUND = "place_not_found"
    DEFAULT_PLACE_IMMUTABLE = "default_place_immutable"
    TAG_NOT_FOUND = "tag_not_found"
    ROUTE_NOT_FOUND = "route_not_found"
    ROUTE_NAME_CONFLICT = "route_name_conflict"
    ROUTE_CATEGORY_NOT_FOUND = "route_category_not_found"
    ROUTE_CATEGORY_IMMUTABLE = "route_category_immutable"
    DEVICE_NOT_FOUND = "device_not_found"

    # Connection / pairing / device lifecycle
    DEVICE_NOT_CONNECTED = "device_not_connected"
    DEVICE_LOST = "device_lost"
    NO_DEVICE = "no_device"
    CONNECT_FAILED = "connect_failed"
    TRUST_FAILED = "trust_failed"
    REMOTE_PAIR_FAILED = "remote_pair_failed"
    REPAIR_NEEDS_USB = "repair_needs_usb"
    USB_REQUIRED = "usb_required"
    USBMUX_UNAVAILABLE = "usbmux_unavailable"
    FORGET_FAILED = "forget_failed"
    MAX_DEVICES_REACHED = "max_devices_reached"

    # iOS version compatibility
    IOS_UNSUPPORTED = "ios_unsupported"
    IOS_VERSION_UNSUPPORTED = "ios_version_unsupported"

    # WiFi tunnel lifecycle
    TUNNEL_FAILED = "tunnel_failed"
    TUNNEL_NO_RSD = "tunnel_no_rsd"
    TUNNEL_SPAWN_FAILED = "tunnel_spawn_failed"
    TUNNEL_PAIR_REJECTED = "tunnel_pair_rejected"
    TUNNEL_TIMEOUT = "tunnel_timeout"
    SCAN_FAILED = "scan_failed"

    # Movement / location
    NO_POSITION = "no_position"
    NO_ACTIVE_ROUTE = "no_active_route"
    ROUTE_UNAVAILABLE = "route_unavailable"
    TELEPORT_FAILED = "teleport_failed"
    JOYSTICK_START_FAILED = "joystick_start_failed"
    COOLDOWN_ACTIVE = "cooldown_active"

    # GPX import
    GPX_TOO_LARGE = "gpx_too_large"
    GPX_DECODE_FAILED = "gpx_decode_failed"

    # AMFI / Developer Mode
    AMFI_UNAVAILABLE = "amfi_unavailable"
    AMFI_REVEAL_FAILED = "amfi_reveal_failed"

    # System / diagnostics
    OPEN_LOG_FAILED = "open_log_failed"
    SETTINGS_PERSIST_FAILED = "settings_persist_failed"
    STORE_PERSIST_FAILED = "store_persist_failed"

    # Catch-all — set by the Exception handler in api/_envelope.py when an
    # uncaught error would otherwise bypass the envelope entirely
    INTERNAL_ERROR = "internal_error"


def http_err(
    status: int,
    code: ErrorCode,
    message: str,
    **extra: object,
) -> HTTPException:
    """Build a structured HTTPException with `{code, message, ...extra}` detail.

    Use this instead of raising `HTTPException(detail=str(e))` so internal
    exception text never leaks to API clients. The ``code`` is a typed
    :class:`ErrorCode` member; passing a bare string is a type error.

    ``**extra`` is merged into the detail dict so callers can attach
    context the UI consumes (e.g. an existing route's id on a
    409 ``route_name_conflict``). Keys are deliberately not constrained
    here — every endpoint owns its own contract for what extras it ships.
    """
    detail: dict[str, object] = {"code": code.value, "message": message}
    detail.update(extra)
    return HTTPException(status_code=status, detail=detail)


def max_devices_error() -> HTTPException:
    """409 raised when the connected-device cap is exceeded.

    Used by every connect-style endpoint (USB connect, WiFi-tunnel
    connect, discover-then-connect) so the frontend keys i18n on a single
    code for all three.
    """
    return HTTPException(
        status_code=409,
        detail={
            "code": ErrorCode.MAX_DEVICES_REACHED.value,
            "message": f"Maximum {MAX_DEVICES} devices connected",
        },
    )


def ios_unsupported_error(version: str) -> HTTPException:
    """400 raised when a connect attempt sees an iOS version the engine
    can't drive (currently <17.0). The detail carries the observed
    version + minimum supported version so the frontend can render a
    targeted upgrade prompt instead of a generic failure toast.
    """
    return HTTPException(
        status_code=400,
        detail={
            "code": ErrorCode.IOS_UNSUPPORTED.value,
            "message": (
                f"Detected iOS {version}; GeoMirage v0.1.49+ requires "
                f"iOS {UnsupportedIosVersionError.MIN_VERSION} or newer. "
                f"Please update to iOS {UnsupportedIosVersionError.MIN_VERSION}+ before connecting."
            ),
            "ios_version": version,
            "min_version": UnsupportedIosVersionError.MIN_VERSION,
        },
    )
