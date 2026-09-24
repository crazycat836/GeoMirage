"""Characterization tests for SimulationEngine lifecycle invariants.

These pin the CURRENT behavior of core/simulation_engine.py:

* navigate / start_loop / stop / pause / resume state transitions and the
  ``state_change`` events they emit;
* the replay-snapshot contract (populated while a mode runs, None after
  stop() so a late-joining secondary device can't resurrect a dead action);
* handler crashes forcing the engine back to IDLE with an emitted idle
  ``state_change``;
* apply_speed's idle / joystick branches;
* RouteInterpolator.interpolate timing/segment output (pure function).

No production code is touched. Device access is faked with a no-op
LocationService recorder; routes use ``straight_line=True`` so OSRM is
never contacted. Distances are tiny and speeds high so route runs finish
in well under a second.
"""

from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))


# ── Fakes / helpers ──────────────────────────────────────────────────────

class FakeLocationService:
    """No-op LocationService double that records every pushed coordinate.

    Optionally records the engine's ``snapshot`` at each push so tests can
    observe mid-run state without racing the movement loop.
    """

    def __init__(self) -> None:
        self.calls: list[tuple[float, float]] = []
        self.engine = None  # set by tests that need mid-run observation
        self.snapshots_at_push: list = []

    async def set(self, lat: float, lng: float) -> None:
        self.calls.append((lat, lng))
        if self.engine is not None:
            self.snapshots_at_push.append(self.engine.snapshot)


class EventRecorder:
    """Captures every ``_emit`` as (event_type, data)."""

    def __init__(self) -> None:
        self.events: list[tuple[str, dict]] = []

    async def __call__(self, event_type: str, data: dict) -> None:
        self.events.append((event_type, data))

    def states(self) -> list[str]:
        return [d["state"] for t, d in self.events if t == "state_change"]


def _make_engine():
    """Build a SimulationEngine wired to a fake device and event recorder."""
    from core.simulation_engine import SimulationEngine

    service = FakeLocationService()
    recorder = EventRecorder()
    engine = SimulationEngine(service, event_callback=recorder)
    return engine, service, recorder


async def _wait_for(predicate, timeout: float = 2.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.005)
    raise AssertionError("condition not met within timeout")


# ── navigate: state transitions + events ────────────────────────────────

def test_navigate_transitions_navigating_then_idle_and_pushes_positions():
    from models.schemas import Coordinate, MovementMode, SimulationState

    async def scenario():
        engine, service, recorder = _make_engine()
        engine.current_position = Coordinate(lat=25.0, lng=121.5)
        # ~2 m east; 72 km/h => one tick of ~0.1 s wall time.
        dest = Coordinate(lat=25.0, lng=121.50002)

        await engine.navigate(
            dest, MovementMode.WALKING, speed_kmh=72.0, straight_line=True,
        )

        assert engine.state == SimulationState.IDLE
        assert recorder.states() == ["navigating", "idle"]
        # state_change for navigating carries the destination payload.
        nav_events = [d for t, d in recorder.events
                      if t == "state_change" and d["state"] == "navigating"]
        assert nav_events[0]["destination"] == {"lat": dest.lat, "lng": dest.lng}
        # Completion event fires before the idle state_change.
        event_types = [t for t, _ in recorder.events]
        assert "navigation_complete" in event_types
        assert event_types.index("navigation_complete") < len(event_types) - 1
        # The device received at least the interpolated start + final push.
        assert len(service.calls) >= 2

    asyncio.run(scenario())


