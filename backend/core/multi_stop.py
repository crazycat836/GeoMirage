"""Multi-stop navigator -- sequential navigation through multiple waypoints."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from models.schemas import Coordinate, MovementMode, SimulationState, osrm_profile_for

if TYPE_CHECKING:
    from collections.abc import Callable
from config import (
    DEFAULT_PAUSE_ENABLED,
    DEFAULT_PAUSE_MAX,
    DEFAULT_PAUSE_MIN,
)
from core.handler_common import (
    fetch_route_coords,
    finish_mode,
    pause_with_countdown,
    random_pause_seconds,
)
from core.lap_limit import record_lap_and_check_limit
from utils.geo import haversine_m

logger = logging.getLogger(__name__)


# If the device is more than this far from the first waypoint when the
# multi-stop run begins, route there first so the leg sequence starts at
# the user-specified origin rather than the current GPS pin.
_FIRST_WAYPOINT_REACH_THRESHOLD_M = 50.0
_MIN_LEG_COORDS = 2


def _resolve_pause_seconds(
    stop_duration: float,
    pause_enabled: bool,
    pause_min: float,
    pause_max: float,
) -> float:
    """Pick the pause duration for a stop.

    Precedence: explicit ``stop_duration`` > per-mode random range when
    ``pause_enabled`` is True > no pause.
    """
    if stop_duration and stop_duration > 0:
        return float(stop_duration)
    if not pause_enabled:
        return 0.0
    return random_pause_seconds(pause_min, pause_max)


class MultiStopNavigator:
    """Navigate through a series of waypoints with optional pauses at each stop."""

    def __init__(self, engine):
        self.engine = engine

    async def start(
        self,
        waypoints: list[Coordinate],
        mode: MovementMode,
        stop_duration: float = 0,
        loop: bool = False,
        *,
        speed_kmh: float | None = None,
        speed_min_kmh: float | None = None,
        speed_max_kmh: float | None = None,
        pause_enabled: bool = DEFAULT_PAUSE_ENABLED,
        pause_min: float = DEFAULT_PAUSE_MIN,
        pause_max: float = DEFAULT_PAUSE_MAX,
        straight_line: bool = False,
        lap_count: int | None = None,
    ) -> None:
        """Navigate through *waypoints* one leg at a time.

        Parameters
        ----------
        waypoints
            Ordered list of stops to visit.
        mode
            Movement speed profile.
        stop_duration
            Seconds to pause at each intermediate stop (0 = no pause).
        loop
            If True, loop back to the start after reaching the last
            waypoint and repeat indefinitely.
        lap_count
            When ``loop=True`` and this is positive, stop after the given
            number of completed laps. ``None`` / ``0`` = unlimited (the
            pre-existing behaviour). Ignored when ``loop=False``.
        """
        engine = self.engine

        if len(waypoints) < 2:
            raise ValueError("At least 2 waypoints are required for multi-stop")

        if engine.current_position is None:
            raise RuntimeError(
                "Cannot start multi-stop: no current position. Teleport first."
            )

        profile_name = mode.value
        osrm_profile = osrm_profile_for(mode)

        def _pick_profile() -> dict:
            # Honor mid-flight apply_speed across legs / laps; otherwise
            # re-pick from the original args (so range mode varies).
            return engine.pick_speed_profile(
                profile_name, speed_kmh, speed_min_kmh, speed_max_kmh,
            )

        # In loop mode the circuit closes: each lap ends with a leg from
        # the last stop back to the first, so the next lap starts where
        # the device actually is.
        stops = list(waypoints) + [waypoints[0]] if loop else list(waypoints)

        engine.state = SimulationState.MULTI_STOP
        engine.total_segments = len(stops) - 1
        engine.segment_index = 0
        engine.lap_count = 0
        engine.distance_traveled = 0.0

        full_total_distance = await self._emit_full_route_preview(
            stops, osrm_profile, straight_line,
        )

        await engine._emit("state_change", {
            "state": engine.state.value,
            "waypoints": [{"lat": wp.lat, "lng": wp.lng} for wp in waypoints],
            "stop_duration": stop_duration,
            "loop": loop,
        })

        logger.info(
            "Multi-stop started: %d waypoints, stop=%ds, loop=%s [%s]",
            len(waypoints), stop_duration, loop, profile_name,
        )

        # Ensure we start from the first waypoint's location
        if await self._navigate_to_first_waypoint(
            waypoints[0], osrm_profile, straight_line, _pick_profile,
        ):
            return

        # Track the named user waypoints so highlight events refer to them
        # (otherwise OSRM densification would emit indices over road points).
        engine._user_waypoints = list(waypoints)
        engine._user_waypoint_next = 1  # we already start at waypoints[0]

        completed_distance = 0.0
        running = True
        while running and not engine._stop_event.is_set():
            # On each loop pass (only > 1 if loop=True) restart the highlight
            # at waypoint[1] so the UI re-highlights from the top.
            if loop and engine._user_waypoint_next >= len(waypoints):
                engine._user_waypoint_next = 1
                completed_distance = 0.0
            for i in range(len(stops) - 1):
                if engine._stop_event.is_set():
                    break

                engine.segment_index = i
                leg_distance = await self._run_leg(
                    stops, i, osrm_profile, straight_line,
                    _pick_profile, completed_distance, full_total_distance,
                )
                completed_distance += leg_distance
                engine._route_offset_remaining = 0.0

                if engine._stop_event.is_set():
                    break

                wp_b = stops[i + 1]
                await engine._emit("stop_reached", {
                    "index": (i + 1) % len(waypoints),
                    "total": len(waypoints),
                    "lat": wp_b.lat,
                    "lng": wp_b.lng,
                })

                # Last stop only pauses when looping back around.
                is_last = i == len(stops) - 2
                this_pause = _resolve_pause_seconds(
                    stop_duration, pause_enabled, pause_min, pause_max,
                )
                if this_pause > 0 and (not is_last or loop):
                    if await self._pause_at_stop(this_pause, i + 1):
                        break

            if not loop or engine._stop_event.is_set():
                running = False
            elif await record_lap_and_check_limit(
                engine, lap_count, kind="Multi-stop", logger=logger,
            ):
                running = False

        engine._route_offset_remaining = 0.0
        await finish_mode(
            engine, (SimulationState.MULTI_STOP,),
            "multi_stop_complete",
            {"laps": engine.lap_count},
        )

        logger.info("Multi-stop finished after %d laps", engine.lap_count)

    async def _emit_full_route_preview(
        self,
        waypoints: list[Coordinate],
        osrm_profile: str,
        straight_line: bool,
    ) -> float:
        """Pre-fetch and broadcast the full multi-leg polyline for display.

        Returns the full route distance (0.0 on failure).
        """
        engine = self.engine
        all_wp_tuples = [(wp.lat, wp.lng) for wp in waypoints]
        # Planning failures (RouteUnavailableError) propagate: if the full
        # route can't be planned the legs will fail the same way, so abort
        # the start instead of limping. Only the preview broadcast is
        # best-effort.
        full_route = await engine.route_service.get_multi_route(
            all_wp_tuples, profile=osrm_profile, force_straight=straight_line,
        )
        try:
            await engine._emit("route_path", {
                "coords": [{"lat": pt[0], "lng": pt[1]} for pt in full_route["coords"]],
            })
        except Exception:
            logger.warning("Failed to broadcast full multi-stop route preview")
        return float(full_route.get("distance") or 0.0)

    async def _navigate_to_first_waypoint(
        self,
        first: Coordinate,
        osrm_profile: str,
        straight_line: bool,
        pick_profile: Callable[[], dict],
    ) -> bool:
        """Route from current position to ``first`` if more than the
        reach threshold away. Returns True if the user stopped mid-route.
        """
        engine = self.engine
        start_pos = engine.current_position
        if self._quick_distance(start_pos, first) <= _FIRST_WAYPOINT_REACH_THRESHOLD_M:
            return False
        coords, _route_data = await fetch_route_coords(
            engine.route_service,
            start_pos.lat, start_pos.lng,
            first.lat, first.lng,
            profile=osrm_profile,
            straight=straight_line,
        )
        if len(coords) >= _MIN_LEG_COORDS:
            await engine._move_along_route(coords, pick_profile())
            if engine._stop_event.is_set():
                return True
        return False

    async def _run_leg(
        self,
        waypoints: list[Coordinate],
        i: int,
        osrm_profile: str,
        straight_line: bool,
        pick_profile: Callable[[], dict],
        completed_distance: float,
        full_total_distance: float,
    ) -> float:
        """Fetch the OSRM route for leg ``i`` and traverse it.

        Returns the leg's distance in meters so callers can advance
        ``completed_distance``.
        """
        engine = self.engine
        wp_a = waypoints[i]
        wp_b = waypoints[i + 1]

        logger.debug(
            "Multi-stop leg %d/%d: (%.6f,%.6f) -> (%.6f,%.6f)",
            i + 1, len(waypoints) - 1,
            wp_a.lat, wp_a.lng, wp_b.lat, wp_b.lng,
        )

        coords, route_data = await fetch_route_coords(
            engine.route_service,
            wp_a.lat, wp_a.lng,
            wp_b.lat, wp_b.lng,
            profile=osrm_profile,
            straight=straight_line,
        )
        leg_distance = float(route_data.get("distance") or 0.0)
        engine.distance_remaining = leg_distance

        if full_total_distance > 0:
            future_legs = max(full_total_distance - completed_distance - leg_distance, 0.0)
        else:
            future_legs = 0.0
        engine._route_offset_remaining = future_legs

        if len(coords) >= _MIN_LEG_COORDS:
            await engine._move_along_route(coords, pick_profile())

        return leg_distance

    async def _pause_at_stop(self, this_pause: float, stop_index: int) -> bool:
        """Pause for ``this_pause`` seconds at a stop, emitting countdown
        events on either side. Returns True if the user requested stop
        during the pause.
        """
        logger.info("Multi-stop: pausing %.1fs at stop %d", this_pause, stop_index)
        return await pause_with_countdown(self.engine, this_pause, "multi_stop")

    @staticmethod
    def _quick_distance(a: Coordinate, b: Coordinate) -> float:
        """Distance in meters between two coordinates."""
        return haversine_m(a.lat, a.lng, b.lat, b.lng)
