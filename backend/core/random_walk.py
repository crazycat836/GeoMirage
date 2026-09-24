"""Random walk handler -- wander randomly within a radius."""

from __future__ import annotations

import asyncio
import logging
import random

from pymobiledevice3.exceptions import ConnectionTerminatedError

from models.schemas import Coordinate, MovementMode, SimulationState, osrm_profile_for
from core.handler_common import (
    emit_route_path,
    fetch_route_coords,
    finish_mode,
    pause_with_countdown,
    random_pause_seconds,
)
from core.movement_loop import RoutePushFailedError
from services.interpolator import RouteInterpolator
from config import (
    DEFAULT_PAUSE_ENABLED,
    DEFAULT_PAUSE_MAX,
    DEFAULT_PAUSE_MIN,
)

logger = logging.getLogger(__name__)


# Error budgets and reconnect backoff for the random-walk loop.
# Generic errors trip the limit fast; connection errors get a much higher
# budget so the walk can survive screen-lock / WiFi blips for ~30 minutes
# at the capped backoff.
_MAX_CONSECUTIVE_ERRORS = 5
_MAX_CONSECUTIVE_CONN_ERRORS = 60
_RECONNECT_BACKOFF_CAP_S = 30.0
# Connection-error backoff: exponential ramp capped at _RECONNECT_BACKOFF_CAP_S.
# Sleep = min(_CONN_BACKOFF_BASE_S * 2**capped(n-1), cap).
_CONN_BACKOFF_BASE_S = 5.0
_CONN_BACKOFF_EXP_CAP = 5
_GENERIC_ERROR_BACKOFF_S = 1.0
_SHORT_ROUTE_RETRY_S = 0.5
_MIN_LEG_COORDS = 2


# Sentinel return values from _run_leg signal intent to the outer loop.
_LEG_OK = "ok"
_LEG_RETRY = "retry"             # short route, try a new destination immediately
_LEG_BREAK = "break"             # fatal — stop the walk
_LEG_CONN_ERROR = "conn_error"
_LEG_GENERIC_ERROR = "generic_error"


