"""``POST /api/device/{udid}/connect`` on a device that is already
connected and already has an engine must leave that engine alone.

The device list lets the user click the connected row. The route used to
run ``create_engine_with_rollback`` unconditionally, which stops the
existing engine (cancelling a running navigation / loop) and swaps in a
fresh idle one.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))


@pytest.fixture(autouse=True)
def _reset():
    from context import ctx
    from services import connection_state
    connection_state.reset_for_tests()
    saved = getattr(ctx, "app_state", None)
    yield
    ctx.app_state = saved
    connection_state.reset_for_tests()


def _install(*, connected: bool, engine) -> tuple[MagicMock, MagicMock]:
    from context import ctx

    dm = MagicMock()
    dm.connected_count = 1 if connected else 0
    dm.is_connected = MagicMock(return_value=connected)
    dm.connect = AsyncMock()

    app_state = MagicMock()
    app_state.device_manager = dm
    app_state.simulation_engines = {"u1": engine} if engine is not None else {}
    app_state.create_engine_for_device = AsyncMock()
    ctx.app_state = app_state
    return dm, app_state


def _connect():
    from api import device

    async def _run():
        with patch("services.connection_state.broadcast", new=AsyncMock()):
            return await device.connect_device("u1")

    return asyncio.run(_run())


def test_already_connected_with_engine_keeps_engine_running():
    engine = MagicMock()
    engine.stop = AsyncMock()
    dm, app_state = _install(connected=True, engine=engine)

    result = _connect()

    assert result == {"status": "already_connected", "udid": "u1"}
    engine.stop.assert_not_awaited()
    app_state.create_engine_for_device.assert_not_awaited()
    dm.connect.assert_not_awaited()
    assert app_state.simulation_engines["u1"] is engine


def test_connected_without_engine_still_builds_one():
    """Transport up but no engine (e.g. an earlier engine build failed):
    connect must still create the engine."""
    dm, app_state = _install(connected=True, engine=None)

    with patch(
        "services.connection_state.create_engine_with_rollback", new=AsyncMock(),
    ) as create:
        result = _connect()

    assert result == {"status": "connected", "udid": "u1"}
    create.assert_awaited_once()
