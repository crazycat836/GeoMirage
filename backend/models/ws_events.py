"""Single source of truth for every WebSocket event the backend emits.

Each Pydantic class describes the ``data`` payload of one event type;
the ``WS_EVENTS`` registry at the bottom maps event name → model.

``tools/gen_ws_types.py`` walks ``WS_EVENTS`` and emits
``frontend/src/generated/api-contract.ts`` so the renderer's WS
dispatcher narrows on a generated discriminated union instead of its
current loose-string ``msg.type === '...'`` checks.

Adding a new event = one Pydantic class + one entry in ``WS_EVENTS``.
The codegen step in ``build.py`` re-runs on every build so the
frontend types can never drift from the backend reality.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError

logger = logging.getLogger(__name__)


# ── Connection / device lifecycle ────────────────────────────────


class DeviceConnectedEvent(BaseModel):
    """Emitted when usbmux watchdog auto-connects, manual /connect succeeds,
    or WiFi-tunnel connect attaches a device."""
    udid: str
    name: str = ""
    ios_version: str = ""
    connection_type: Literal["USB", "Network"] = "USB"


class DeviceDisconnectedEvent(BaseModel):
    """Emitted on user-initiated disconnect, forget, USB unplug, WiFi tunnel
    drop, or device-lost detection. ``udids`` lists every UDID this single
    event covers (multi-device drops happen on tunnel teardown)."""
    udid: str | None = None
    udids: list[str] = Field(default_factory=list)
    reason: str = ""
    cause: str | None = None  # DeviceLostCause.value when a lost-error mapped here
    error: str | None = None


class DeviceSnapshotEvent(BaseModel):
    """Authoritative ground truth pushed once on every WS reconnect so the
    renderer's device list re-syncs without waiting for the next REST poll."""
    devices: list[dict[str, Any]]


class DeviceErrorEvent(BaseModel):
    """Recoverable device-side error — e.g. USB fallback engine creation
    failed, AMFI service unavailable. Frontend surfaces as a toast.

    ``code`` is a stable machine-readable tag for errors that deserve a
    specific toast; currently only ``"route_unavailable"`` (route-planning
    abort). Absent for generic crashes."""
    udid: str
    stage: str
    error: str
    code: str | None = None


class DualSyncStartEvent(BaseModel):
    """A secondary device just connected and we're about to replay the
    primary's in-flight snapshot on it (group mode)."""
    udid: str
    primary_udid: str
    mode: str


# ── Tunnel lifecycle ─────────────────────────────────────────────


class TunnelLostEvent(BaseModel):
    """Tunnel asyncio task exited unexpectedly — frontend banners the
    "tunnel dropped, reconnect required" hint."""
    reason: str


class TunnelDegradedEvent(BaseModel):
    """Liveness probe couldn't reach the RSD endpoint — we haven't torn
    down yet, but the user should know the tunnel is wobbly.

    ``udid`` is optional: emitters that know which device owns the
    wobbling tunnel populate it (DvtLocationService._reconnect, per-
    device watchdog). Sources without a UDID (the global tunnel watchdog
    in api/tunnel_router) leave it None, and the renderer falls back
    to applying the hint to every known device — safe today since each
    device owns its own tunnel."""
    reason: str
    udid: str | None = None


class TunnelRecoveredEvent(BaseModel):
    """Liveness probe answered again after a degraded period — banner
    can clear. Same UDID-targeting semantics as :class:`TunnelDegradedEvent`."""
    udid: str | None = None


# ── DDI mount lifecycle ──────────────────────────────────────────


class DdiMountingEvent(BaseModel):
    """In-progress mount — surfaces a transient "mounting Developer Disk
    Image" hint. Frontend may suppress this if the mount completes fast.
    ``stage`` is ``downloading`` while the image is fetched from GitHub and
    ``mounting`` once it is on disk; a download is followed by a second
    frame for the mount."""
    udid: str
    stage: Literal["downloading", "mounting"] | None = None


class DdiMountedEvent(BaseModel):
    """Mount completed successfully."""
    udid: str


class DdiMountFailedEvent(BaseModel):
    """Legacy event name retained for downstream consumers; carries the
    same fields as ddi_mount_missing plus ``error``."""
    udid: str
    stage: str
    reason: str
    hint_key: str
    error: str


class DdiMountMissingEvent(BaseModel):
    """User-facing failure — drives the "DDI not mounted" hint toast.
    ``hint_key`` points at an i18n string the frontend should render."""
    udid: str
    stage: str
    reason: str
    hint_key: str


# ── Cooldown ─────────────────────────────────────────────────────


class CooldownUpdateEvent(BaseModel):
    """Mirrors the ``CooldownStatus`` REST shape so the renderer can swap
    REST responses and WS frames interchangeably. Fields are intentionally
    optional — the WS path may ship a partial when only one field changed."""
    enabled: bool | None = None
    is_active: bool | None = None
    remaining_seconds: float | None = None
    total_seconds: float | None = None
    distance_km: float | None = None


