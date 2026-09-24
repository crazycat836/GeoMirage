"""Characterization tests for ``core.movement_loop.move_along_route``.

These tests pin the CURRENT behaviour of the route-traversal loop — they
must not drive production changes. A real ``SimulationEngine`` is used
(with a fake ``LocationService`` whose ``set`` is a no-op recorder) so the
tests survive refactors of HOW the loop stores state while pinning WHAT it
does: emitted ``position_update`` / ``waypoint_progress`` events, distance
bookkeeping, hot-swap speed replanning, stop responsiveness, and the
waypoint-pass heuristics (WP_HARD_HIT_M / WP_NEAR_M / WP_RECEDE_M).

Routes are tiny (tens of meters) with high speeds and 10 ms update
intervals so the whole file runs in a few seconds of wall time.
"""

from __future__ import annotations

import asyncio
import math
import sys
import time
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from core.movement_loop import move_along_route  # noqa: E402
from core.simulation_engine import SimulationEngine  # noqa: E402
from models.schemas import Coordinate, SimulationState  # noqa: E402
from services.interpolator import RouteInterpolator  # noqa: E402

# Meters per degree of latitude on the haversine sphere (R = 6371 km).
_M_PER_DEG_LAT = math.pi * 6_371_000 / 180.0
_BASE_LAT = 25.0
_BASE_LNG = 121.5

# Polling cadence used while waiting for the loop to emit events.
_POLL_S = 0.002
_WAIT_TIMEOUT_S = 5.0


class FakeLocationService:
    """No-op LocationService recorder; ``set`` just stores the push."""

    def __init__(self) -> None:
        self.pushes: list[tuple[float, float]] = []

    async def set(self, lat: float, lng: float) -> None:
        self.pushes.append((lat, lng))


def _make_engine() -> tuple[SimulationEngine, list[tuple[str, dict]], FakeLocationService]:
    """Real engine + event recorder + fake device. Must be called inside a
    running event loop (asyncio primitives are created in __init__)."""
    events: list[tuple[str, dict]] = []

    async def record(event_type: str, data: dict) -> None:
        events.append((event_type, dict(data)))

    fake = FakeLocationService()
    engine = SimulationEngine(location_service=fake, event_callback=record)
    return engine, events, fake


def _lat_route(meters_marks: list[float]) -> list[Coordinate]:
    """Straight northbound route with points at the given meter offsets."""
    return [
        Coordinate(lat=_BASE_LAT + m / _M_PER_DEG_LAT, lng=_BASE_LNG)
        for m in meters_marks
    ]


def _offset_coord(north_m: float, east_m: float) -> Coordinate:
    lat = _BASE_LAT + north_m / _M_PER_DEG_LAT
    lng = _BASE_LNG + east_m / (_M_PER_DEG_LAT * math.cos(math.radians(_BASE_LAT)))
    return Coordinate(lat=lat, lng=lng)


def _profile(speed_mps: float, update_interval: float = 0.01) -> dict:
    # jitter=0 keeps emitted positions exactly on the interpolated line so
    # assertions are deterministic (add_jitter is a no-op for jitter <= 0).
    return {"speed_mps": speed_mps, "jitter": 0.0, "update_interval": update_interval}


def _position_updates(events: list[tuple[str, dict]]) -> list[dict]:
    return [data for etype, data in events if etype == "position_update"]


def _waypoint_events(events: list[tuple[str, dict]]) -> list[dict]:
    return [data for etype, data in events if etype == "waypoint_progress"]


async def _wait_until(predicate, timeout: float = _WAIT_TIMEOUT_S) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError("timed out waiting for loop condition")
        await asyncio.sleep(_POLL_S)


def _route_distance(coords: list[Coordinate]) -> float:
    total = 0.0
    for a, b in zip(coords, coords[1:]):
        total += RouteInterpolator.haversine(a.lat, a.lng, b.lat, b.lng)
    return total


