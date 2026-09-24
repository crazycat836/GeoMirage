"""Movement loop -- core route-traversal coroutine extracted from
SimulationEngine.

This module owns the long-running per-point loop that pushes interpolated
coordinates to the device. ``SimulationEngine._move_along_route`` is now a
thin wrapper around :func:`move_along_route` so the algorithm lives in a
single, independently readable file.

Behaviour parity with the original in-class implementation is critical:
every ``await asyncio.sleep`` / ``await self._stop_event.wait()`` /
``self._emit(...)`` call must keep its original ordering and arguments.
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

from models.schemas import Coordinate
from services.interpolator import RouteInterpolator
from services.location_service import DeviceLostError

if TYPE_CHECKING:
    from config import SpeedProfile
    from core.simulation_engine import SimulationEngine

logger = logging.getLogger(__name__)


# Linear backoff base for retrying a single position push after a transient
# ConnectionError / OSError. Sleep is `_RECONNECT_BACKOFF_BASE_S * (attempt + 1)`
# across the 3-attempt loop, so total worst-case stall is ~3.0s.
_RECONNECT_BACKOFF_BASE_S = 0.5
_PUSH_RETRY_ATTEMPTS = 3
_MIN_SPEED_FOR_ETA_MPS = 0.001


# Waypoint-pass detection thresholds (meters).
#
# OSRM snaps off-road taps onto the nearest road, so the routed polyline
# rarely passes within a strict radius of the user's literal click. These
# thresholds let move_along_route decide when a user-named waypoint counts
# as "visited" without needing pixel-perfect coincidence.
WP_HARD_HIT_M = 15.0   # within this radius, count it as a direct hit
WP_NEAR_M = 60.0       # got close enough to plausibly count as visiting
WP_RECEDE_M = 12.0     # how far past the running min before declaring passed


class RoutePushFailedError(RuntimeError):
    """The device kept rejecting position pushes, so the route was
    abandoned part-way. Distinct from a normal return so handlers never
    report an interrupted route as arrived; ``_run_handler`` re-raises it
    for the API layer to show as a ``device_error``."""


async def _push_position_with_retry(
    engine: "SimulationEngine", lat: float, lng: float,
) -> None:
    """Push a single (lat, lng) to the device with linear-backoff retries.

    Raises :class:`RoutePushFailedError` when the push never succeeds.
    ``DeviceLostError`` and ``CancelledError`` propagate unchanged so
    callers can stop the route cleanly.
    """
    last_exc: Exception | None = None
    for attempt in range(_PUSH_RETRY_ATTEMPTS):
        try:
            await engine._set_position(lat, lng)
            return
        except (ConnectionError, OSError) as exc:
            last_exc = exc
            logger.warning(
                "position push failed (attempt %d/%d): %s",
                attempt + 1, _PUSH_RETRY_ATTEMPTS, exc,
            )
            await asyncio.sleep(_RECONNECT_BACKOFF_BASE_S * (attempt + 1))
        except asyncio.CancelledError:
            raise
        except DeviceLostError:
            # Bubble up so api.location._spawn() can broadcast
            # device_disconnected. Silently swallowing here left
            # the frontend showing "connected" after a lost tunnel.
            raise
        except Exception as exc:
            logger.exception("Unexpected error pushing position")
            raise RoutePushFailedError(
                f"Could not update the device location: {exc}"
            ) from exc
    raise RoutePushFailedError(
        f"Could not update the device location after {_PUSH_RETRY_ATTEMPTS} attempts: {last_exc}"
    ) from last_exc


async def _emit_position_update(
    engine: "SimulationEngine",
    *,
    lat: float,
    lng: float,
    bearing: float,
    speed_mps: float,
    accumulated_distance: float,
    total_distance: float,
    idx: int,
) -> None:
    """Update tracking counters and emit a single ``position_update``."""
    engine.distance_remaining = max(total_distance - accumulated_distance, 0.0)
    engine.eta_tracker.update(accumulated_distance)
    engine.segment_index = min(idx, engine.total_segments)

    combined_remaining = engine.distance_remaining + engine._route_offset_remaining
    combined_eta = combined_remaining / max(speed_mps, _MIN_SPEED_FOR_ETA_MPS)

    await engine._emit("position_update", {
        "lat": lat,
        "lng": lng,
        "bearing": bearing,
        "speed_mps": speed_mps,
        "progress": engine.eta_tracker.progress,
        "distance_remaining": combined_remaining,
        "distance_traveled": engine.distance_traveled,
        "eta_seconds": combined_eta,
    })


async def _check_waypoint_progress(
    engine: "SimulationEngine",
    *,
    lat: float,
    lng: float,
    user_wps: list[Coordinate],
    wp_min_dist: float,
) -> float:
    """Detect when the device has passed the next user-named waypoint.

    Returns the (possibly reset) running minimum distance to the next
    waypoint. See WP_* constants above for the hit/pass heuristics.
    """
    if not user_wps or engine._user_waypoint_next >= len(user_wps):
        return wp_min_dist

    target = user_wps[engine._user_waypoint_next]
    d = RouteInterpolator.haversine(lat, lng, target.lat, target.lng)
    if d < wp_min_dist:
        wp_min_dist = d
    hit_close = d <= WP_HARD_HIT_M
    hit_passed = (
        wp_min_dist <= WP_NEAR_M
        and d > wp_min_dist + WP_RECEDE_M
    )
    if hit_close or hit_passed:
        engine._user_waypoint_next += 1
        wp_min_dist = float("inf")
        await engine._emit("waypoint_progress", {
            "current_index": engine._user_waypoint_next - 1,
            "next_index": min(engine._user_waypoint_next, len(user_wps) - 1),
            "total": len(user_wps),
        })
    return wp_min_dist


def _replan_for_speed_swap(
    engine: "SimulationEngine",
    timed_points: list[dict],
    cutoff_idx: int,
) -> list[Coordinate]:
    """Build a fresh planned-coords list starting from the current device
    position when ``apply_speed`` was called mid-route.

    Also commits the pending speed profile to ``_active_speed_profile`` and
    syncs ``_active_route_coords`` so a subsequent ``apply_speed`` slices
    against the right list.
    """
    # The device sits at the last *pushed* point, so the remaining route
    # starts after that point's segment. Slicing by the first unpushed
    # point's segment would skip a vertex whenever the two straddle one.
    cutoff_seg = timed_points[max(cutoff_idx - 1, 0)].get("seg_idx", 0)
    tail_waypoints = engine._active_route_coords[cutoff_seg + 1:]
    cur_pos = engine.current_position
    if cur_pos is not None and tail_waypoints:
        planned_coords = [Coordinate(lat=cur_pos.lat, lng=cur_pos.lng)] + list(tail_waypoints)
    else:
        # Nothing ahead — just let the loop exit naturally.
        planned_coords = []

    engine._active_speed_profile = engine._pending_speed_profile
    engine._pending_speed_profile = None
    # Critical: also sync _active_route_coords to the new plan so
    # a *subsequent* apply_speed slices against the right list.
    # Otherwise the next cutoff_seg (relative to the now-shorter
    # planned_coords) would index back into the original full leg
    # and the device would jump back toward the leg's start.
    engine._active_route_coords = list(planned_coords)
    logger.info(
        "Hot-swapped speed to %.2f m/s; replanning %d remaining waypoints (cur=%s, cutoff_seg=%d)",
        engine._active_speed_profile["speed_mps"],
        len(planned_coords),
        f"{cur_pos.lat:.6f},{cur_pos.lng:.6f}" if cur_pos else "None",
        cutoff_seg,
    )
    return planned_coords


async def move_along_route(
    engine: "SimulationEngine",
    coords: list[Coordinate],
    speed_profile: "SpeedProfile",
) -> None:
    """Core movement loop shared by navigate, loop, multi-stop, and
    random walk modes.

    1. Interpolates the route into evenly-timed points.
    2. Iterates through each point, updating the device position.
    3. Respects pause/stop events between each step.
    4. Tracks distance, ETA, and emits position updates.

    Parameters
    ----------
    engine
        The owning :class:`SimulationEngine`. The loop reaches through
        this for shared mutable state (``_stop_event``, ``eta_tracker``,
        ``current_position`` etc.) so handlers can observe / mutate it
        between successive ``move_along_route`` calls.
    coords
        Ordered list of route coordinates.
    speed_profile
        Dict with keys ``speed_mps``, ``jitter``, ``update_interval``.
    """
    # Expose these as instance state so apply_speed can read/swap them
    # mid-flight without racing the handler's local variables.
    engine._active_route_coords = list(coords)
    engine._active_speed_profile = dict(speed_profile)
    engine._pending_speed_profile = None
    engine.total_segments = max(len(coords) - 1, 0)

    # Outer loop: each iteration plans a fresh interpolation of the
    # remaining route. Re-entered on apply_speed to absorb a new speed.
    planned_coords = engine._active_route_coords

    # Waypoint-progress detection runs against the user's named
    # waypoints (set by the calling handler), not the OSRM-densified
    # polyline points. The next-target index lives on the engine so
    # multi-leg handlers (multi_stop, loop) can persist progress
    # across consecutive move_along_route calls.
    user_wps = list(engine._user_waypoints)
    wp_min_dist = float("inf")
    push_error: RoutePushFailedError | None = None
    # Distance covered by earlier plans of this route (before a speed
    # swap re-planned the rest), so progress keeps counting from there.
    distance_offset = 0.0
    if user_wps:
        await engine._emit("waypoint_progress", {
            "current_index": max(engine._user_waypoint_next - 1, 0),
            "next_index": min(engine._user_waypoint_next, len(user_wps) - 1),
            "total": len(user_wps),
        })

    while True:
        speed_mps = engine._active_speed_profile["speed_mps"]
        jitter = engine._active_speed_profile.get("jitter", 0.3)
        update_interval = engine._active_speed_profile.get("update_interval", 1.0)

        engine._current_speed_mps = speed_mps

        # Total distance of the planned coord list
        total_distance = 0.0
        for i in range(len(planned_coords) - 1):
            total_distance += RouteInterpolator.haversine(
                planned_coords[i].lat, planned_coords[i].lng,
                planned_coords[i + 1].lat, planned_coords[i + 1].lng,
            )

        engine.eta_tracker.start(distance_offset + total_distance, speed_mps)
        engine.eta_tracker.update(distance_offset)
        engine.distance_remaining = total_distance

        timed_points = RouteInterpolator.interpolate(
            planned_coords, speed_mps, update_interval,
        )

        if not timed_points:
            return

        accumulated_distance = 0.0
        prev_lat = timed_points[0]["lat"]
        prev_lng = timed_points[0]["lng"]

        reinterpolate_from_point: int | None = None

        # Ticks are scheduled against this plan's start time, so the time
        # spent pushing and emitting comes out of each wait instead of
        # adding to it.
        clock = asyncio.get_running_loop()
        plan_start = clock.time()

        for idx, point in enumerate(timed_points):
            # ── Check stop ──
            if engine._stop_event.is_set():
                logger.debug("Stop event detected at point %d/%d", idx, len(timed_points))
                break

            # ── Check pause ──
            if not engine._pause_event.is_set():
                logger.debug("Paused at point %d/%d", idx, len(timed_points))
                paused_at = clock.time()
                await engine._pause_event.wait()
                # Shift the schedule by the pause so resuming doesn't
                # fire the skipped ticks back to back.
                plan_start += clock.time() - paused_at
                if engine._stop_event.is_set():
                    break

            # ── Check hot-swap speed ──
            if engine._pending_speed_profile is not None:
                reinterpolate_from_point = idx
                break

            lat = point["lat"]
            lng = point["lng"]
            bearing = point.get("bearing", 0.0)

            # Calculate distance from previous point
            step_dist = RouteInterpolator.haversine(prev_lat, prev_lng, lat, lng)
            accumulated_distance += step_dist

            # Add GPS jitter for realism
            jittered_lat, jittered_lng = RouteInterpolator.add_jitter(lat, lng, jitter)

            try:
                await _push_position_with_retry(engine, jittered_lat, jittered_lng)
            except RoutePushFailedError as exc:
                logger.error("Giving up on this route after repeated push failures")
                push_error = exc
                break

            engine.distance_traveled += step_dist
            await _emit_position_update(
                engine,
                lat=jittered_lat,
                lng=jittered_lng,
                bearing=bearing,
                speed_mps=speed_mps,
                accumulated_distance=distance_offset + accumulated_distance,
                total_distance=distance_offset + total_distance,
                idx=idx,
            )

            prev_lat, prev_lng = lat, lng

            wp_min_dist = await _check_waypoint_progress(
                engine,
                lat=jittered_lat,
                lng=jittered_lng,
                user_wps=user_wps,
                wp_min_dist=wp_min_dist,
            )

            # Wait for the next tick (unless this is the last point)
            if idx < len(timed_points) - 1:
                next_point = timed_points[idx + 1]
                wait_time = plan_start + next_point["timestamp_offset"] - clock.time()
                if wait_time < -update_interval:
                    # More than a tick behind (e.g. a push stalled on a
                    # reconnect): drop the debt rather than bursting
                    # several points out at once to catch up.
                    plan_start -= wait_time
                    wait_time = 0.0
                if wait_time > 0:
                    try:
                        await asyncio.wait_for(
                            engine._stop_event.wait(),
                            timeout=wait_time,
                        )
                        break
                    except asyncio.TimeoutError:
                        pass

        # Did we break out to re-interpolate with a new speed?
        if reinterpolate_from_point is not None and engine._pending_speed_profile is not None:
            planned_coords = _replan_for_speed_swap(
                engine, timed_points, reinterpolate_from_point,
            )
            distance_offset += accumulated_distance
            if planned_coords:
                continue  # outer while — build a fresh plan
        break  # outer while: done (stopped, completed, or push-failure)

    # If we exited the route normally without stopping but didn't quite
    # touch the final user waypoint (OSRM routing can end metres away
    # from a user-clicked point that's off-road), force-advance once so
    # the UI marks the leg's destination as reached instead of leaving
    # it stuck in "approaching" forever.
    if (
        user_wps
        and push_error is None
        and not engine._stop_event.is_set()
        and engine._user_waypoint_next < len(user_wps)
    ):
        engine._user_waypoint_next += 1
        await engine._emit("waypoint_progress", {
            "current_index": engine._user_waypoint_next - 1,
            "next_index": min(engine._user_waypoint_next, len(user_wps) - 1),
            "total": len(user_wps),
        })

    if engine._pending_speed_profile is not None:
        # apply_speed landed after the last point was pushed, too late to
        # re-plan this leg. Keep it for the next one instead of dropping it.
        engine._active_speed_profile = engine._pending_speed_profile
    engine._pending_speed_profile = None
    engine._active_route_coords = []
    engine._current_speed_mps = 0.0

    if push_error is not None:
        raise push_error
