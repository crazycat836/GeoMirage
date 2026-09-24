"""Route-planning failures must abort the run — never straight-line.

When RouteService raises :class:`RouteUnavailableError`, the engine has
to (1) come back to IDLE so the UI isn't stuck in a running state and
(2) re-raise the error so ``api.location._helpers.spawn`` broadcasts it
as a ``device_error`` toast. Mirrors the DeviceLostError re-raise
contract in ``SimulationEngine._run_handler``.

Follows the project convention of ``asyncio.run`` inside sync pytest
functions; device access uses the same fakes as
``test_simulation_engine.py``.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))


from services.route_service import RouteUnavailableError  # noqa: E402
from tests.test_simulation_engine import _make_engine as _make_base_engine  # noqa: E402


class UnavailableRouteService:
    """RouteService double whose every plan attempt fails."""

    async def _fail(self, *args, **kwargs):
        raise RouteUnavailableError("Route planning service unreachable")

    get_route = get_multi_route = _fail


def _make_engine():
    engine, _service, recorder = _make_base_engine()
    engine.route_service = UnavailableRouteService()
    return engine, recorder


def test_multi_stop_aborts_to_idle_and_reraises():
    from models.schemas import Coordinate, MovementMode, SimulationState

    async def scenario():
        engine, recorder = _make_engine()
        engine.current_position = Coordinate(lat=25.0, lng=121.5)
        wps = [Coordinate(lat=25.0, lng=121.5), Coordinate(lat=25.01, lng=121.51)]

        with pytest.raises(RouteUnavailableError):
            await engine.multi_stop(wps, MovementMode.WALKING)

        assert engine.state == SimulationState.IDLE
        # The forced idle transition reached the frontend.
        assert recorder.states()[-1] == "idle"

    asyncio.run(scenario())


def test_start_loop_aborts_to_idle_and_reraises():
    from models.schemas import Coordinate, MovementMode, SimulationState

    async def scenario():
        engine, _ = _make_engine()
        engine.current_position = Coordinate(lat=25.0, lng=121.5)
        wps = [Coordinate(lat=25.0, lng=121.5), Coordinate(lat=25.01, lng=121.51)]

        with pytest.raises(RouteUnavailableError):
            await engine.start_loop(wps, MovementMode.WALKING)

        assert engine.state == SimulationState.IDLE

    asyncio.run(scenario())


def test_navigate_aborts_to_idle_and_reraises():
    from models.schemas import Coordinate, MovementMode, SimulationState

    async def scenario():
        engine, _ = _make_engine()
        engine.current_position = Coordinate(lat=25.0, lng=121.5)

        with pytest.raises(RouteUnavailableError):
            await engine.navigate(
                Coordinate(lat=25.01, lng=121.51), MovementMode.WALKING,
            )

        assert engine.state == SimulationState.IDLE

    asyncio.run(scenario())


def test_random_walk_aborts_when_the_route_service_is_unreachable():
    from models.schemas import Coordinate, MovementMode, SimulationState
    from services.route_service import RouteServiceUnreachableError

    class DownRouteService:
        async def get_route(self, *args, **kwargs):
            raise RouteServiceUnreachableError("Route planning service unreachable")

    async def scenario():
        engine, recorder = _make_engine()
        engine.route_service = DownRouteService()
        engine.current_position = Coordinate(lat=25.0, lng=121.5)

        with pytest.raises(RouteUnavailableError):
            await asyncio.wait_for(engine.random_walk(
                Coordinate(lat=25.0, lng=121.5), 50.0, MovementMode.WALKING,
                pause_enabled=False,
            ), timeout=2.0)

        assert engine.state == SimulationState.IDLE
        assert recorder.states()[-1] == "idle"
        assert "random_walk_complete" not in [t for t, _ in recorder.events]

    asyncio.run(scenario())


def test_random_walk_skips_a_destination_with_no_road_route(monkeypatch):
    import core.random_walk as rw
    from models.schemas import Coordinate, MovementMode, SimulationState
    from services.route_service import RouteService

    monkeypatch.setattr(rw, "_GENERIC_ERROR_BACKOFF_S", 0.0)

    class FirstLegNoRoute:
        def __init__(self):
            self.calls = 0
            self._inner = RouteService()

        async def get_route(self, *args, **kwargs):
            self.calls += 1
            if self.calls == 1:
                raise RouteUnavailableError("No road route between the two points")
            kwargs["force_straight"] = True
            return await self._inner.get_route(*args, **kwargs)

    async def scenario():
        engine, recorder = _make_engine()
        engine.route_service = FirstLegNoRoute()
        engine.pick_speed_profile = lambda *a, **k: {
            "speed_mps": 300.0, "jitter": 0.0, "update_interval": 0.01,
        }
        engine.current_position = Coordinate(lat=25.0, lng=121.5)

        walk = asyncio.create_task(engine.random_walk(
            Coordinate(lat=25.0, lng=121.5), 50.0, MovementMode.WALKING,
            pause_enabled=False, seed=1,
        ))
        deadline = asyncio.get_running_loop().time() + 2.0
        while not any(t == "random_walk_arrived" for t, _ in recorder.events):
            assert asyncio.get_running_loop().time() < deadline, "walk never arrived"
            await asyncio.sleep(0.01)
        await engine.stop()
        await asyncio.wait_for(walk, timeout=2.0)

        assert engine.route_service.calls >= 2
        assert engine.state == SimulationState.IDLE

    asyncio.run(scenario())
