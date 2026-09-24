"""Tests for services.ws_broadcaster.broadcast.

A client whose send times out (or raises) is dropped from the fan-out
list. The socket itself must also be closed: otherwise its receive loop
keeps the connection open, the renderer never sees ``onclose`` and never
reconnects, and it silently stops receiving every later event.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from collections.abc import Iterator
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))


@pytest.fixture(autouse=True)
def _clean_connections(monkeypatch) -> Iterator[None]:
    from services import ws_broadcaster

    monkeypatch.setattr(ws_broadcaster, "_BROADCAST_PER_CLIENT_TIMEOUT_S", 0.01)
    ws_broadcaster._connections.clear()
    yield
    ws_broadcaster._connections.clear()


def _stalled_ws() -> AsyncMock:
    ws = AsyncMock()

    async def _hang(_msg: str) -> None:
        await asyncio.sleep(10)

    ws.send_text = _hang
    ws.close = AsyncMock()
    return ws


def _healthy_ws() -> AsyncMock:
    ws = AsyncMock()
    ws.send_text = AsyncMock()
    ws.close = AsyncMock()
    return ws


async def _broadcast_and_settle(event_type: str, data: dict) -> None:
    from services import ws_broadcaster

    await ws_broadcaster.broadcast(event_type, data)
    await ws_broadcaster.drain_close_tasks_for_tests()


def test_timed_out_client_is_closed_and_logged(caplog):
    from services import ws_broadcaster

    stalled = _stalled_ws()
    healthy = _healthy_ws()
    ws_broadcaster.register(stalled)
    ws_broadcaster.register(healthy)

    with caplog.at_level(logging.WARNING, logger="services.ws_broadcaster"):
        asyncio.run(_broadcast_and_settle("position_update", {"lat": 1, "lng": 2}))

    assert stalled not in ws_broadcaster._connections
    stalled.close.assert_awaited_once()
    assert stalled.close.await_args.kwargs.get("code") == 1011
    assert any("dropping" in r.getMessage().lower() for r in caplog.records)

    # The healthy client stays registered, got the frame, and is not closed.
    assert healthy in ws_broadcaster._connections
    healthy.close.assert_not_awaited()
    sent = json.loads(healthy.send_text.await_args.args[0])
    assert sent == {"type": "position_update", "data": {"lat": 1, "lng": 2}}


def test_client_raising_on_send_is_closed():
    from services import ws_broadcaster

    broken = _healthy_ws()
    broken.send_text = AsyncMock(side_effect=RuntimeError("boom"))
    ws_broadcaster.register(broken)

    asyncio.run(_broadcast_and_settle("state_change", {"state": "idle"}))

    assert broken not in ws_broadcaster._connections
    broken.close.assert_awaited_once()


def test_close_failure_is_swallowed():
    """Closing an already-dead socket can raise; that must not escape."""
    from services import ws_broadcaster

    stalled = _stalled_ws()
    stalled.close = AsyncMock(side_effect=RuntimeError("already closed"))
    ws_broadcaster.register(stalled)

    asyncio.run(_broadcast_and_settle("state_change", {"state": "idle"}))

    assert stalled not in ws_broadcaster._connections
    stalled.close.assert_awaited_once()
