from __future__ import annotations

from enum import Enum
from typing import Annotated, Literal

from pydantic import BaseModel, Field, field_validator

# Shared coordinate bounds. Annotated metadata merges with any extra
# Field() a call site adds (e.g. description, default).
Latitude = Annotated[float, Field(ge=-90.0, le=90.0)]
Longitude = Annotated[float, Field(ge=-180.0, le=180.0)]


class Coordinate(BaseModel):
    lat: Latitude = Field(description="Latitude in degrees")
    lng: Longitude = Field(description="Longitude in degrees")


class SimulationState(str, Enum):
    IDLE = "idle"
    TELEPORTING = "teleporting"
    NAVIGATING = "navigating"
    LOOPING = "looping"
    JOYSTICK = "joystick"
    RANDOM_WALK = "random_walk"
    MULTI_STOP = "multi_stop"
    FLOWER = "flower"
    PAUSED = "paused"
    DISCONNECTED = "disconnected"
    # NOTE: "reconnecting" is no longer a SimulationState. Tunnel/DVT
    # reconnect is an orthogonal axis from what the engine is *doing*
    # (a tunnel can wobble mid-NAVIGATING without changing the engine's
    # target). It is signalled via the `tunnel_degraded` /
    # `tunnel_recovered` WS events instead, and the renderer overlays a
    # "reconnecting" hint on top of the existing state.


class MovementMode(str, Enum):
    WALKING = "walking"
    RUNNING = "running"
    DRIVING = "driving"


def osrm_profile_for(mode: MovementMode) -> str:
    """OSRM routing profile for a movement mode.

    On-foot modes route on the pedestrian network ("foot"); driving uses
    the road network ("car"). Single source of the policy shared by every
    movement-mode handler.
    """
    return "foot" if mode in (MovementMode.WALKING, MovementMode.RUNNING) else "car"


class CoordinateFormat(str, Enum):
    DD = "dd"
    DMS = "dms"
    DM = "dm"


# ── Device ───────────────────────────────────────────────
class DeviceInfo(BaseModel):
    udid: str
    name: str
    ios_version: str
    connection_type: str = "usb"
    is_connected: bool = False
    # None on iOS 15 and below or when the lockdown query failed;
    # True / False reflects the toggle state for iOS 16+.
    developer_mode_enabled: bool | None = None
    # True when all preconditions for the AMFI reveal call are met
    # (connected, USB, iOS 16+, toggle currently OFF). Centralised so
    # the frontend just shows/hides the button from one boolean rather
    # than redoing the same three-way check.
    can_reveal_developer_mode: bool = False


# ── Location requests ────────────────────────────────────
class TeleportRequest(BaseModel):
    lat: Latitude
    lng: Longitude
    udid: str | None = None
    # When true, start idle GPS jitter around the teleported point so a
    # stationary virtual position mimics natural GPS noise.
    auto_jitter: bool = False


# Input bounds shared across movement-mode requests. Upper bounds are
# deliberately loose — fast enough for a car, not so fast that a typo
# produces divide-by-near-zero tick math. Waypoint and pause limits exist
# to prevent accidental memory / CPU blow-ups.
_SPEED_BOUNDS = {"ge": 0.1, "le": 500.0}
_RADIUS_BOUNDS = {"ge": 10.0, "le": 50_000.0}
_PAUSE_BOUNDS = {"ge": 0.0, "le": 3600.0}
_MAX_WAYPOINTS = 500
_MAX_STOP_DURATION = 86_400  # 24 h


class NavigateRequest(BaseModel):
    lat: Latitude
    lng: Longitude
    mode: MovementMode = MovementMode.WALKING
    speed_kmh: float | None = Field(default=None, **_SPEED_BOUNDS)
    speed_min_kmh: float | None = Field(default=None, **_SPEED_BOUNDS)
    speed_max_kmh: float | None = Field(default=None, **_SPEED_BOUNDS)
    straight_line: bool = False
    udid: str | None = None


