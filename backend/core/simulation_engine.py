"""Simulation engine -- central orchestrator for all movement modes."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any

from models.schemas import (
    Coordinate,
    JoystickInput,
    MovementMode,
    SimulationState,
    SimulationStatus,
)
from services.location_service import DeviceLostError, LocationService, unwrap_device_lost
from services.route_service import RouteService, RouteUnavailableError
from config import (
    SpeedProfile,
    DEFAULT_PAUSE_ENABLED,
    DEFAULT_PAUSE_MIN,
    DEFAULT_PAUSE_MAX,
    resolve_speed_profile,
)

from core.teleport import TeleportHandler
from core.navigator import Navigator
from core.route_loop import RouteLooper
from core.joystick import JoystickHandler
from core.multi_stop import MultiStopNavigator
from core.flower import FlowerHandler, TransferMode
from core.random_walk import RandomWalkHandler
from core.restore import RestoreHandler
# Extracted cohesive units. Re-imported here (not just used internally) so
# existing `from core.simulation_engine import SimulationSnapshot / EtaTracker`
# call sites keep working.
from core.eta_tracker import EtaTracker
from core.simulation_snapshot import SimulationSnapshot, SnapshotMode

if TYPE_CHECKING:
    from services.cooldown import CooldownTimer

# Modes that run several ``_move_along_route`` legs with gaps in between, so a
# speed change can arrive while no leg is active and still apply to the next.
_MULTI_LEG_STATES = frozenset({
    SimulationState.LOOPING,
    SimulationState.MULTI_STOP,
    SimulationState.RANDOM_WALK,
    SimulationState.FLOWER,
})

logger = logging.getLogger(__name__)


# Mask applied to the time-derived default random-walk seed so it stays
# inside the signed-int32 range (max value Python's seeding accepts on
# every platform / Random impl). Only used when the caller passes seed=None.
_DEFAULT_RANDOM_WALK_SEED_MASK = 0x7FFFFFFF


# Auto-jitter (idle anti-detection wobble): every JITTER_INTERVAL_RANGE_S
# seconds the reported position is nudged up to ±JITTER_RADIUS_M metres
# around the anchor. METERS_PER_DEG_LAT converts that offset to degrees.
JITTER_INTERVAL_RANGE_S = (2.0, 4.0)
JITTER_RADIUS_M = 4.0
METERS_PER_DEG_LAT = 111_111.0


# Waypoint-pass detection thresholds (WP_HARD_HIT_M / WP_NEAR_M /
# WP_RECEDE_M) live in core.movement_loop alongside the only function
# that uses them.


# ── Simulation Engine ───────────────────────────────────────────────────

class SimulationEngine:
    """Central controller that orchestrates all movement modes.

    Manages state transitions, task lifecycle, pause/resume, and provides
    a unified status object for the UI.

    Parameters
    ----------
    location_service
        A ``LocationService`` instance (DVT or legacy) for the target device.
    event_callback
        Optional async callable ``(event_type: str, data: dict) -> None``
        used to push realtime events over WebSocket.
    """

    def __init__(
        self,
        location_service: LocationService,
        event_callback: Callable[[str, dict[str, Any]], Awaitable[None]] | None = None,
    ) -> None:
        # Long-lived service handles.
        self.location_service = location_service
        self.event_callback = event_callback
        self.route_service = RouteService()
        self.eta_tracker = EtaTracker()

        # ── asyncio concurrency primitives ────────────────────────────
        # ``_pause_event``: set = running, clear = paused. Started set
        # so a fresh engine isn't blocked.
        # ``_stop_event``:  set = handler should bail at next checkpoint.
        # ``_apply_speed_lock``: serialises concurrent /apply-speed calls
        # so the read-modify-write of ``_pending_speed_profile`` /
        # ``_speed_was_applied`` can't interleave. After acquire,
        # apply_speed re-reads ``state`` and ``_active_route_coords``
        # because ``_move_along_route``'s finalize block may have
        # cleared them while the caller was queued.
        self._pause_event: asyncio.Event = asyncio.Event()
        self._pause_event.set()
        self._stop_event: asyncio.Event = asyncio.Event()
        self._apply_speed_lock: asyncio.Lock = asyncio.Lock()

        # ── Per-run mutable state ─────────────────────────────────────
        self.state: SimulationState = SimulationState.IDLE
        self.current_position: Coordinate | None = None
        # time.monotonic() of the last successful push to the device, so the
        # WiFi keep-alive can tell when the channel has gone quiet (idle,
        # paused, or waiting between legs) regardless of engine state.
        self.last_push_at: float = 0.0
        # True while the device shows a simulated location. Cleared by
        # restore (real GPS back), so the keep-alive never re-imposes the
        # last virtual position on a phone the user just released.
        self.location_active: bool = False

        # Most recent long-running action. Populated by navigate/start_loop/
        # multi_stop/random_walk at the moment each begins, cleared when the
        # engine returns to IDLE. AppState reads this to replay the same
        # action on a newly-connected secondary device.
        self.snapshot: SimulationSnapshot | None = None

        # Task management.
        self._active_task: asyncio.Task | None = None
        self._paused_from: SimulationState | None = None
        # Auto-jitter: optional idle drift around a teleport anchor so a
        # static virtual position looks like natural GPS noise.
        self._jitter_task: asyncio.Task | None = None
        self._jitter_anchor: Coordinate | None = None

        # Status tracking.
        self.distance_traveled: float = 0.0
        self.distance_remaining: float = 0.0
        self.lap_count: int = 0
        self.segment_index: int = 0
        self.total_segments: int = 0
        self._current_speed_mps: float = 0.0

        # Hot-swap speed support (see apply_speed + _move_along_route).
        self._active_route_coords: list[Coordinate] = []
        self._active_speed_profile: "SpeedProfile | None" = None
        self._pending_speed_profile: "SpeedProfile | None" = None

        # User-facing waypoints used for waypoint_progress emission. Set
        # by route_loop / multi_stop / navigator before each call to
        # _move_along_route, so highlight events refer to the named
        # waypoints rather than OSRM-densified polyline points.
        self._user_waypoints: list[Coordinate] = []
        self._user_waypoint_next: int = 0

        # Set by apply_speed so route_loop / multi_stop know to reuse
        # the applied profile on the next lap instead of re-resolving
        # from the original request (which would revert speed every lap).
        self._speed_was_applied: bool = False

        # Extra meters to add to every emitted distance_remaining / ETA
        # while _move_along_route is running. Multi-stop sets this to
        # the sum of future legs' distances so the UI shows total-trip
        # ETA, not just current-leg ETA. Reset to 0 outside multi-stop.
        self._route_offset_remaining: float = 0.0

        # Sub-handlers (need ``self`` to construct).
        self._teleport_handler = TeleportHandler(self)
        self._navigator = Navigator(self)
        self._looper = RouteLooper(self)
        self._joystick = JoystickHandler(self)
        self._multi_stop = MultiStopNavigator(self)
        self._random_walk = RandomWalkHandler(self)
        self._flower = FlowerHandler(self)
        self._restore_handler = RestoreHandler(self)
        # Game-assist sub-handler — distinct from the movement modes
        # because the cycle is a one-shot location swap, not a
        # continuous loop. Local import keeps a clean dependency arrow
        # (gold_ditto only needs the engine's state / location_service /
        # _emit; importing it at module top would form a cycle if the
        # handler ever grows engine-class type hints).
        from core.gold_ditto import GoldDittoHandler
        self._gold_ditto = GoldDittoHandler(self)

    # ── Public API ───────────────────────────────────────────

    async def teleport(self, lat: float, lng: float) -> Coordinate:
        """Instantly move to a coordinate."""
        return await self._teleport_handler.teleport(lat, lng)

    async def set_auto_jitter(self, enabled: bool) -> None:
        """Start or stop idle GPS jitter around the current position.

        When enabled, a background task pushes tiny random offsets
        (±~4 m) around the position captured when jitter started, every
        few seconds, so a stationary virtual location reads like a real
        device's GPS noise. The loop self-terminates if the engine
        leaves IDLE (a real simulation took over) or loses its position.
        Calling with the same value while already running is a no-op.
        """
        if self._jitter_task is not None and not self._jitter_task.done():
            if enabled:
                # Re-anchor to the latest position but keep the loop.
                self._jitter_anchor = self.current_position
                return
            self._cancel_jitter()
            return
        if not enabled or self.current_position is None:
            return
        self._jitter_anchor = self.current_position
        self._jitter_task = asyncio.create_task(self._jitter_loop())

    def _cancel_jitter(self) -> None:
        """Stop idle auto-jitter so it can't push a position after stop/restore."""
        if self._jitter_task is not None and not self._jitter_task.done():
            self._jitter_task.cancel()
        self._jitter_task = None
        self._jitter_anchor = None

    async def _jitter_loop(self) -> None:
        import math
        import random
        try:
            while (
                self.state == SimulationState.IDLE
                and self._jitter_anchor is not None
                and self.location_active
            ):
                await asyncio.sleep(random.uniform(*JITTER_INTERVAL_RANGE_S))
                anchor = self._jitter_anchor
                if (
                    anchor is None
                    or self.state != SimulationState.IDLE
                    or not self.location_active
                ):
                    break
                # ±JITTER_RADIUS_M converted to degrees; longitude scaled by latitude.
                dlat = random.uniform(-JITTER_RADIUS_M, JITTER_RADIUS_M) / METERS_PER_DEG_LAT
                cos_lat = max(0.01, math.cos(math.radians(anchor.lat)))
                dlng = random.uniform(-JITTER_RADIUS_M, JITTER_RADIUS_M) / (METERS_PER_DEG_LAT * cos_lat)
                try:
                    await self._set_position(anchor.lat + dlat, anchor.lng + dlng)
                    await self._emit("position_update", {
                        "lat": anchor.lat + dlat,
                        "lng": anchor.lng + dlng,
                    })
                except Exception:
                    logger.debug("auto-jitter set_position failed", exc_info=True)
                    break
        except asyncio.CancelledError:
            pass
        finally:
            self._jitter_task = None

    async def gold_ditto_cycle(self, lat: float, lng: float) -> None:
        """Run one Gold Ditto (拉金盆) anchor-and-restore cycle.

        Stops any active simulation, pushes the iPhone GPS to
        ``(lat, lng)`` (the user's real position), then calls
        :meth:`restore` to flip the device back to real GPS. The
        position push deliberately bypasses :meth:`teleport` to avoid
        broadcasting ``position_update`` — the desktop map keeps
        showing the gold-flower spot the user manually flew to.
        """
        await self._gold_ditto.cycle(lat, lng)

    async def _run_handler(self, coro, label: str) -> None:
        """Run a simulation handler coroutine with uniform cleanup.
        Any exception or cancellation forces the engine back to IDLE and
        notifies the frontend, preventing UI desync after a crash / drop.
        DeviceLostError is re-raised (after cleanup) so api.location._spawn()
        can translate it into a device_disconnected broadcast — otherwise
        the frontend never learns the tunnel died. RouteUnavailableError is
        re-raised for the same reason: spawn() broadcasts it as a
        ``device_error`` toast, so the user learns WHY the run aborted
        instead of watching it silently snap back to idle."""
        # A real simulation supersedes idle auto-jitter — stop it so the
        # two don't fight over position pushes.
        self._cancel_jitter()
        # Two callers that both waited out stop() can reach this point
        # back to back; never orphan a still-running task by overwriting
        # its reference.
        await self._cancel_active_task()
        task = asyncio.create_task(coro)
        self._active_task = task
        # Aborts the frontend must hear about are re-raised after cleanup.
        passthrough: Exception | None = None
        try:
            await task
        except asyncio.CancelledError:
            logger.info("%s cancelled", label)
        except (DeviceLostError, RouteUnavailableError) as exc:
            logger.warning("%s aborted: %s", label, exc)
            passthrough = exc
        except Exception as exc:
            logger.exception("%s failed unexpectedly", label)
            # DeviceLostError is often re-raised wrapped (e.g. from
            # pymobiledevice3 timeouts) — walk the __cause__ chain.
            passthrough = unwrap_device_lost(exc)
        finally:
            # Only the run that still owns the engine may reset it: once a
            # newer action has replaced (or stop() has cleared) the task,
            # the state belongs to that action.
            if self._active_task is task:
                self._active_task = None
                # Force state back to IDLE if a handler crashed / was
                # cancelled mid-flight so the UI doesn't stay stuck
                # showing "navigating".
                if self.state not in (SimulationState.IDLE, SimulationState.DISCONNECTED):
                    self.state = SimulationState.IDLE
                    try:
                        await self._emit("state_change", {"state": self.state.value})
                    except Exception:
                        logger.exception("Failed to emit idle state_change after %s", label)
        if passthrough is not None:
            raise passthrough

    async def navigate(
        self, dest: Coordinate, mode: MovementMode,
        speed_kmh: float | None = None,
        speed_min_kmh: float | None = None,
        speed_max_kmh: float | None = None,
        straight_line: bool = False,
    ) -> None:
        """Navigate from current position to *dest*."""
        await self._ensure_stopped()
        self._stop_event.clear()
        self._pause_event.set()
        self.snapshot = snapshot = SimulationSnapshot(
            mode="navigate",
            movement_mode=mode.value,
            speed_kmh=speed_kmh,
            speed_min_kmh=speed_min_kmh,
            speed_max_kmh=speed_max_kmh,
            destination={"lat": dest.lat, "lng": dest.lng},
            straight_line=straight_line,
        )
        try:
            await self._run_handler(
                self._navigator.navigate_to(
                    dest, mode, speed_kmh=speed_kmh,
                    speed_min_kmh=speed_min_kmh, speed_max_kmh=speed_max_kmh,
                    straight_line=straight_line,
                ),
                "Navigate",
            )
        finally:
            self._release_snapshot(snapshot)

    async def start_loop(
        self,
        waypoints: list[Coordinate],
        mode: MovementMode,
        speed_kmh: float | None = None,
        speed_min_kmh: float | None = None,
        speed_max_kmh: float | None = None,
        pause_enabled: bool = DEFAULT_PAUSE_ENABLED,
        pause_min: float = DEFAULT_PAUSE_MIN,
        pause_max: float = DEFAULT_PAUSE_MAX,
        straight_line: bool = False,
        lap_count: int | None = None,
    ) -> None:
        """Start looping through a closed route."""
        await self._ensure_stopped()
        self._stop_event.clear()
        self._pause_event.set()
        self.snapshot = snapshot = SimulationSnapshot(
            mode="loop",
            movement_mode=mode.value,
            speed_kmh=speed_kmh,
            speed_min_kmh=speed_min_kmh,
            speed_max_kmh=speed_max_kmh,
            waypoints=[{"lat": w.lat, "lng": w.lng} for w in waypoints],
            pause_enabled=pause_enabled,
            pause_min=pause_min,
            pause_max=pause_max,
            straight_line=straight_line,
            lap_count=lap_count,
        )
        try:
            await self._run_handler(
                self._looper.start_loop(
                    waypoints, mode, speed_kmh=speed_kmh,
                    speed_min_kmh=speed_min_kmh, speed_max_kmh=speed_max_kmh,
                    pause_enabled=pause_enabled, pause_min=pause_min, pause_max=pause_max,
                    straight_line=straight_line,
                    lap_count=lap_count,
                ),
                "Loop",
            )
        finally:
            self._release_snapshot(snapshot)

    async def joystick_start(self, mode: MovementMode) -> None:
        """Activate joystick mode."""
        # Joystick keeps the engine out of IDLE — cancel idle auto-jitter
        # explicitly so it doesn't push stray offsets under live control.
        await self.set_auto_jitter(False)
        await self._joystick.start(mode)

    def joystick_move(self, joystick_input: JoystickInput) -> None:
        """Update the joystick direction/intensity (non-blocking)."""
        self._joystick.update_input(joystick_input)

    def _leave_joystick_state(self) -> bool:
        """Drop back to IDLE from JOYSTICK, or from a pause taken during
        joystick mode. Returns False (and changes nothing) when another
        mode owns the state. The caller emits the state_change."""
        in_joystick = self.state == SimulationState.JOYSTICK or (
            self.state == SimulationState.PAUSED
            and self._paused_from in (None, SimulationState.JOYSTICK)
        )
        if not in_joystick:
            return False
        self.state = SimulationState.IDLE
        self._paused_from = None
        self._pause_event.set()
        return True

    async def joystick_stop(self) -> None:
        """Deactivate joystick mode."""
        await self._joystick.stop()
        # A pause taken in joystick mode leaves the state at PAUSED; stop
        # has to clear that too or resume would revive a dead joystick.
        if self._leave_joystick_state():
            await self._emit("state_change", {"state": self.state.value})

    async def multi_stop(
        self,
        waypoints: list[Coordinate],
        mode: MovementMode,
        stop_duration: float = 0,
        loop: bool = False,
        speed_kmh: float | None = None,
        speed_min_kmh: float | None = None,
        speed_max_kmh: float | None = None,
        pause_enabled: bool = DEFAULT_PAUSE_ENABLED,
        pause_min: float = DEFAULT_PAUSE_MIN,
        pause_max: float = DEFAULT_PAUSE_MAX,
        straight_line: bool = False,
        lap_count: int | None = None,
    ) -> None:
        """Navigate through waypoints with optional stops."""
        await self._ensure_stopped()
        self._stop_event.clear()
        self._pause_event.set()
        self.snapshot = snapshot = SimulationSnapshot(
            mode="multi_stop",
            movement_mode=mode.value,
            speed_kmh=speed_kmh,
            speed_min_kmh=speed_min_kmh,
            speed_max_kmh=speed_max_kmh,
            waypoints=[{"lat": w.lat, "lng": w.lng} for w in waypoints],
            stop_duration=stop_duration,
            loop_multistop=loop,
            pause_enabled=pause_enabled,
            pause_min=pause_min,
            pause_max=pause_max,
            straight_line=straight_line,
            lap_count=lap_count,
        )
        try:
            await self._run_handler(
                self._multi_stop.start(
                    waypoints, mode, stop_duration, loop, speed_kmh=speed_kmh,
                    speed_min_kmh=speed_min_kmh, speed_max_kmh=speed_max_kmh,
                    pause_enabled=pause_enabled, pause_min=pause_min, pause_max=pause_max,
                    straight_line=straight_line,
                    lap_count=lap_count,
                ),
                "Multi-stop",
            )
        finally:
            self._release_snapshot(snapshot)

    async def random_walk(
        self,
        center: Coordinate,
        radius_m: float,
        mode: MovementMode,
        speed_kmh: float | None = None,
        speed_min_kmh: float | None = None,
        speed_max_kmh: float | None = None,
        pause_enabled: bool = DEFAULT_PAUSE_ENABLED,
        pause_min: float = DEFAULT_PAUSE_MIN,
        pause_max: float = DEFAULT_PAUSE_MAX,
        seed: int | None = None,
        straight_line: bool = False,
    ) -> None:
        """Begin a random walk within a radius."""
        await self._ensure_stopped()
        self._stop_event.clear()
        self._pause_event.set()
        # Always have a seed so a secondary device joining mid-walk can
        # replay the same destination sequence. Unseeded callers get a
        # time-based seed that's captured in the snapshot.
        if seed is None:
            seed = int(time.time() * 1000) & _DEFAULT_RANDOM_WALK_SEED_MASK
        self.snapshot = snapshot = SimulationSnapshot(
            mode="random_walk",
            movement_mode=mode.value,
            speed_kmh=speed_kmh,
            speed_min_kmh=speed_min_kmh,
            speed_max_kmh=speed_max_kmh,
            center={"lat": center.lat, "lng": center.lng},
            radius_m=radius_m,
            seed=seed,
            pause_enabled=pause_enabled,
            pause_min=pause_min,
            pause_max=pause_max,
            straight_line=straight_line,
        )
        try:
            await self._run_handler(
                self._random_walk.start(
                    center, radius_m, mode,
                    speed_kmh=speed_kmh,
                    speed_min_kmh=speed_min_kmh, speed_max_kmh=speed_max_kmh,
                    pause_enabled=pause_enabled, pause_min=pause_min, pause_max=pause_max,
                    seed=seed,
                    straight_line=straight_line,
                ),
                "Random walk",
            )
        finally:
            self._release_snapshot(snapshot)

    async def flower(
        self,
        waypoints: list[Coordinate],
        mode: MovementMode,
        *,
        radius_m: float,
        segments: int,
        laps: float,
        rounds: int | None,
        wait_before_s: float = 0.0,
        wait_after_s: float = 0.0,
        transfer: TransferMode = "walk",
        speed_kmh: float | None = None,
        speed_min_kmh: float | None = None,
        speed_max_kmh: float | None = None,
        pause_enabled: bool = False,
        pause_min: float = DEFAULT_PAUSE_MIN,
        pause_max: float = DEFAULT_PAUSE_MAX,
        straight_line: bool = False,
        cooldown: "CooldownTimer | None" = None,
    ) -> None:
        """Walk a small circle around each waypoint in turn."""
        await self._ensure_stopped()
        self._stop_event.clear()
        self._pause_event.set()
        self.snapshot = snapshot = SimulationSnapshot(
            mode="flower",
            movement_mode=mode.value,
            speed_kmh=speed_kmh,
            speed_min_kmh=speed_min_kmh,
            speed_max_kmh=speed_max_kmh,
            waypoints=[{"lat": w.lat, "lng": w.lng} for w in waypoints],
            radius_m=radius_m,
            segments=segments,
            laps=laps,
            wait_before_s=wait_before_s,
            wait_after_s=wait_after_s,
            transfer=transfer,
            pause_enabled=pause_enabled,
            pause_min=pause_min,
            pause_max=pause_max,
            straight_line=straight_line,
            lap_count=rounds,
        )
        try:
            await self._run_handler(
                self._flower.start(
                    waypoints, mode,
                    radius_m=radius_m, segments=segments, laps=laps, rounds=rounds,
                    wait_before_s=wait_before_s, wait_after_s=wait_after_s,
                    transfer=transfer,
                    speed_kmh=speed_kmh,
                    speed_min_kmh=speed_min_kmh, speed_max_kmh=speed_max_kmh,
                    pause_enabled=pause_enabled, pause_min=pause_min, pause_max=pause_max,
                    straight_line=straight_line,
                    cooldown=cooldown,
                ),
                "Flower",
            )
        finally:
            self._release_snapshot(snapshot)

    async def pause(self) -> None:
        """Pause the active movement.

        Clears the pause event so the movement loop blocks until resumed.
        """
        if self.state == SimulationState.PAUSED:
            return
        if self.state == SimulationState.IDLE:
            return

        self._paused_from = self.state
        self.state = SimulationState.PAUSED
        self._pause_event.clear()

        await self._emit("state_change", {
            "state": self.state.value,
            "paused_from": self._paused_from.value if self._paused_from else None,
        })
        logger.info("Simulation paused (was %s)", self._paused_from)

    async def resume(self) -> None:
        """Resume a paused movement."""
        if self.state != SimulationState.PAUSED:
            return

        prev = self._paused_from or SimulationState.IDLE
        self.state = prev
        self._paused_from = None
        self._pause_event.set()

        await self._emit("state_change", {"state": self.state.value})
        logger.info("Simulation resumed to %s", self.state.value)

    async def restore(self) -> None:
        """Stop everything and clear the simulated location."""
        await self._restore_handler.restore()

    async def stop(self) -> None:
        """Stop the current movement gracefully.

        Sets the stop event so the movement loop exits, then waits for
        the active task to finish.
        """
        self._stop_event.set()
        self._pause_event.set()  # unblock if paused
        self._cancel_jitter()

        # Stop joystick if active
        if self._joystick.is_active:
            await self._joystick.stop()

        # Cancel and await the active task
        await self._cancel_active_task()

        if self.state not in (SimulationState.IDLE, SimulationState.DISCONNECTED):
            self.state = SimulationState.IDLE
            await self._emit("state_change", {"state": self.state.value})

        self._paused_from = None
        # Invalidate the replay snapshot — stop() is a user-intent terminator,
        # and a late-joining secondary shouldn't resurrect the dead action.
        self.snapshot = None
        logger.info("Simulation stopped")

    def get_status(self) -> SimulationStatus:
        """Build a snapshot of the current simulation status."""
        return SimulationStatus(
            state=self.state,
            current_position=self.current_position,
            progress=self.eta_tracker.progress,
            speed_mps=self._current_speed_mps,
            eta_seconds=self.eta_tracker.eta_seconds,
            eta_arrival=self.eta_tracker.eta_arrival,
            distance_remaining=self.eta_tracker.distance_remaining,
            distance_traveled=self.distance_traveled,
            lap_count=self.lap_count,
            segment_index=self.segment_index,
            total_segments=self.total_segments,
            is_paused=self.state == SimulationState.PAUSED,
        )

    # ── Internal helpers ─────────────────────────────────────

    async def _emit(self, event_type: str, data: dict) -> None:
        """Send an event to the WebSocket callback, if one is registered."""
        if self.event_callback is not None:
            try:
                await self.event_callback(event_type, data)
            except Exception:
                logger.exception("Event callback error for '%s'", event_type)

    async def _set_position(self, lat: float, lng: float) -> None:
        """Push a coordinate to the device and update internal state."""
        await self.location_service.set(lat, lng)
        self.current_position = Coordinate(lat=lat, lng=lng)
        self.last_push_at = time.monotonic()
        self.location_active = True

    async def reassert_position(self) -> bool:
        """Re-send the current position without touching engine state.

        Used by the WiFi keep-alive while the device would otherwise hear
        nothing (idle, user pause, pause between legs). Emits no events and
        leaves ``state`` alone, so a running mode resumes exactly where it
        was. Returns False when there is nothing simulated to re-send (no
        position yet, or real GPS was restored).
        """
        pos = self.current_position
        if pos is None or not self.location_active:
            return False
        await self.location_service.set(pos.lat, pos.lng)
        self.last_push_at = time.monotonic()
        return True

    def pick_speed_profile(
        self,
        profile_name: str,
        speed_kmh: float | None,
        speed_min_kmh: float | None,
        speed_max_kmh: float | None,
    ) -> "SpeedProfile":
        """Resolve the speed profile to use for the next leg/lap.

        Honors a mid-flight ``apply_speed`` (so the user-applied profile
        sticks across leg boundaries); otherwise re-picks from the call
        args so range mode varies per leg. Replaces the three near-
        identical helpers in route_loop / multi_stop / random_walk.
        """
        if self._speed_was_applied and self._active_speed_profile is not None:
            return dict(self._active_speed_profile)
        return resolve_speed_profile(
            profile_name, speed_kmh, speed_min_kmh, speed_max_kmh,
        )

    async def apply_speed(
        self,
        speed_profile: "SpeedProfile",
    ) -> bool:
        """Hot-swap the active speed profile. Works in two modes:

        * Route-based handlers (navigate / loop / multi-stop / random-walk):
          queue the profile; the running ``_move_along_route`` loop notices
          and re-interpolates the remaining coords from the current position.
        * Joystick mode: swap the joystick handler's own speed_profile so
          the next tick computes distance with the new value.

        * Between legs of a multi-leg mode (loop / multi-stop / random walk
          waiting out a pause): store it as the active profile for the
          next leg.

        Returns True if the change was queued/applied, False if nothing is
        running to apply it to.

        Held under ``_apply_speed_lock`` so concurrent /apply-speed
        requests are serialised. State is re-read after acquire because
        the engine may have stopped (or _move_along_route may have
        finalised, clearing _active_route_coords) while this caller was
        queued.
        """
        async with self._apply_speed_lock:
            if self.state in (SimulationState.IDLE, SimulationState.DISCONNECTED):
                return False
            # Joystick uses its own independent speed profile attribute.
            if self.state == SimulationState.JOYSTICK and self._joystick.is_active:
                self._joystick.speed_profile = dict(speed_profile)
                self._speed_was_applied = True
                return True
            if not self._active_route_coords:
                # Between legs — a pause countdown, a dwell at a stop, or the
                # moment before the next leg is planned. Nothing to
                # re-interpolate yet, but a multi-leg mode will read this via
                # pick_speed_profile when its next leg starts.
                running = self._paused_from if self.state == SimulationState.PAUSED else self.state
                if running not in _MULTI_LEG_STATES:
                    return False
                self._active_speed_profile = dict(speed_profile)
                self._speed_was_applied = True
                return True
            self._pending_speed_profile = dict(speed_profile)
            self._speed_was_applied = True
            return True

    async def _move_along_route(
        self,
        coords: list[Coordinate],
        speed_profile: "SpeedProfile",
    ) -> None:
        """Core movement loop shared by navigate, loop, multi-stop, and
        random walk modes.

        Thin delegate to :func:`core.movement_loop.move_along_route`; the
        algorithm itself lives in that module so the engine class stays
        focused on lifecycle / public-API concerns. The local import
        avoids a circular ``core.movement_loop`` ↔ ``core.simulation_engine``
        import at module load.
        """
        from core.movement_loop import move_along_route
        await move_along_route(self, coords, speed_profile)

    def is_busy(self) -> bool:
        """True while any action is live: a running state, a handler task
        still planning its route (state is IDLE until the route arrives),
        or the joystick loop."""
        if self.state not in (SimulationState.IDLE, SimulationState.DISCONNECTED):
            return True
        if self._active_task is not None and not self._active_task.done():
            return True
        return self._joystick.is_active

    async def _cancel_active_task(self) -> None:
        """Cancel the running handler task (if any) and wait for it."""
        task = self._active_task
        if task is None or task.done():
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        if self._active_task is task:
            self._active_task = None

    def _release_snapshot(self, snapshot: SimulationSnapshot) -> None:
        """Drop *snapshot* once its run is back at IDLE — unless a newer
        action has already installed its own."""
        if self.state == SimulationState.IDLE and self.snapshot is snapshot:
            self.snapshot = None

    async def _ensure_stopped(self) -> None:
        """Make sure no movement is active before starting a new one."""
        if self.is_busy():
            await self.stop()
        self._stop_event.clear()
        # Fresh session — let the next handler resolve speed from its own
        # request, not from a stale apply_speed from a previous session.
        self._speed_was_applied = False
        self._active_speed_profile = None