def test_navigate_populates_snapshot_while_running_and_clears_after():
    from models.schemas import Coordinate, MovementMode

    async def scenario():
        engine, service, _ = _make_engine()
        service.engine = engine  # record engine.snapshot at every push
        engine.current_position = Coordinate(lat=25.0, lng=121.5)
        dest = Coordinate(lat=25.0, lng=121.50002)

        await engine.navigate(
            dest, MovementMode.WALKING, speed_kmh=72.0, straight_line=True,
        )

        # While positions were being pushed the snapshot described the run.
        assert service.snapshots_at_push, "no positions were pushed"
        for snap in service.snapshots_at_push:
            assert snap is not None
            assert snap.mode == "navigate"
            assert snap.movement_mode == "walking"
            assert snap.destination == {"lat": dest.lat, "lng": dest.lng}
        # Back at IDLE the snapshot is cleared.
        assert engine.snapshot is None

    asyncio.run(scenario())


# ── start_loop + stop: snapshot contract ─────────────────────────────────

def test_start_loop_sets_looping_state_and_snapshot_then_stop_clears_both():
    from models.schemas import Coordinate, MovementMode, SimulationState

    async def scenario():
        engine, service, recorder = _make_engine()
        engine.current_position = Coordinate(lat=25.0, lng=121.5)
        waypoints = [
            Coordinate(lat=25.0, lng=121.5),
            Coordinate(lat=25.0, lng=121.501),  # ~100 m, walking 3 m/s
        ]

        task = asyncio.create_task(engine.start_loop(
            waypoints, MovementMode.WALKING,
            pause_enabled=False, straight_line=True,
        ))
        await _wait_for(lambda: engine.state == SimulationState.LOOPING)

        # Mid-run: snapshot is populated for dual-device replay.
        assert engine.snapshot is not None
        assert engine.snapshot.mode == "loop"
        assert engine.snapshot.waypoints == [
            {"lat": 25.0, "lng": 121.5},
            {"lat": 25.0, "lng": 121.501},
        ]

        await engine.stop()
        await asyncio.wait_for(task, timeout=2.0)

        # stop() terminates user intent: state idle, snapshot invalidated.
        assert engine.state == SimulationState.IDLE
        assert engine.snapshot is None
        assert recorder.states() == ["looping", "idle"]
        assert engine._active_task is None

    asyncio.run(scenario())


# ── pause / resume ────────────────────────────────────────────────────────

def test_pause_and_resume_round_trip_emits_paused_from():
    from models.schemas import Coordinate, MovementMode, SimulationState

    async def scenario():
        engine, _, recorder = _make_engine()
        engine.current_position = Coordinate(lat=25.0, lng=121.5)
        waypoints = [
            Coordinate(lat=25.0, lng=121.5),
            Coordinate(lat=25.0, lng=121.501),
        ]

        task = asyncio.create_task(engine.start_loop(
            waypoints, MovementMode.WALKING,
            pause_enabled=False, straight_line=True,
        ))
        await _wait_for(lambda: engine.state == SimulationState.LOOPING)

        await engine.pause()
        assert engine.state == SimulationState.PAUSED
        assert not engine._pause_event.is_set()
        paused_events = [d for t, d in recorder.events
                         if t == "state_change" and d["state"] == "paused"]
        assert paused_events[0]["paused_from"] == "looping"

        # Pausing again is a no-op (no duplicate event).
        await engine.pause()
        assert recorder.states().count("paused") == 1

        await engine.resume()
        assert engine.state == SimulationState.LOOPING
        assert engine._pause_event.is_set()
        assert engine._paused_from is None

        await engine.stop()
        await asyncio.wait_for(task, timeout=2.0)
        assert recorder.states() == ["looping", "paused", "looping", "idle"]

    asyncio.run(scenario())


def test_pause_is_noop_when_idle():
    from models.schemas import SimulationState

    async def scenario():
        engine, _, recorder = _make_engine()

        await engine.pause()

        assert engine.state == SimulationState.IDLE
        assert recorder.events == []
        assert engine._pause_event.is_set()

    asyncio.run(scenario())


def test_resume_is_noop_when_not_paused():
    from models.schemas import SimulationState

    async def scenario():
        engine, _, recorder = _make_engine()

        await engine.resume()

        assert engine.state == SimulationState.IDLE
        assert recorder.events == []

    asyncio.run(scenario())