class LoopRequest(BaseModel):
    waypoints: list[Coordinate] = Field(min_length=1, max_length=_MAX_WAYPOINTS)
    mode: MovementMode = MovementMode.WALKING
    speed_kmh: float | None = Field(default=None, **_SPEED_BOUNDS)
    speed_min_kmh: float | None = Field(default=None, **_SPEED_BOUNDS)
    speed_max_kmh: float | None = Field(default=None, **_SPEED_BOUNDS)
    pause_enabled: bool = True
    pause_min: float = Field(default=5.0, **_PAUSE_BOUNDS)
    pause_max: float = Field(default=20.0, **_PAUSE_BOUNDS)
    straight_line: bool = False
    udid: str | None = None
    # None / 0 = run forever (user stops manually). Positive = auto-stop
    # after that many completed laps. Cap is arbitrary but prevents
    # accidental runaway from a typo.
    lap_count: int | None = Field(default=None, ge=1, le=9999)


class MultiStopRequest(BaseModel):
    waypoints: list[Coordinate] = Field(min_length=1, max_length=_MAX_WAYPOINTS)
    mode: MovementMode = MovementMode.WALKING
    stop_duration: int = Field(default=0, ge=0, le=_MAX_STOP_DURATION)
    loop: bool = False
    speed_kmh: float | None = Field(default=None, **_SPEED_BOUNDS)
    speed_min_kmh: float | None = Field(default=None, **_SPEED_BOUNDS)
    speed_max_kmh: float | None = Field(default=None, **_SPEED_BOUNDS)
    pause_enabled: bool = True
    pause_min: float = Field(default=5.0, **_PAUSE_BOUNDS)
    pause_max: float = Field(default=20.0, **_PAUSE_BOUNDS)
    straight_line: bool = False
    udid: str | None = None
    # Only meaningful when `loop=True`; otherwise the route runs once
    # and stops naturally. Same semantics as `LoopRequest.lap_count`.
    lap_count: int | None = Field(default=None, ge=1, le=9999)


class RandomWalkRequest(BaseModel):
    center: Coordinate
    radius_m: float = Field(default=500.0, **_RADIUS_BOUNDS)
    mode: MovementMode = MovementMode.WALKING
    speed_kmh: float | None = Field(default=None, **_SPEED_BOUNDS)
    speed_min_kmh: float | None = Field(default=None, **_SPEED_BOUNDS)
    speed_max_kmh: float | None = Field(default=None, **_SPEED_BOUNDS)
    pause_enabled: bool = True
    pause_min: float = Field(default=5.0, **_PAUSE_BOUNDS)
    pause_max: float = Field(default=20.0, **_PAUSE_BOUNDS)
    straight_line: bool = False
    udid: str | None = None
    # Dual-device group mode: both devices pass the same seed so they pick
    # identical sequences of random destinations, keeping their paths synced.
    seed: int | None = None


# Flower-mode bounds. Radii stay small: the mode circles a spot on foot.
FLOWER_RADIUS_BOUNDS = {"ge": 5.0, "le": 100.0}
FLOWER_SEGMENT_BOUNDS = {"ge": 6, "le": 24}
FLOWER_LAP_BOUNDS = {"ge": 0.5, "le": 10.0}
FLOWER_ROUND_BOUNDS = {"ge": 1, "le": 99}
FLOWER_WAIT_BOUNDS = {"ge": 0.0, "le": 600.0}
FLOWER_LAP_STEP = 0.5


class FlowerRequest(BaseModel):
    """Walk a small circle around each waypoint in turn."""
    waypoints: list[Coordinate] = Field(min_length=1, max_length=_MAX_WAYPOINTS)
    mode: MovementMode = MovementMode.WALKING
    radius_m: float = Field(default=20.0, **FLOWER_RADIUS_BOUNDS)
    # Vertices per circle; more = rounder path.
    segments: int = Field(default=12, **FLOWER_SEGMENT_BOUNDS)
    # Laps around each spot, in half-lap steps (0.5 = half the circle).
    laps: float = Field(default=1.0, **FLOWER_LAP_BOUNDS)
    # Passes over the whole spot list. None = repeat until stopped.
    rounds: int | None = Field(default=1, **FLOWER_ROUND_BOUNDS)
    wait_before_s: float = Field(default=0.0, **FLOWER_WAIT_BOUNDS)
    wait_after_s: float = Field(default=0.0, **FLOWER_WAIT_BOUNDS)
    # How the device gets from one spot to the next.
    transfer: Literal["walk", "teleport"] = "walk"
    speed_kmh: float | None = Field(default=None, **_SPEED_BOUNDS)
    speed_min_kmh: float | None = Field(default=None, **_SPEED_BOUNDS)
    speed_max_kmh: float | None = Field(default=None, **_SPEED_BOUNDS)
    # Optional random pause added after each spot's wait. Off by default
    # so the explicit waits are the whole story unless the user opts in.
    pause_enabled: bool = False
    pause_min: float = Field(default=5.0, **_PAUSE_BOUNDS)
    pause_max: float = Field(default=20.0, **_PAUSE_BOUNDS)
    straight_line: bool = False
    udid: str | None = None

    @field_validator("laps")
    @classmethod
    def _snap_laps(cls, v: float) -> float:
        return round(v / FLOWER_LAP_STEP) * FLOWER_LAP_STEP