# ── (a) straight route: distance bookkeeping + finalize ─────────────────


def test_straight_route_distance_traveled_monotonic_and_state_cleared():
    async def scenario():
        engine, events, fake = _make_engine()
        coords = _lat_route([0.0, 30.0, 60.0])  # 2 segments, 60 m total
        await move_along_route(engine, coords, _profile(300.0))  # 3 m / tick
        return engine, events, fake, coords

    engine, events, fake, coords = asyncio.run(scenario())

    updates = _position_updates(events)
    assert len(updates) >= 10  # ~20 ticks at 3 m steps over 60 m

    # The first emitted point is the route start, whose step distance from
    # itself is 0 — so the first update reports distance_traveled == 0.0.
    assert updates[0]["distance_traveled"] == 0.0

    traveled = [u["distance_traveled"] for u in updates]
    assert traveled == sorted(traveled)  # monotonically non-decreasing
    expected_total = _route_distance(coords)
    assert abs(traveled[-1] - expected_total) < 0.5

    # Every emitted update corresponds to exactly one device push.
    assert len(fake.pushes) == len(updates)
    assert abs(fake.pushes[-1][0] - coords[-1].lat) < 1e-9
    assert abs(fake.pushes[-1][1] - coords[-1].lng) < 1e-9

    # Finalize block: run ends with the hot-swap state cleared.
    assert engine._active_route_coords == []
    assert engine._pending_speed_profile is None
    assert engine._current_speed_mps == 0.0


def test_final_position_update_reports_completion():
    async def scenario():
        engine, events, _fake = _make_engine()
        coords = _lat_route([0.0, 40.0])
        await move_along_route(engine, coords, _profile(400.0))  # 4 m / tick
        return engine, events, coords

    engine, events, coords = asyncio.run(scenario())

    last = _position_updates(events)[-1]
    assert last["lat"] == coords[-1].lat
    assert last["lng"] == coords[-1].lng
    assert last["progress"] == 1.0
    assert last["distance_remaining"] == 0.0
    assert last["eta_seconds"] == 0.0
    assert last["speed_mps"] == 400.0
    assert engine.distance_remaining == 0.0
    assert engine.segment_index == engine.total_segments == 1


def test_empty_route_returns_without_finalizing_speed():
    """Surprising behaviour, pinned on purpose: with no coords the loop
    returns from inside the while (``if not timed_points: return``) and
    SKIPS the finalize block — so ``_current_speed_mps`` keeps the profile
    speed instead of being reset to 0.0."""

    async def scenario():
        engine, events, _fake = _make_engine()
        await move_along_route(engine, [], _profile(123.0))
        return engine, events

    engine, events = asyncio.run(scenario())

    assert _position_updates(events) == []
    assert engine._active_route_coords == []
    assert engine._current_speed_mps == 123.0  # NOT reset to 0.0


# ── (b) apply_speed mid-route: replan + second-swap slicing ──────────────


