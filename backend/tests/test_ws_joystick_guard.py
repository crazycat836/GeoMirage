"""Regression tests for the WS joystick frame guard.

Bug 2.4: ``websocket_endpoint`` built ``JoystickInput`` straight from
the raw frame. ``JoystickInput`` has strict bounds (direction 0–360,
intensity 0–1, sensitivity 0.1–2.0), so a single out-of-range or
non-numeric field raised ``pydantic.ValidationError`` which escaped to
the outer ``except Exception`` and terminated the receive loop — the
client lost all events until reconnect.

The contract pinned here: a malformed joystick frame is dropped and the
loop keeps processing subsequent frames.

Fake-websocket style mirrors ``test_websocket_initial_state.py``; async
is driven via ``asyncio.run`` (no pytest-asyncio in this repo).
"""

from __future__ import annotations

import asyncio
import json
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import WebSocketDisconnect

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))


class _StubCooldown:
    def get_status(self) -> dict[str, Any]:
        return {"active": False, "remaining_sec": 0}


class _StubAppState:
    """Just enough of AppState for websocket_endpoint to run.

    No ``device_manager`` attribute → the on-connect DVT probe is
    skipped, so the only behaviour under test is the receive loop.
    """

    def __init__(self, engines: dict[str, Any]) -> None:
        self.simulation_engines = engines
        self.cooldown_timer = _StubCooldown()

    def get_engine(self, udid: str) -> Any:
        return self.simulation_engines.get(udid)


@pytest.fixture(autouse=True)
def _clean_state(monkeypatch) -> Iterator[None]:
    """Disable WS auth + wipe shared stores so the endpoint runs
    deterministically against the stubs each test installs."""
    import auth
    from services import connection_state, disconnect_dedup

    monkeypatch.setattr(auth, "_is_auth_disabled", lambda: True)
    connection_state.reset_for_tests()
    disconnect_dedup.reset_for_tests()
    yield
    connection_state.reset_for_tests()
    disconnect_dedup.reset_for_tests()


def _make_scripted_ws(frames: list[str]) -> AsyncMock:
    """A WebSocket double that replays *frames* then disconnects."""
    ws = AsyncMock()
    ws.headers = {}  # no Origin: non-browser client, passes the dev-mode check
    ws.send_text = AsyncMock()
    queue = list(frames)

    async def _receive_text() -> str:
        if queue:
            return queue.pop(0)
        raise WebSocketDisconnect(code=1000)

    ws.receive_text = _receive_text
    return ws


def _run_endpoint_with_frames(monkeypatch, frames: list[str]) -> MagicMock:
    """Install a single fake engine, run the endpoint over *frames*,
    and return the engine mock for assertions."""
    from api.websocket import websocket_endpoint
    from context import ctx

    engine = MagicMock()
    engine.joystick_move = MagicMock()
    engine.joystick_stop = AsyncMock()
    monkeypatch.setattr(
        ctx, "app_state", _StubAppState({"udid-A": engine}), raising=False,
    )

    ws = _make_scripted_ws(frames)
    asyncio.run(websocket_endpoint(ws))
    return engine


def _joystick_frame(direction: Any, intensity: Any = 0.5) -> str:
    return json.dumps({
        "type": "joystick_input",
        "data": {"direction": direction, "intensity": intensity},
    })


def test_out_of_bounds_direction_does_not_kill_loop(monkeypatch):
    """direction=999 violates the 0–360 bound → frame must be dropped
    and the following valid frame still dispatched."""
    engine = _run_endpoint_with_frames(monkeypatch, [
        _joystick_frame(direction=999),       # malformed — must be dropped
        _joystick_frame(direction=90, intensity=1.0),  # must still arrive
    ])

    assert engine.joystick_move.call_count == 1
    dispatched = engine.joystick_move.call_args.args[0]
    assert dispatched.direction == 90
    assert dispatched.intensity == 1.0


def test_non_numeric_direction_does_not_kill_loop(monkeypatch):
    """A non-numeric field (string direction) must also be dropped
    without terminating the receive loop."""
    engine = _run_endpoint_with_frames(monkeypatch, [
        _joystick_frame(direction="north"),   # malformed — must be dropped
        _joystick_frame(direction=180, intensity=0.25),
    ])

    assert engine.joystick_move.call_count == 1
    assert engine.joystick_move.call_args.args[0].direction == 180


def test_valid_frames_all_dispatch(monkeypatch):
    """Negative control: the guard must not drop well-formed frames."""
    engine = _run_endpoint_with_frames(monkeypatch, [
        _joystick_frame(direction=0, intensity=0.1),
        _joystick_frame(direction=360, intensity=1.0),
    ])

    assert engine.joystick_move.call_count == 2