# ── handler crash → forced IDLE ──────────────────────────────────────────

def test_handler_crash_forces_idle_and_emits_idle_state_change():
    from models.schemas import Coordinate, MovementMode, SimulationState

    async def scenario():
        engine, _, recorder = _make_engine()
        engine.current_position = Coordinate(lat=25.0, lng=121.5)
        dest = Coordinate(lat=25.0, lng=121.50002)

        async def boom(coords, speed_profile):
            raise ValueError("simulated handler crash")

        # Crash after the navigator has flipped state to NAVIGATING.
        engine._move_along_route = boom

        # The crash is swallowed by _run_handler (only DeviceLostError
        # re-raises), so navigate() returns normally.
        await engine.navigate(
            dest, MovementMode.WALKING, speed_kmh=72.0, straight_line=True,
        )

        assert engine.state == SimulationState.IDLE
        assert recorder.states() == ["navigating", "idle"]
        assert engine._active_task is None
        # The finally block clears the snapshot once back at IDLE.
        assert engine.snapshot is None

    asyncio.run(scenario())


# ── apply_speed ───────────────────────────────────────────────────────────

def test_apply_speed_returns_false_when_idle():
    async def scenario():
        engine, _, _ = _make_engine()
        profile = {"speed_mps": 7.0, "jitter": 0.3, "update_interval": 1.0}

        result = await engine.apply_speed(profile)

        assert result is False
        assert engine._speed_was_applied is False
        assert engine._pending_speed_profile is None

    asyncio.run(scenario())


def test_apply_speed_swaps_joystick_profile_when_joystick_active():
    from models.schemas import SimulationState

    async def scenario():
        engine, _, _ = _make_engine()
        engine.state = SimulationState.JOYSTICK
        engine._joystick.is_active = True
        profile = {"speed_mps": 7.0, "jitter": 0.3, "update_interval": 1.0}

        result = await engine.apply_speed(profile)

        assert result is True
        assert engine._speed_was_applied is True
        # The joystick handler gets a copy, not the caller's dict.
        assert engine._joystick.speed_profile == profile
        assert engine._joystick.speed_profile is not profile
        # The route hot-swap path is NOT used for joystick.
        assert engine._pending_speed_profile is None

    asyncio.run(scenario())


# ── RouteInterpolator.interpolate (pure function) ─────────────────────────