# ── Position / movement ──────────────────────────────────────────


class PositionUpdateEvent(BaseModel):
    """High-frequency (~10 Hz) position sample emitted during every
    movement mode. ``udid`` is auto-tagged by AppState.event_callback so
    the frontend can route per-device. ``progress`` is normalised to
    [0, 1] over the active route."""
    udid: str | None = None
    lat: float
    lng: float
    bearing: float | None = None
    speed_mps: float | None = None
    progress: float | None = None
    distance_remaining: float | None = None
    distance_traveled: float | None = None
    eta_seconds: float | None = None


class TeleportEvent(BaseModel):
    """One-shot location update — emitted when the user teleports without
    starting a movement loop."""
    udid: str | None = None
    lat: float
    lng: float


class WaypointProgressEvent(BaseModel):
    """Drives the waypoint highlight pulse in the dock route card.

    ``udid`` is injected by AppState.event_callback when the engine emits
    via ``_emit`` so the frontend can route per-device in group mode.
    """
    udid: str | None = None
    current_index: int
    next_index: int
    total: int


class StateChangeEvent(BaseModel):
    """Coarse state transition — frontend WS dispatcher routes these into
    the appropriate per-mode reducer (navigating / looping / multi_stop /
    random_walk / flower / paused / completed / errored).

    Mode-start transitions carry that mode's parameters at the top level:
    ``destination`` (navigate), ``waypoints`` (loop / multi-stop / flower),
    ``stop_duration`` + ``loop`` (multi-stop), ``center`` + ``radius_m``
    (random walk). A pause carries ``paused_from``."""
    state: str
    udid: str | None = None
    destination: dict[str, float] | None = None
    waypoints: list[dict[str, float]] | None = None
    stop_duration: float | None = None
    loop: bool | None = None
    center: dict[str, float] | None = None
    radius_m: float | None = None
    paused_from: str | None = None


class RoutePathEvent(BaseModel):
    """Resolved OSRM polyline pushed once per leg start so the map can
    pre-render the planned route instead of revealing it segment-by-
    segment as ``position_update`` events arrive."""
    udid: str | None = None
    coords: list[dict[str, float]]


PauseSource = Literal["loop", "multi_stop", "random_walk", "flower"]


class PauseCountdownEvent(BaseModel):
    """Inter-leg / inter-lap pause begins — countdown timer in the dock
    activates."""
    duration_seconds: float
    udid: str | None = None
    source: PauseSource | None = None


class PauseCountdownEndEvent(BaseModel):
    """Pause finished — countdown UI clears and movement resumes.

    Currently informational only; the frontend treats every pause
    sources identically.
    """
    udid: str | None = None
    source: PauseSource | None = None


class LapCompleteEvent(BaseModel):
    """One loop / multi-stop lap (or flower round) finished. Frontend increments the lap
    counter; the simulation continues until ``multi_stop_complete`` /
    ``state_change=idle`` arrives.

    ``total`` is the user-configured lap target (``None`` = unlimited /
    "loop forever" mode).
    """
    udid: str | None = None
    lap: int
    total: int | None = None


class StopReachedEvent(BaseModel):
    """Multi-stop: arrived at one waypoint inside the leg sequence (not
    the final stop). Frontend pulses the corresponding waypoint pin.

    ``index`` is the 1-based stop number; ``total`` is the count of all
    waypoints in the run; ``lat``/``lng`` mirror the reached coordinate
    so the renderer can highlight without a separate lookup.
    """
    udid: str | None = None
    index: int
    total: int
    lat: float
    lng: float


class MultiStopCompleteEvent(BaseModel):
    """All waypoints visited (and laps run, when looping). Frontend
    flips the dock back to idle.

    ``laps`` is how many full loops completed when looping was on (0 on
    a one-shot run).
    """
    udid: str | None = None
    laps: int


class NavigationCompleteEvent(BaseModel):
    """Navigate-to-destination arrived. Frontend clears the destination
    pin and the route polyline.

    ``destination`` mirrors the coordinate the run targeted so consumers
    that store the destination separately (e.g. a recent-destinations
    list) don't have to recover it from the active route.
    """
    udid: str | None = None
    destination: dict[str, float] | None = None


class RandomWalkArrivedEvent(BaseModel):
    """Reached one randomly-picked waypoint inside a random-walk loop.

    ``count`` is the 1-based arrival number this run; ``lat``/``lng``
    mirror the reached coordinate so the renderer can pin it without
    correlating with the previous ``position_update``.
    """
    udid: str | None = None
    count: int
    lat: float
    lng: float


class RandomWalkCompleteEvent(BaseModel):
    """Random-walk handler exited (user stopped or unrecoverable error).

    ``destinations_visited`` is the total arrival count for this run.
    """
    udid: str | None = None
    destinations_visited: int