class RandomWalkHandler:
    """Picks random destinations within a radius, routes to them,
    pauses briefly, then picks another destination. Repeats until stopped."""

    def __init__(self, engine):
        self.engine = engine

    async def start(
        self,
        center: Coordinate,
        radius_m: float,
        mode: MovementMode,
        *,
        speed_kmh: float | None = None,
        speed_min_kmh: float | None = None,
        speed_max_kmh: float | None = None,
        pause_enabled: bool = DEFAULT_PAUSE_ENABLED,
        pause_min: float = DEFAULT_PAUSE_MIN,
        pause_max: float = DEFAULT_PAUSE_MAX,
        seed: int | None = None,
        straight_line: bool = False,
    ) -> None:
        """Begin a random walk around *center* within *radius_m*.

        Parameters
        ----------
        center
            Centre point of the random walk area.
        radius_m
            Maximum distance from centre (meters).
        mode
            Movement speed profile.
        pause_enabled
            Whether to pause at each random destination (True by default).
        pause_min, pause_max
            When pause_enabled is True, pause for a random duration in this range.
        """
        engine = self.engine

        if engine.current_position is None:
            raise RuntimeError(
                "Cannot start random walk: no current position. Teleport first."
            )

        profile_name = mode.value
        osrm_profile = osrm_profile_for(mode)

        engine.state = SimulationState.RANDOM_WALK
        engine.distance_traveled = 0.0
        engine.lap_count = 0

        await engine._emit("state_change", {
            "state": engine.state.value,
            "center": {"lat": center.lat, "lng": center.lng},
            "radius_m": radius_m,
        })

        logger.info(
            "Random walk started: center=(%.6f,%.6f), radius=%.0fm [%s]",
            center.lat, center.lng, radius_m, profile_name,
        )

        walk_count = 0
        consecutive_errors = 0
        consecutive_conn_errors = 0

        # Seeded RNG for group-mode sync: both devices pass the same seed from
        # the frontend and therefore pick the exact same sequence of
        # destinations. Unseeded → use the global random for a fresh walk.
        rng: random.Random | None = random.Random(seed) if seed is not None else None

        while not engine._stop_event.is_set():
            dest_lat, dest_lng = RouteInterpolator.random_point_in_radius(
                center.lat, center.lng, radius_m, rng=rng,
            )

            current = engine.current_position
            if current is None:
                logger.warning("Random walk: no current position, stopping")
                break

            logger.info(
                "Random walk leg %d: (%.6f, %.6f) → (%.6f, %.6f)",
                walk_count + 1, current.lat, current.lng, dest_lat, dest_lng,
            )

            outcome = await self._run_leg(
                current, dest_lat, dest_lng,
                osrm_profile, straight_line,
                profile_name, speed_kmh, speed_min_kmh, speed_max_kmh,
                walk_count,
            )

            if outcome == _LEG_OK:
                consecutive_errors = 0
                consecutive_conn_errors = 0
            elif outcome == _LEG_RETRY:
                await asyncio.sleep(_SHORT_ROUTE_RETRY_S)
                continue
            elif outcome == _LEG_CONN_ERROR:
                consecutive_conn_errors += 1
                if await self._handle_connection_error(
                    walk_count, consecutive_conn_errors,
                ):
                    break
                continue
            elif outcome == _LEG_GENERIC_ERROR:
                consecutive_errors += 1
                if consecutive_errors >= _MAX_CONSECUTIVE_ERRORS:
                    logger.error(
                        "Random walk: too many consecutive errors (%d), stopping",
                        consecutive_errors,
                    )
                    break
                await asyncio.sleep(_GENERIC_ERROR_BACKOFF_S)
                continue

            if engine._stop_event.is_set():
                break

            walk_count += 1
            engine.lap_count = walk_count

            await engine._emit("random_walk_arrived", {
                "count": walk_count,
                "lat": dest_lat,
                "lng": dest_lng,
            })

            logger.info("Random walk arrived at destination %d", walk_count)

            if await self._pause_after_arrival(
                pause_enabled, pause_min, pause_max, rng,
            ):
                break

        # Ensure state returns to IDLE when random walk ends
        await finish_mode(
            engine, (SimulationState.RANDOM_WALK, SimulationState.PAUSED),
            "random_walk_complete",
            {"destinations_visited": walk_count},
        )

        logger.info("Random walk finished after %d destinations", walk_count)

    async def _run_leg(
        self,
        current: Coordinate,
        dest_lat: float,
        dest_lng: float,
        osrm_profile: str,
        straight_line: bool,
        profile_name: str,
        speed_kmh: float | None,
        speed_min_kmh: float | None,
        speed_max_kmh: float | None,
        walk_count: int,
    ) -> str:
        """Fetch the OSRM route to (dest_lat, dest_lng) and traverse it.

        Returns one of the _LEG_* sentinels so the outer loop can advance
        counters and decide whether to retry, sleep, or stop.
        """
        engine = self.engine
        try:
            coords, route_data = await fetch_route_coords(
                engine.route_service,
                current.lat, current.lng,
                dest_lat, dest_lng,
                profile=osrm_profile,
                straight=straight_line,
            )
            engine.distance_remaining = route_data["distance"]

            if len(coords) < _MIN_LEG_COORDS:
                logger.debug(
                    "Random walk: route too short (%d points), picking new destination",
                    len(coords),
                )
                return _LEG_RETRY

            await emit_route_path(engine, coords)
            speed_profile = self._pick_speed_profile(
                profile_name, speed_kmh, speed_min_kmh, speed_max_kmh,
            )
            # Random walk has no named waypoints — disable highlight
            engine._user_waypoints = []
            engine._user_waypoint_next = 0
            await engine._move_along_route(coords, speed_profile)
            return _LEG_OK
        except (asyncio.CancelledError, RoutePushFailedError):
            # A leg the device refused to follow ends the walk with an
            # error rather than counting as one more retryable failure.
            raise
        except (ConnectionTerminatedError, ConnectionError, OSError) as exc:
            # Full context (backoff, retry counts) logged inside
            # _handle_connection_error so the warning has all the numbers.
            logger.debug(
                "Random walk leg %d connection-class error (%s)",
                walk_count + 1, exc.__class__.__name__,
            )
            return _LEG_CONN_ERROR
        except Exception:
            logger.warning(
                "Random walk leg %d failed", walk_count + 1, exc_info=True,
            )
            return _LEG_GENERIC_ERROR

    def _pick_speed_profile(
        self,
        profile_name: str,
        speed_kmh: float | None,
        speed_min_kmh: float | None,
        speed_max_kmh: float | None,
    ) -> dict:
        """Honor mid-flight apply_speed; otherwise re-pick per leg."""
        return self.engine.pick_speed_profile(
            profile_name, speed_kmh, speed_min_kmh, speed_max_kmh,
        )

    async def _handle_connection_error(
        self,
        walk_count: int,
        consecutive_conn_errors: int,
    ) -> bool:
        """Apply exponential backoff after a connection-class error.

        Returns True if the budget is exhausted and the caller should
        break the outer loop (or if the user requested stop during the
        backoff sleep).
        """
        engine = self.engine
        backoff = min(
            _CONN_BACKOFF_BASE_S * (2 ** min(consecutive_conn_errors - 1, _CONN_BACKOFF_EXP_CAP)),
            _RECONNECT_BACKOFF_CAP_S,
        )
        logger.warning(
            "Random walk leg %d: connection lost, retry %d/%d in %.0fs",
            walk_count + 1,
            consecutive_conn_errors, _MAX_CONSECUTIVE_CONN_ERRORS,
            backoff,
        )
        if consecutive_conn_errors >= _MAX_CONSECUTIVE_CONN_ERRORS:
            logger.error(
                "Random walk: device unreachable after %d attempts, stopping",
                consecutive_conn_errors,
            )
            return True
        await engine._emit("connection_lost", {
            "retry": consecutive_conn_errors,
            "max_retries": _MAX_CONSECUTIVE_CONN_ERRORS,
            "next_retry_seconds": backoff,
        })
        try:
            await asyncio.wait_for(
                engine._stop_event.wait(), timeout=backoff,
            )
            return True  # User requested stop during wait
        except asyncio.TimeoutError:
            return False

    async def _pause_after_arrival(
        self,
        pause_enabled: bool,
        pause_min: float,
        pause_max: float,
        rng: random.Random | None,
    ) -> bool:
        """Optional random pause at a destination.

        Returns True if the user requested stop during the pause (so the
        outer loop should break).
        """
        if not pause_enabled:
            return False
        pause_duration = random_pause_seconds(pause_min, pause_max, rng)
        if pause_duration <= 0:
            return False
        logger.info("Random walk pausing for %.1fs before next leg", pause_duration)
        return await pause_with_countdown(self.engine, pause_duration, "random_walk")
