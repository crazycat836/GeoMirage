"""Process-wide application state.

Lifted out of ``main.py`` so the entrypoint can stay focused on
HTTP wiring. Owns:

  - The DeviceManager + per-udid SimulationEngine registry
  - Persistent settings (``last_position`` / ``initial_map_position`` /
    ``coord_format``) in ``~/.geomirage/settings.json``
  - The CooldownTimer / BookmarkManager / CoordinateFormatter singletons
  - The RouteService / GpxService / SavedRoutesStore route singletons
  - Dual-device auto-sync (``_sync_new_device_to_primary``): when a
    secondary device connects while the primary is mid-route, replay
    the primary's in-flight snapshot on the newcomer.

A single instance is constructed in ``main.py`` and parked on
``context.ctx`` so every router can reach it without an import cycle.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from typing import TYPE_CHECKING

from config import DEFAULT_LOCATION, ROUTES_FILE, SETTINGS_FILE, STATE_SAVE_INTERVAL_SEC
from core.device_manager import DeviceManager
from core.dual_sync import DualSyncCoordinator
from services.bookmarks import BookmarkManager
from services.coord_format import CoordinateFormatter
from services.cooldown import CooldownTimer
from services.gpx_service import GpxService
from services.route_service import RouteService
from services.json_safe import safe_load_json, safe_write_json
from services.saved_routes import SavedRoutesStore

if TYPE_CHECKING:
    from core.simulation_engine import SimulationEngine

logger = logging.getLogger("geomirage")

# One writer at a time for settings.json (see AppState.save_settings).
_SETTINGS_WRITE_LOCK = threading.Lock()


class AppState:
    """Central application state — shared across API endpoints."""

    def __init__(self):
        self.device_manager = DeviceManager()
        # Per-udid simulation engines (group mode, max 2). The legacy
        # `simulation_engine` attribute still returns the most-recently-
        # created engine for single-device call sites that have not yet
        # been refactored.
        self.simulation_engines: dict[str, "SimulationEngine"] = {}
        self._primary_udid: str | None = None
        # deferred to break api↔main circular import
        from services.ws_broadcaster import broadcast
        self.cooldown_timer = CooldownTimer(broadcast=broadcast)
        self.bookmark_manager = BookmarkManager()
        self.coord_formatter = CoordinateFormatter()
        # Route-planning singletons. Previously module-globals in
        # api/route.py, which made `import api.route` hit the disk
        # (SavedRoutesStore loads routes.json on construction). Owning
        # them here keeps all long-lived state on the composition root;
        # construction now happens when AppState is built in main.py.
        self.route_service = RouteService()
        self.gpx_service = GpxService()
        self.saved_routes_store = SavedRoutesStore(ROUTES_FILE)
        self._last_position = None
        # User-chosen initial map center (persisted between launches). When
        # None, the frontend falls back to a hardcoded default.
        self._initial_map_position: dict | None = None
        # WiFi-tunnel keep-alive: when True, a background loop periodically
        # re-asserts each idle engine's current virtual location so the DVT
        # channel doesn't idle out when the iPhone screen dims. Opt-in
        # (default off) — it keeps the connection warm at the cost of a
        # little extra traffic. Persisted so the choice survives relaunch.
        self._wifi_keepalive: bool = False
        # Throttle disk writes for high-frequency position_update events
        # (~10 Hz during navigation). Interval lives in config so the
        # rationale sits next to other tunables.
        self._last_save_time: float = 0.0
        self._save_interval: float = STATE_SAVE_INTERVAL_SEC
        # Dual-device auto-sync task lifecycle (spawn / cancel / drain)
        # lives in core.dual_sync; AppState only decides *when* to sync.
        self._dual_sync = DualSyncCoordinator()
        # Serialises mutation of ``simulation_engines`` / ``_primary_udid``.
        # These are touched from many concurrent contexts (lifespan auto-
        # connect, USB watchdog, REST connect/disconnect, WS probe, tunnel
        # teardown); without this a concurrent create+terminate for the same
        # udid can orphan an engine whose movement task keeps pushing to a
        # dead device. Bound lazily to the running loop on first acquire
        # (Python 3.10+), so constructing at import time is safe.
        self._engine_lock: asyncio.Lock = asyncio.Lock()
        self._load_settings()

    def _load_settings(self):
        # safe_load_json moves an unparseable (e.g. half-written) or
        # non-object (e.g. ``null``) file to ``settings.json.bak-<ts>``
        # and returns None, so we start from defaults.
        data = safe_load_json(SETTINGS_FILE, expect=dict)
        if data is None:
            return
        try:
            pos = data.get("last_position")
            if pos:
                self._last_position = pos
            fmt = data.get("coord_format")
            if fmt:
                from models.schemas import CoordinateFormat
                self.coord_formatter.format = CoordinateFormat(fmt)
            imp = data.get("initial_map_position")
            if isinstance(imp, dict) and "lat" in imp and "lng" in imp:
                self._initial_map_position = {"lat": float(imp["lat"]), "lng": float(imp["lng"])}
            self._wifi_keepalive = bool(data.get("wifi_keepalive", False))
        except (TypeError, ValueError, KeyError):
            logger.warning("Settings file malformed; using defaults", exc_info=True)

    def save_settings(self) -> bool:
        """Persist settings to disk. Returns False when the write failed
        (the settings PUT routes map that to a 500
        ``settings_persist_failed`` envelope instead of lying with a 200
        while the write evaporated). Best-effort callers (throttled
        position saves, shutdown flush) may ignore the result.

        Goes through ``safe_write_json`` (0600 temp file + atomic
        replace, so a symlinked settings.json is replaced rather than
        followed, then chown back to the sudo invoker). The lock
        serialises the event-loop throttled save and the settings PUTs
        that run on worker threads.
        """
        with _SETTINGS_WRITE_LOCK:
            data = {
                "last_position": self._last_position,
                "coord_format": self.coord_formatter.format.value,
                "initial_map_position": self._initial_map_position,
                "wifi_keepalive": self._wifi_keepalive,
            }
            return safe_write_json(SETTINGS_FILE, data)

    def get_initial_position(self) -> dict:
        if self._last_position:
            return self._last_position
        # Could try IP geolocation here; fallback to default
        return DEFAULT_LOCATION

    def update_last_position(self, lat: float, lng: float):
        self._last_position = {"lat": lat, "lng": lng}
        # Throttled persistence so the position survives a server crash /
        # restart. Without this, save_settings() only runs on graceful
        # shutdown and any teleport / navigation state is lost.
        now = time.monotonic()
        if now - self._last_save_time >= self._save_interval:
            self._last_save_time = now
            self.save_settings()

    def set_initial_position(self, position: dict | None) -> None:
        """Set the persisted initial map center ({"lat","lng"} or None)."""
        self._initial_map_position = position

    def get_wifi_keepalive(self) -> bool:
        """Whether the WiFi-tunnel keep-alive loop is enabled."""
        return self._wifi_keepalive

    def set_wifi_keepalive(self, enabled: bool) -> bool:
        """Enable/disable the keep-alive loop and persist the choice.
        Returns False when persistence failed (the in-memory toggle is
        still applied; the route maps False to a 500 envelope so the UI
        can roll back)."""
        self._wifi_keepalive = bool(enabled)
        return self.save_settings()

    def get_initial_map_position(self) -> dict | None:
        """Return the user-pinned initial map center, or None if unset.

        Distinct from :py:meth:`get_initial_position`, which falls back
        to the last device coordinate / default. Frontend's
        ``GET /api/location/settings/initial-position`` exposes only the
        persisted setting so a cleared pin (None) round-trips as null.
        """
        return self._initial_map_position

    def get_last_position(self) -> dict | None:
        """Return the device's last-known coordinate ({"lat","lng"}), or
        None if nothing has been recorded yet.

        Used by ``GET /api/location/last-device-position`` so the
        frontend can pre-render the position pin on app launch.
        """
        return self._last_position

    @property
    def simulation_engine(self):
        """Legacy accessor: the most-recently-created engine.
        Prefer get_engine(udid) in new code."""
        if self._primary_udid and self._primary_udid in self.simulation_engines:
            return self.simulation_engines[self._primary_udid]
        return None

    def get_engine(self, udid: str | None):
        """Return the engine for *udid*, or the primary engine if udid is None."""
        if udid is None:
            return self.simulation_engine
        return self.simulation_engines.get(udid)

    async def terminate_engine(self, udid: str, *, timeout: float = 2.0) -> None:
        """Stop and dispose of the simulation engine for *udid*.

        Guarantees that any in-flight Navigate / Loop / MultiStop /
        RandomWalk / Joystick task is cancelled before the engine is
        removed from the registry. Without this, a USB unplug during
        active simulation leaves the background task running — it keeps
        emitting ``position_update`` / ``navigation_complete`` events
        against a dead device until it eventually errors out.
        """
        # Cancel any dual-sync task targeting this device first so it can't
        # resurrect movement on the engine we're about to drop.
        self._cancel_sync_task_for(udid)
        async with self._engine_lock:
            engine = self.simulation_engines.get(udid)
            if engine is None:
                return
            try:
                await asyncio.wait_for(engine.stop(), timeout=timeout)
            except asyncio.TimeoutError:
                logger.warning(
                    "Engine stop for %s exceeded %.1fs — forcing cleanup",
                    udid, timeout,
                )
            except Exception:
                logger.exception("Engine stop for %s raised; forcing cleanup", udid)
            finally:
                self.simulation_engines.pop(udid, None)
                if self._primary_udid == udid:
                    self._primary_udid = next(iter(self.simulation_engines), None)

    def _cancel_sync_task_for(self, udid: str) -> None:
        """Cancel the in-flight dual-sync task targeting *udid*, if any."""
        self._dual_sync.cancel_for(udid)

    async def cancel_sync_tasks(self) -> None:
        """Cancel + drain every in-flight dual-device auto-sync task.

        Called from the lifespan shutdown so a mid-flight OSRM-backed sync
        can't keep running after the engines it targets are gone.
        """
        await self._dual_sync.cancel_all()

    async def create_engine_for_device(self, udid: str):
        """Create a SimulationEngine for the connected device.

        The engine is left idle — no virtual location is pushed to the
        iPhone until the user explicitly triggers a teleport / navigate /
        bookmark / joystick action. This preserves the phone's real GPS
        reading on pure connect and avoids silently overwriting it with a
        stale saved position.

        Primary-device slot rule: the first connected device becomes
        primary. Subsequent connections are tracked as secondaries — they
        do not hijack the map-view focus.
        """
        from core.simulation_engine import SimulationEngine
        from services.ws_broadcaster import broadcast

        loc_service = await self.device_manager.get_location_service(udid)

        async def event_callback(event_type: str, data: dict):
            # Always tag emissions with udid so the frontend can route per-device.
            if isinstance(data, dict) and "udid" not in data:
                data = {**data, "udid": udid}
            await broadcast(event_type, data)
            if event_type == "position_update" and "lat" in data:
                self.update_last_position(data["lat"], data["lng"])

        async with self._engine_lock:
            # Replace any existing engine for this udid *under the lock* so a
            # concurrent terminate/create can't leave a movement task orphaned
            # against a slot we're about to overwrite. Inlined stop() rather
            # than self.terminate_engine() to avoid re-acquiring this lock.
            existing = self.simulation_engines.get(udid)
            if existing is not None:
                try:
                    await existing.stop()
                except Exception:
                    logger.exception("Replacing engine for %s: stop() raised", udid)
            engine = SimulationEngine(loc_service, event_callback)
            self.simulation_engines[udid] = engine
            # Only claim the primary slot when it's free — preserves first-
            # connected device on subsequent connections.
            became_primary = self._primary_udid is None
            if became_primary:
                self._primary_udid = udid

        logger.info(
            "Simulation engine created for device %s (primary=%s)",
            udid, became_primary,
        )

        # Dual-device auto-sync: if the primary is already running something,
        # mirror it on the newcomer so both phones end up following the same
        # plan without the user having to stop / restart.
        if not became_primary:
            await self._sync_new_device_to_primary(udid)

    async def _sync_new_device_to_primary(self, new_udid: str) -> None:
        """Replay the primary device's in-flight simulation on *new_udid*.

        Resolves both engines from the registry, then hands off to the
        DualSyncCoordinator, which spawns the fire-and-forget replay task
        (teleport to the primary's position, then
        ``SimulationSnapshot.replay_on``) — or rejects it up front when
        the primary is idle / position-less / carries an unknown
        movement_mode.
        """
        primary_udid = self._primary_udid
        if primary_udid is None or primary_udid == new_udid:
            return
        primary = self.simulation_engines.get(primary_udid)
        new_engine = self.simulation_engines.get(new_udid)
        if primary is None or new_engine is None:
            return
        self._dual_sync.sync_to_primary(
            primary_udid=primary_udid,
            primary=primary,
            new_udid=new_udid,
            new_engine=new_engine,
        )