class JoystickStartRequest(BaseModel):
    mode: MovementMode = MovementMode.WALKING
    speed_kmh: float | None = Field(default=None, **_SPEED_BOUNDS)
    udid: str | None = None


class JoystickInput(BaseModel):
    direction: float = Field(ge=0, le=360)
    intensity: float = Field(ge=0, le=1)
    # Speed multiplier from the UI sensitivity stepper (level/3, so
    # level 3 = 1.0×). Clamped to a sane range so a bad client can't
    # send the device flying.
    sensitivity: float = Field(default=1.0, ge=0.1, le=2.0)


# ── Simulation status ────────────────────────────────────
class SimulationStatus(BaseModel):
    state: SimulationState = SimulationState.IDLE
    current_position: Coordinate | None = None
    destination: Coordinate | None = None
    progress: float = 0.0
    speed_mps: float = 0.0
    eta_seconds: float = 0.0
    eta_arrival: str = ""
    distance_remaining: float = 0.0
    distance_traveled: float = 0.0
    lap_count: int = 0
    segment_index: int = 0
    total_segments: int = 0
    cooldown_remaining: float = 0.0
    is_paused: bool = False


# ── Route ─────────────────────────────────────────────────
# Profile values must mirror _PROFILE_MAP keys in services/route_service.py
# exactly. The Literal puts the allowlist at the API boundary so an unknown
# profile is rejected with a structured 422 before it ever reaches OSRM.
RouteProfile = Literal[
    "walking",
    "running",
    "driving",
    "foot",
    "car",
    "bike",
    "bicycle",
]


class RoutePlanRequest(BaseModel):
    start: Coordinate
    end: Coordinate
    profile: RouteProfile = "foot"


class SavedRoute(BaseModel):
    id: str = ""
    name: str = Field(max_length=512)
    waypoints: list[Coordinate] = Field(min_length=1, max_length=_MAX_WAYPOINTS)
    profile: str = Field(default="walking", max_length=32)
    created_at: str = ""
    # Added in route-store v1. Existing v0 entries are back-filled to the
    # preset "default" category on first load.
    category_id: str = "default"
    # Mirrors created_at on first save; bumped on rename / move / overwrite
    # so the UI's "sort by updated" can pick the most recently touched route.
    updated_at: str = ""
    # Insertion-order fallback used by the drag-reorder UI in route-store v1.
    # Persisted explicitly so two routes saved milliseconds apart don't end
    # up shuffling when iteration order is preserved but the frontend sorts
    # by sort_order.
    sort_order: int = 0


# Preset route category (mirrors BookmarkPlace's "default") — always present
# in the store so a route with category_id="default" never dangles.
class RouteCategory(BaseModel):
    id: str = ""
    name: str = Field(max_length=128)
    color: str = Field(default="#6c8cff", max_length=32)
    sort_order: int = 0
    created_at: str = ""


# Bumped to 1 when categories were added to the route store. v0 files (no
# `version` key, flat `routes` list with no category_id) are migrated on
# first load by :func:`backend.services.saved_routes._migrate_v0_to_v1`.
ROUTE_STORE_VERSION = 1


class RouteStore(BaseModel):
    version: int = 0
    categories: list[RouteCategory] = []
    routes: list[SavedRoute] = []


# Cap on every id-list batch payload. 10k is far beyond any plausible
# UI selection but well below the memory-pressure threshold; an attacker
# (or runaway renderer) sending 1M ids would otherwise pin the asyncio
# lock and stall every other request.
_MAX_BATCH_IDS = 10_000


class RouteMoveRequest(BaseModel):
    route_ids: list[str] = Field(max_length=_MAX_BATCH_IDS)
    target_category_id: str


class RouteBatchDeleteRequest(BaseModel):
    route_ids: list[str] = Field(max_length=_MAX_BATCH_IDS)