def test_interpolate_two_point_route_produces_evenly_timed_points():
    from models.schemas import Coordinate
    from services.interpolator import RouteInterpolator

    a = Coordinate(lat=0.0, lng=0.0)
    b = Coordinate(lat=0.0, lng=0.001)  # ~111 m due east on the equator
    speed_mps, interval = 20.0, 1.0
    dist = RouteInterpolator.haversine(a.lat, a.lng, b.lat, b.lng)
    full_steps = int(dist // (speed_mps * interval))  # 5 for ~111 m

    points = RouteInterpolator.interpolate([a, b], speed_mps, interval)

    # Seed point + N full-step points + appended final waypoint.
    assert len(points) == 1 + full_steps + 1
    assert points[0] == {
        "lat": 0.0, "lng": 0.0, "timestamp_offset": 0.0,
        "bearing": pytest.approx(90.0, abs=0.01), "seg_idx": 0,
    }
    # Evenly timed full steps...
    for i in range(1, full_steps + 1):
        assert points[i]["timestamp_offset"] == pytest.approx(i * interval)
        assert points[i]["bearing"] == pytest.approx(90.0, abs=0.01)
        assert points[i]["seg_idx"] == 0
    # ...then the final waypoint exactly at b, with remainder timing.
    last = points[-1]
    assert last["lat"] == b.lat and last["lng"] == b.lng
    remainder = dist - full_steps * speed_mps * interval
    assert last["timestamp_offset"] == pytest.approx(
        full_steps * interval + remainder / speed_mps, rel=1e-6,
    )
    # Longitudes strictly increase toward the destination.
    lngs = [p["lng"] for p in points]
    assert lngs == sorted(lngs) and len(set(lngs)) == len(lngs)


def test_interpolate_three_point_route_carries_distance_across_segments():
    from models.schemas import Coordinate
    from services.interpolator import RouteInterpolator

    a = Coordinate(lat=0.0, lng=0.0)
    b = Coordinate(lat=0.0, lng=0.001)    # ~111 m east
    c = Coordinate(lat=0.0005, lng=0.001)  # then ~55 m north
    points = RouteInterpolator.interpolate([a, b, c], 20.0, 1.0)

    # Final waypoint is always included exactly.
    assert points[-1]["lat"] == c.lat and points[-1]["lng"] == c.lng

    # Timestamps strictly increase; every gap except the final remainder
    # equals the requested interval (the carry preserves cadence across
    # the segment boundary).
    offsets = [p["timestamp_offset"] for p in points]
    deltas = [y - x for x, y in zip(offsets, offsets[1:])]
    assert all(d > 0 for d in deltas)
    assert all(d == pytest.approx(1.0) for d in deltas[:-1])
    assert 0 < deltas[-1] < 1.0

    # Both segments are represented and seg_idx never goes backwards.
    seg_idxs = [p["seg_idx"] for p in points]
    assert seg_idxs == sorted(seg_idxs)
    assert set(seg_idxs) == {0, 1}

    # Bearings follow the active segment: ~90 deg east, then ~0 deg north
    # (the appended final point reuses the previous point's bearing).
    for p in points:
        expected = 90.0 if p["seg_idx"] == 0 else 0.0
        assert p["bearing"] == pytest.approx(expected, abs=0.01)


def _dense_polyline(seg_lengths_m, lat=25.0, lng=121.5):
    """Due-east polyline whose consecutive vertices are *seg_lengths_m* apart."""
    from models.schemas import Coordinate
    from services.interpolator import RouteInterpolator

    coords = [Coordinate(lat=lat, lng=lng)]
    for seg in seg_lengths_m:
        nlat, nlng = RouteInterpolator.move_point(coords[-1].lat, coords[-1].lng, 90.0, seg)
        coords.append(Coordinate(lat=nlat, lng=nlng))
    return coords


@pytest.mark.parametrize(
    "seg_lengths, speed_mps",
    [
        ([10.0] * 100, 16.67),          # 1 km, a vertex every 10 m, driving
        ([15.0] * 60, 3.0),             # vertex every 15 m, walking
        ([2.0 + (i * 7) % 29 for i in range(200)], 16.67),  # mixed 2-30 m segments
    ],
)
def test_interpolate_dense_polyline_keeps_step_distance_and_total_time(seg_lengths, speed_mps):
    from services.interpolator import RouteInterpolator

    coords = _dense_polyline(seg_lengths)
    points = RouteInterpolator.interpolate(coords, speed_mps, 1.0)

    total = sum(seg_lengths)
    assert points[-1]["timestamp_offset"] == pytest.approx(total / speed_mps, rel=0.05)

    # The polyline is a straight line, so straight-line distance between
    # consecutive points equals distance travelled along the route.
    steps = [
        RouteInterpolator.haversine(p["lat"], p["lng"], q["lat"], q["lng"])
        for p, q in zip(points, points[1:])
    ]
    assert max(steps[:-1]) <= speed_mps * 1.1
    assert min(steps[:-1]) >= speed_mps * 0.9
    assert steps[-1] <= speed_mps * 1.1


def test_interpolate_empty_and_single_point_routes():
    from models.schemas import Coordinate
    from services.interpolator import RouteInterpolator

    assert RouteInterpolator.interpolate([], 5.0, 1.0) == []

    only = Coordinate(lat=25.0, lng=121.5)
    points = RouteInterpolator.interpolate([only], 5.0, 1.0)
    assert points == [{
        "lat": 25.0, "lng": 121.5, "timestamp_offset": 0.0,
        "bearing": 0.0, "seg_idx": 0,
    }]