def test_apply_speed_mid_route_replans_and_second_swap_slices_new_plan():
    async def scenario():
        engine, events, _fake = _make_engine()
        # apply_speed requires a non-IDLE state (the real handlers set it
        # before calling the movement loop).
        engine.state = SimulationState.NAVIGATING
        coords = _lat_route([0.0, 30.0, 60.0, 90.0])

        task = asyncio.create_task(move_along_route(engine, coords, _profile(300.0)))

        def n_updates_at(speed: float) -> int:
            return sum(1 for u in _position_updates(events) if u["speed_mps"] == speed)

        await _wait_until(lambda: n_updates_at(300.0) >= 3)
        assert await engine.apply_speed(_profile(600.0)) is True

        # First swap commits the pending profile and replans from the
        # current position (_replan_for_speed_swap).
        await _wait_until(lambda: n_updates_at(600.0) >= 3)
        assert engine._active_speed_profile["speed_mps"] == 600.0
        assert engine._pending_speed_profile is None
        # The replanned coord list was re-rooted at the position the device
        # held at swap time: ahead of the route start (the swap happened
        # after >= 3 ticks) and at-or-behind the now-current position.
        replan_head = engine._active_route_coords[0]
        assert coords[0].lat < replan_head.lat <= engine.current_position.lat
        assert engine._active_route_coords[-1].lat == coords[-1].lat

        # Second swap must slice the NEW coord list (the bug guarded by the
        # comment in _replan_for_speed_swap) — otherwise the device would
        # jump back toward the leg's start.
        assert await engine.apply_speed(_profile(150.0)) is True
        await asyncio.wait_for(task, timeout=_WAIT_TIMEOUT_S)
        return engine, events, coords

    engine, events, coords = asyncio.run(scenario())

    updates = _position_updates(events)

    # Speed transitions arrive in order, never interleaved.
    speeds = [u["speed_mps"] for u in updates]
    deduped = [s for i, s in enumerate(speeds) if i == 0 or speeds[i - 1] != s]
    assert deduped == [300.0, 600.0, 150.0]

    # Northbound route: the device never moves backward, even across two
    # replans (a stale-list slice would emit a southward jump here).
    lats = [u["lat"] for u in updates]
    assert lats == sorted(lats)
    assert lats[-1] == coords[-1].lat

    # Distance accumulates across replans to (approximately) the full leg.
    assert abs(engine.distance_traveled - _route_distance(coords)) < 1.0

    assert engine._speed_was_applied is True
    assert engine._active_route_coords == []
    assert engine._pending_speed_profile is None
    assert engine._current_speed_mps == 0.0


# ── (c) stop event breaks the loop promptly ──────────────────────────────


def test_stop_event_mid_route_breaks_loop_promptly():
    async def scenario():
        engine, events, _fake = _make_engine()
        # Full route would take ~2 s (40 ticks * 50 ms); the stop must cut
        # that short.
        coords = _lat_route([0.0, 100.0, 200.0])
        task = asyncio.create_task(
            move_along_route(engine, coords, _profile(100.0, update_interval=0.05))
        )
        await _wait_until(lambda: len(_position_updates(events)) >= 3)
        stop_at = time.monotonic()
        engine._stop_event.set()
        await asyncio.wait_for(task, timeout=1.0)
        elapsed = time.monotonic() - stop_at
        return engine, events, elapsed

    engine, events, elapsed = asyncio.run(scenario())

    # The inter-tick sleep waits on the stop event itself, so the loop
    # exits within (roughly) one tick of the event being set.
    assert elapsed < 1.0
    assert len(_position_updates(events)) < 10  # far short of ~40 points

    # Finalize still runs after a stop.
    assert engine._active_route_coords == []
    assert engine._current_speed_mps == 0.0


# ── (d) waypoint-pass heuristics ─────────────────────────────────────────


def test_user_waypoints_hard_hit_emits_waypoint_progress():
    """WP_HARD_HIT_M: passing within 15 m of a user waypoint advances it."""

    async def scenario():
        engine, events, _fake = _make_engine()
        coords = _lat_route([0.0, 30.0, 60.0])
        # User waypoints lie exactly on the route, > WP_HARD_HIT_M from
        # the start so neither is "hit" on the first tick.
        engine._user_waypoints = [coords[1], coords[2]]
        await move_along_route(engine, coords, _profile(300.0))
        return engine, events

    engine, events = asyncio.run(scenario())

    wps = _waypoint_events(events)
    # 1 initial announcement + 2 in-loop hard hits.
    assert [(w["current_index"], w["next_index"]) for w in wps] == [
        (0, 0),  # emitted before the first tick (announces the first target)
        (0, 1),  # waypoint 0 hit
        (1, 1),  # waypoint 1 hit; next_index clamps to len-1
    ]
    assert all(w["total"] == 2 for w in wps)
    assert engine._user_waypoint_next == 2