# ── Bookmarks ─────────────────────────────────────────────
# Data model is dual-axis:
#   * place_id (single) — "where": e.g. 富士山, 寺廟, default (未分類)
#   * tags (multi)      — "what": e.g. 掃描器, 菇, 花
# v0 stores had a single `category_id`; the migration in
# backend/services/bookmarks.py splits those into place/tag at load time.
class BookmarkPlace(BaseModel):
    id: str = ""
    name: str = Field(max_length=128)
    color: str = Field(default="#6c8cff", max_length=32)
    sort_order: int = 0
    created_at: str = ""


class BookmarkTag(BaseModel):
    id: str = ""
    name: str = Field(max_length=128)
    color: str = Field(default="#A855F7", max_length=32)
    sort_order: int = 0
    created_at: str = ""


class Bookmark(BaseModel):
    id: str = ""
    name: str = Field(max_length=512)
    lat: Latitude
    lng: Longitude
    address: str = Field(default="", max_length=1024)
    place_id: str = "default"
    tags: list[str] = Field(default_factory=list, max_length=64)
    created_at: str = ""
    last_used_at: str = ""
    # Populated by the backend when the bookmark is first created or edited.
    # Kept as plain strings so the frontend can render a flag without a
    # follow-up reverse-geocode round-trip. Optional for backward compat —
    # existing JSON files without these fields load unchanged.
    country_code: str = ""
    country: str = ""
    # Free-form user note from the edit dialog.
    note: str = Field(default="", max_length=2000)
    # Insertion-order fallback used by the drag-reorder UI. Stored
    # explicitly so two bookmarks created milliseconds apart don't drift
    # when the frontend sorts by sort_order. Defaults to 0 on legacy
    # rows — they'll all collide at the top until the user drags one,
    # at which point the reorder endpoint rewrites all neighbouring
    # sort_order values.
    sort_order: int = 0


class BookmarkUpdateRequest(BaseModel):
    """Partial body for ``PUT /api/bookmarks/{id}``. Every field is
    optional; ``None`` (or an omitted key) leaves the stored value alone,
    so an inline rename can send just ``{name}`` and "move to place" just
    ``{place_id}``."""
    name: str | None = Field(default=None, max_length=512)
    lat: Latitude | None = None
    lng: Longitude | None = None
    address: str | None = Field(default=None, max_length=1024)
    place_id: str | None = None
    tags: list[str] | None = Field(default=None, max_length=64)
    country_code: str | None = None
    country: str | None = None
    note: str | None = Field(default=None, max_length=2000)


class BookmarkMoveRequest(BaseModel):
    bookmark_ids: list[str] = Field(max_length=_MAX_BATCH_IDS)
    target_place_id: str


class BookmarkTagRequest(BaseModel):
    bookmark_ids: list[str] = Field(max_length=_MAX_BATCH_IDS)
    tag_ids_add: list[str] = Field(default_factory=list, max_length=_MAX_BATCH_IDS)
    tag_ids_remove: list[str] = Field(default_factory=list, max_length=_MAX_BATCH_IDS)


class ReorderRequest(BaseModel):
    ordered_ids: list[str] = Field(max_length=_MAX_BATCH_IDS)


# Bumped to 1 when the single-category schema was split into place + tags.
# The on-disk JSON gets re-written with this value after _migrate_v0_to_v1.
BOOKMARK_STORE_VERSION = 1


class BookmarkStore(BaseModel):
    version: int = 0
    places: list[BookmarkPlace] = []
    tags: list[BookmarkTag] = []
    bookmarks: list[Bookmark] = []


# ── Cooldown ──────────────────────────────────────────────
class CooldownSettings(BaseModel):
    enabled: bool = True


class CooldownStatus(BaseModel):
    enabled: bool = True
    is_active: bool = False
    remaining_seconds: float = 0.0
    total_seconds: float = 0.0
    distance_km: float = 0.0


# ── Coord format ─────────────────────────────────────────
class CoordFormatRequest(BaseModel):
    format: CoordinateFormat


# ── Geocoding ─────────────────────────────────────────────
class GeocodingResult(BaseModel):
    display_name: str
    lat: float
    lng: float
    type: str = ""
    importance: float = 0.0
    country_code: str = ""
    country: str = ""
    # A human-friendly short label extracted from the richest tier of the
    # Nominatim address tree (POI > road > suburb > city > …). Populated by
    # reverse lookups; empty on forward search results.
    place_name: str = ""
