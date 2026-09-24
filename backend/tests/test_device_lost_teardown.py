"""DeviceLostError cleanup tears down only the lost device.

Dual mode: A (USB) and B (WiFi) both connected with engines. A DVT
reconnect failure on A used to disconnect every connected device, so B's
route died with it. The error now carries the udid and
``handle_device_lost`` tears down that device alone, engine first.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from services.location_service import (  # noqa: E402
    DeviceLostCause,
    DeviceLostError,
    _raise_device_lost,
)


class _FakeDM:
    def __init__(self, udids: list[str], order: list[str]) -> None:
        self._connected = list(udids)
        self._order = order

    @property
    def connected_udids(self) -> list[str]:
        return list(self._connected)

    async def disconnect(self, udid: str) -> None:
        self._order.append(f"disconnect:{udid}")
        self._connected.remove(udid)


class _FakeAppState:
    def __init__(self, udids: list[str]) -> None:
        self.order: list[str] = []
        self.device_manager = _FakeDM(udids, self.order)
        self.simulation_engines = {u: object() for u in udids}
        self._primary = udids[0] if udids else None

    @property
    def simulation_engine(self):
        return self.simulation_engines.get(self._primary)

    async def terminate_engine(self, udid: str) -> None:
        self.order.append(f"terminate:{udid}")
        self.simulation_engines.pop(udid, None)


@pytest.fixture(autouse=True)
def _reset_state():
    from services import connection_state, disconnect_dedup
    connection_state.reset_for_tests()
    disconnect_dedup.reset_for_tests()
    yield
    connection_state.reset_for_tests()
    disconnect_dedup.reset_for_tests()


def _install(monkeypatch, app_state) -> None:
    from context import ctx
    monkeypatch.setattr(ctx, "app_state", app_state, raising=False)


def test_lost_udid_on_error_tears_down_only_that_device(monkeypatch):
    from api.location import _helpers as helpers

    app_state = _FakeAppState(["A", "B"])
    _install(monkeypatch, app_state)
    exc = DeviceLostError("gone", cause=DeviceLostCause.USB_REMOVED, udid="A")

    http = asyncio.run(helpers.handle_device_lost(exc))

    assert http.status_code == 503
    assert app_state.device_manager.connected_udids == ["B"]
    assert "B" in app_state.simulation_engines
    assert app_state.order == ["terminate:A", "disconnect:A"]


def test_caller_udid_used_when_error_has_none(monkeypatch):
    from api.location import _helpers as helpers

    app_state = _FakeAppState(["A", "B"])
    _install(monkeypatch, app_state)

    asyncio.run(helpers.handle_device_lost(DeviceLostError("gone"), "B"))

    assert app_state.device_manager.connected_udids == ["A"]
    assert app_state.order == ["terminate:B", "disconnect:B"]


def test_udidless_request_falls_back_to_primary(monkeypatch):
    from api.location import _helpers as helpers

    app_state = _FakeAppState(["A", "B"])
    _install(monkeypatch, app_state)

    asyncio.run(helpers.handle_device_lost(DeviceLostError("gone")))

    assert app_state.device_manager.connected_udids == ["B"]


def test_single_device_unchanged(monkeypatch):
    from api.location import _helpers as helpers

    app_state = _FakeAppState(["A"])
    app_state.simulation_engines.clear()  # engine already gone
    _install(monkeypatch, app_state)

    asyncio.run(helpers.handle_device_lost(DeviceLostError("gone")))

    assert app_state.device_manager.connected_udids == []


def test_spawn_passes_its_udid_to_cleanup(monkeypatch):
    from api.location import _helpers as helpers

    cleanup = AsyncMock()
    monkeypatch.setattr(helpers, "handle_device_lost", cleanup)

    async def scenario():
        async def lost():
            raise DeviceLostError("gone")

        task = helpers.spawn(lost(), label="navigate", udid="B")
        await asyncio.gather(task, return_exceptions=True)
        for _ in range(3):
            await asyncio.sleep(0)

    asyncio.run(scenario())

    cleanup.assert_awaited_once()
    assert cleanup.await_args.args[1] == "B"


def test_raise_device_lost_stamps_udid():
    with pytest.raises(DeviceLostError) as info:
        _raise_device_lost("DVT reconnect failed", OSError("eof"), "A")
    assert info.value.udid == "A"