def test_user_waypoint_near_pass_recede_emits_waypoint_progress():
    """WP_NEAR_M / WP_RECEDE_M: a waypoint ~30 m abeam the route (never
    within the 15 m hard-hit radius) counts as passed once the running
    minimum distance has receded by > 12 m."""

    async def scenario():
        engine, events, _fake = _make_engine()
        coords = _lat_route([0.0, 40.0, 80.0])
        # 30 m east of the route's midpoint: min approach ~30 m (< 60 m
        # near threshold), receding past ~42 m flags it as passed.
        engine._user_waypoints = [_offset_coord(north_m=40.0, east_m=30.0)]
        await move_along_route(engine, coords, _profile(400.0))
        return engine, events

    engine, events = asyncio.run(scenario())

    wps = _waypoint_events(events)
    assert [(w["current_index"], w["next_index"], w["total"]) for w in wps] == [
        (0, 0, 1),  # initial announcement
        (0, 0, 1),  # recede-pass detection mid-route
    ]
    assert engine._user_waypoint_next == 1

    # The pass fired before the route ended (in-loop), not via the
    # post-loop force-advance: the last waypoint event precedes the last
    # position update in the event stream.
    last_wp_idx = max(i for i, (t, _) in enumerate(events) if t == "waypoint_progress")
    last_pos_idx = max(i for i, (t, _) in enumerate(events) if t == "position_update")
    assert last_wp_idx < last_pos_idx


def test_unreached_final_waypoint_is_force_advanced_after_route():
    """A waypoint the route never comes near (> WP_NEAR_M at all times) is
    still force-advanced once after a normal (non-stopped) completion, so
    the UI marks the destination reached. Pinned as-is: the waypoint is
    declared visited even though the device was never within 60 m of it."""

    async def scenario():
        engine, events, _fake = _make_engine()
        coords = _lat_route([0.0, 30.0])
        engine._user_waypoints = [_offset_coord(north_m=30.0, east_m=500.0)]
        await move_along_route(engine, coords, _profile(300.0))
        return engine, events

    engine, events = asyncio.run(scenario())

    wps = _waypoint_events(events)
    assert [(w["current_index"], w["next_index"], w["total"]) for w in wps] == [
        (0, 0, 1),  # initial announcement
        (0, 0, 1),  # post-loop force-advance
    ]
    assert engine._user_waypoint_next == 1

    # Force-advance happens AFTER the final position update.
    last_wp_idx = max(i for i, (t, _) in enumerate(events) if t == "waypoint_progress")
    last_pos_idx = max(i for i, (t, _) in enumerate(events) if t == "position_update")
    assert last_wp_idx > last_pos_idx


def test_stop_suppresses_waypoint_force_advance():
    """When the loop exits because of a stop, the post-loop force-advance
    is skipped — the pending waypoint stays unvisited."""

    async def scenario():
        engine, events, _fake = _make_engine()
        coords = _lat_route([0.0, 100.0, 200.0])
        engine._user_waypoints = [coords[-1]]
        task = asyncio.create_task(
            move_along_route(engine, coords, _profile(100.0, update_interval=0.05))
        )
        await _wait_until(lambda: len(_position_updates(events)) >= 2)
        engine._stop_event.set()
        await asyncio.wait_for(task, timeout=1.0)
        return engine, events

    engine, events = asyncio.run(scenario())

    # Only the initial announcement — no pass, no force-advance.
    assert len(_waypoint_events(events)) == 1
    assert engine._user_waypoint_next == 0


# ── (e) tick schedule absorbs push latency ──────────────────────────────


class SlowLocationService(FakeLocationService):
    """Each push takes ``delay_s`` of wall time, like a real device."""

    def __init__(self, delay_s: float) -> None:
        super().__init__()
        self.delay_s = delay_s
        self.push_times: list[float] = []

    async def set(self, lat: float, lng: float) -> None:
        await asyncio.sleep(self.delay_s)
        self.push_times.append(time.monotonic())
        await super().set(lat, lng)