class RestoredEvent(BaseModel):
    """User-initiated Restore finished — virtual location cleared, the
    iPhone is back on its real GPS."""
    udid: str | None = None


class ConnectionLostEvent(BaseModel):
    """Movement loop hit a connection-class push error; about to back off
    + retry. ``next_retry_seconds`` lets the dock show a countdown."""
    retry: int
    max_retries: int
    next_retry_seconds: float
    udid: str | None = None


class GoldDittoCycleEvent(BaseModel):
    """Phase update for a Gold Ditto (拉金盆) cycle. Two phases:

    - ``teleported`` — simulated location was just pushed to the anchor;
      ``lat`` and ``lng`` carry the anchor coordinate (Pikmin Bloom users
      see this as the moment the "swipe" registers).
    - ``restored`` — real GPS is back; the cycle is complete.

    Frontend surfaces this as a single transient toast spanning both
    phases ("Gold Ditto applied"); no in-flight UI state is required.
    """
    udid: str | None = None
    phase: Literal["teleported", "restored"]
    lat: float | None = None
    lng: float | None = None


# ── Registry ─────────────────────────────────────────────────────


WS_EVENTS: dict[str, type[BaseModel]] = {
    # Device lifecycle
    "device_connected": DeviceConnectedEvent,
    "device_disconnected": DeviceDisconnectedEvent,
    "device_snapshot": DeviceSnapshotEvent,
    "device_error": DeviceErrorEvent,
    "dual_sync_start": DualSyncStartEvent,
    # Tunnel
    "tunnel_lost": TunnelLostEvent,
    "tunnel_degraded": TunnelDegradedEvent,
    "tunnel_recovered": TunnelRecoveredEvent,
    # DDI
    "ddi_mounting": DdiMountingEvent,
    "ddi_mounted": DdiMountedEvent,
    "ddi_mount_failed": DdiMountFailedEvent,
    "ddi_mount_missing": DdiMountMissingEvent,
    # Cooldown
    "cooldown_update": CooldownUpdateEvent,
    # Movement
    "position_update": PositionUpdateEvent,
    "teleport": TeleportEvent,
    "waypoint_progress": WaypointProgressEvent,
    "state_change": StateChangeEvent,
    "route_path": RoutePathEvent,
    "pause_countdown": PauseCountdownEvent,
    "pause_countdown_end": PauseCountdownEndEvent,
    "lap_complete": LapCompleteEvent,
    "stop_reached": StopReachedEvent,
    "multi_stop_complete": MultiStopCompleteEvent,
    "navigation_complete": NavigationCompleteEvent,
    "random_walk_arrived": RandomWalkArrivedEvent,
    "random_walk_complete": RandomWalkCompleteEvent,
    "restored": RestoredEvent,
    "connection_lost": ConnectionLostEvent,
    # Game-assist (Pikmin Bloom)
    "gold_ditto_cycle": GoldDittoCycleEvent,
}


# ── Payload validation (tests / debug only) ──────────────────────
#
# The models above only feed codegen unless something checks what the
# backend actually sends. With GEOMIRAGE_WS_VALIDATE=1 (set by the test
# conftest) every emitted event is checked against its model — unknown
# type, missing / mistyped field, or a field the model doesn't declare —
# and each mismatch is logged and recorded in ``VIOLATIONS`` so the test
# harness can fail the test that produced it. Off in production: the
# check would cost a model_validate per ~10 Hz position frame.

VALIDATE_ENABLED: bool = os.environ.get("GEOMIRAGE_WS_VALIDATE") == "1"

VIOLATIONS: list[str] = []


def check_ws_event(
    event_type: str, data: dict[str, Any], *, udid_added_later: bool = False,
) -> None:
    """Record a violation if *data* doesn't match the model for *event_type*.

    No-op unless ``VALIDATE_ENABLED``. Never raises: emit paths swallow
    callback errors, so a raise would be lost; the recorded violation is
    what surfaces the mismatch. ``udid_added_later`` is for engine emits,
    whose ``udid`` is filled in by AppState's event callback on the way
    to the broadcaster.
    """
    if not VALIDATE_ENABLED:
        return
    if udid_added_later and isinstance(data, dict) and "udid" not in data:
        data = {**data, "udid": "engine-udid"}
    problem = _ws_event_problem(event_type, data)
    if problem is not None:
        msg = f"WS event {event_type!r} does not match its model: {problem} (payload={data!r})"
        logger.error(msg)
        VIOLATIONS.append(msg)


def _ws_event_problem(event_type: str, data: Any) -> str | None:
    model = WS_EVENTS.get(event_type)
    if model is None:
        return "unknown event type (add it to WS_EVENTS)"
    if not isinstance(data, dict):
        return f"payload is {type(data).__name__}, not an object"
    extra = sorted(set(data) - set(model.model_fields))
    if extra:
        return f"undeclared fields {extra}"
    try:
        model.model_validate(data)
    except ValidationError as exc:
        return str(exc)
    return None
