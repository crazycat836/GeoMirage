"""Hard reset reconnects over the transport the device was using.

force_reconnect always rebuilt the connection through usbmux. A device
on the in-process WiFi tunnel isn't listed by usbmux, so the reconnect
failed after the old connection had already been torn down.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from core import device_manager as dm_mod  # noqa: E402
from core.device_manager import DeviceManager, _ActiveConnection  # noqa: E402
from services import engine_recovery  # noqa: E402
from services import wifi_tunnel_service as wt  # noqa: E402


class _FakeRSD:
    def __init__(self, address) -> None:
        self.peer_info = {
            "Properties": {"UniqueDeviceID": "u1", "OSVersion": "26.5"},
        }

    async def connect(self) -> None:
        return None

    async def close(self) -> None:
        return None


class _AppState:
    def __init__(self, dm) -> None:
        self.device_manager = dm
        self.order: list[str] = []
        self.engines: dict[str, object] = {"u1": object()}

    async def terminate_engine(self, udid: str) -> None:
        self.order.append(f"terminate:{udid}")
        self.engines.pop(udid, None)

    async def create_engine_for_device(self, udid: str) -> None:
        self.order.append(f"engine:{udid}")
        self.engines[udid] = object()

    def get_engine(self, udid):
        return self.engines.get(udid)

    @property
    def simulation_engine(self):
        return None


@pytest.fixture(autouse=True)
def _reset():
    from services import connection_state, disconnect_dedup
    connection_state.reset_for_tests()
    disconnect_dedup.reset_for_tests()
    yield
    connection_state.reset_for_tests()
    disconnect_dedup.reset_for_tests()


def _tunnel(*, running: bool):
    return SimpleNamespace(
        is_running=lambda: running,
        transport_alive=lambda: True,
        info={"rsd_address": "fd00::1", "rsd_port": 5555} if running else None,
    )


def _tunnel_dm() -> DeviceManager:
    dm = DeviceManager()
    dm._connections = {
        "u1": _ActiveConnection(
            udid="u1", lockdown=_FakeRSD(None), ios_version="26.5",
            connection_type="Network", rsd=_FakeRSD(None), via_tunnel=True,
        ),
    }
    return dm


def test_tunnel_device_hard_reset_uses_the_tunnel(monkeypatch):
    monkeypatch.setattr(dm_mod, "RemoteServiceDiscoveryService", _FakeRSD)
    usbmux = AsyncMock(side_effect=AssertionError("usbmux must not be used"))
    monkeypatch.setattr(dm_mod, "create_using_usbmux", usbmux)
    monkeypatch.setattr(wt, "tunnel", _tunnel(running=True))
    dm = _tunnel_dm()
    app_state = _AppState(dm)

    with patch("services.connection_state.broadcast", new=AsyncMock()):
        rebuilt = asyncio.run(engine_recovery.force_reconnect(app_state, dm, "u1"))

    assert rebuilt is not None
    usbmux.assert_not_awaited()
    assert dm.is_via_wifi_tunnel("u1")
    assert app_state.order == ["terminate:u1", "engine:u1"]


def test_tunnel_gone_leaves_the_connection_in_place(monkeypatch):
    monkeypatch.setattr(wt, "tunnel", _tunnel(running=False))
    dm = _tunnel_dm()
    conn = dm.get_connection("u1")
    app_state = _AppState(dm)

    rebuilt = asyncio.run(engine_recovery.force_reconnect(app_state, dm, "u1"))

    assert rebuilt is None
    assert dm.get_connection("u1") is conn
    assert app_state.order == []


def test_usb_hard_reset_stops_engine_before_disconnect():
    order: list[str] = []

    class _DM:
        connected_udids = ["u1"]
        connected_count = 1

        def is_via_wifi_tunnel(self, _udid):
            return False

        async def disconnect(self, udid):
            order.append(f"disconnect:{udid}")

        async def connect(self, udid):
            order.append(f"connect:{udid}")

        async def discover_devices(self):
            return []

    dm = _DM()
    app_state = _AppState(dm)
    app_state.order = order

    with patch("services.connection_state.broadcast", new=AsyncMock()):
        rebuilt = asyncio.run(engine_recovery.force_reconnect(app_state, dm, "u1"))

    assert rebuilt is not None
    assert order == ["terminate:u1", "disconnect:u1", "connect:u1", "engine:u1"]


def test_unconnected_device_respects_max_devices():
    class _DM:
        connected_udids = ["a", "b"]
        connected_count = 2

        def is_via_wifi_tunnel(self, _udid):
            return False

        connect = AsyncMock()
        disconnect = AsyncMock()

    dm = _DM()
    rebuilt = asyncio.run(engine_recovery.force_reconnect(_AppState(dm), dm, "c"))

    assert rebuilt is None
    dm.connect.assert_not_awaited()