def test_push_latency_does_not_slow_the_route_down():
    async def scenario():
        slow = SlowLocationService(delay_s=0.03)
        engine = SimulationEngine(location_service=slow, event_callback=None)
        # 10 m/s over 10 m, one tick every 0.1 s: nominal 1.0 s.
        coords = _lat_route([0.0, 10.0])
        points = RouteInterpolator.interpolate(coords, 10.0, 0.1)
        nominal = points[-1]["timestamp_offset"]
        await move_along_route(engine, coords, _profile(10.0, update_interval=0.1))
        # The first push lands at offset 0, so measure from its end.
        return nominal, slow.push_times[-1] - slow.push_times[0]

    nominal, elapsed = asyncio.run(scenario())
    assert abs(elapsed - nominal) / nominal < 0.05


def test_resume_after_pause_does_not_burst_to_catch_up():
    async def scenario():
        slow = SlowLocationService(delay_s=0.01)
        engine = SimulationEngine(location_service=slow, event_callback=None)
        coords = _lat_route([0.0, 10.0])
        task = asyncio.create_task(
            move_along_route(engine, coords, _profile(10.0, update_interval=0.1))
        )
        await _wait_until(lambda: len(slow.push_times) >= 3)
        engine._pause_event.clear()
        await asyncio.sleep(0.4)
        resumed_at = time.monotonic()
        engine._pause_event.set()
        await asyncio.wait_for(task, timeout=_WAIT_TIMEOUT_S)
        return [t for t in slow.push_times if t >= resumed_at]

    after = asyncio.run(scenario())
    gaps = [b - a for a, b in zip(after, after[1:])]
    assert gaps
    # Every tick after the resume keeps (roughly) the 0.1 s cadence.
    assert min(gaps) > 0.07


# ── (f) speed swap keeps progress and corners ───────────────────────────


def test_speed_swap_keeps_progress_from_going_backwards():
    async def scenario():
        engine, events, _fake = _make_engine()
        engine.state = SimulationState.NAVIGATING
        coords = _lat_route([0.0, 30.0, 60.0, 90.0])
        task = asyncio.create_task(move_along_route(engine, coords, _profile(300.0)))
        await _wait_until(lambda: len(_position_updates(events)) >= 10)
        assert await engine.apply_speed(_profile(600.0)) is True
        await asyncio.wait_for(task, timeout=_WAIT_TIMEOUT_S)
        return events

    events = asyncio.run(scenario())

    updates = _position_updates(events)
    assert {u["speed_mps"] for u in updates} == {300.0, 600.0}
    progress = [u["progress"] for u in updates]
    assert progress == sorted(progress)
    assert progress[-1] == 1.0


def test_speed_swap_replan_keeps_the_corner_after_the_last_pushed_point():
    from core.movement_loop import _replan_for_speed_swap

    async def scenario():
        engine, _events, _fake = _make_engine()
        a = _offset_coord(0.0, 0.0)
        corner = _offset_coord(30.0, 0.0)
        end = _offset_coord(30.0, 30.0)
        engine._active_route_coords = [a, corner, end]
        # Last pushed point sits on segment 0 (before the corner); the
        # first unpushed one is already past it on segment 1.
        pushed = _offset_coord(28.0, 0.0)
        engine.current_position = pushed
        timed_points = [
            {"lat": a.lat, "lng": a.lng, "seg_idx": 0},
            {"lat": pushed.lat, "lng": pushed.lng, "seg_idx": 0},
            {"lat": corner.lat, "lng": corner.lng + 1e-5, "seg_idx": 1},
        ]
        engine._pending_speed_profile = _profile(600.0)
        return _replan_for_speed_swap(engine, timed_points, 2), pushed, corner, end

    planned, pushed, corner, end = asyncio.run(scenario())
    assert planned == [pushed, corner, end]
