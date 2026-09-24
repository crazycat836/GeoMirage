"""connect_wifi_tunnel never overwrites an existing connection record.

It used to disconnect an existing record without the lock and without
stopping that device's engine, then write its own record
unconditionally, so a concurrent connect could leave an orphaned RSD and
a navigation task on the old transport could mark the new connection
DEGRADED.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from core import device_manager as dm_mod  # noqa: E402
from core.device_manager import DeviceAlreadyConnectedError, DeviceManager  # noqa: E402


class _FakeRSD:
    instances: list["_FakeRSD"] = []

    def __init__(self, address) -> None:
        self.closed = False
        self.peer_info = {
            "Properties": {"UniqueDeviceID": "u1", "OSVersion": "26.5"},
        }
        _FakeRSD.instances.append(self)

    async def connect(self) -> None:
        await asyncio.sleep(0.01)

    async def close(self) -> None:
        self.closed = True


@pytest.fixture(autouse=True)
def _reset():
    from services import connection_state, disconnect_dedup
    _FakeRSD.instances = []
    connection_state.reset_for_tests()
    disconnect_dedup.reset_for_tests()
    yield
    connection_state.reset_for_tests()
    disconnect_dedup.reset_for_tests()


def test_concurrent_tunnel_connects_keep_one_record(monkeypatch):
    monkeypatch.setattr(dm_mod, "RemoteServiceDiscoveryService", _FakeRSD)
    dm = DeviceManager()

    async def run():
        return await asyncio.gather(
            dm.connect_wifi_tunnel("fd00::1", 1),
            dm.connect_wifi_tunnel("fd00::1", 1),
            return_exceptions=True,
        )

    results = asyncio.run(run())

    errors = [r for r in results if isinstance(r, Exception)]
    assert len(errors) == 1
    assert isinstance(errors[0], DeviceAlreadyConnectedError)
    assert dm.connected_udids == ["u1"]
    kept = dm.get_connection("u1").rsd
    assert kept.closed is False
    loser = [r for r in _FakeRSD.instances if r is not kept]
    assert len(loser) == 1 and loser[0].closed is True


def test_tunnel_connect_replacing_usb_stops_engine_first():
    """USB navigation on u1, then start-and-connect over WiFi for the same
    phone: the engine stops before the USB transport closes, and u1 ends
    CONNECTED over Network."""
    from context import ctx
    from api.tunnel._helpers import connect_device_over_tunnel
    from models.schemas import DeviceInfo
    from services.connection_state import DeviceState, store

    order: list[str] = []
    info = DeviceInfo(
        udid="u1", name="iPhone", ios_version="26.5",
        connection_type="Network", is_connected=True,
    )

    class _DM:
        def __init__(self) -> None:
            self.attempts = 0

        async def connect_wifi_tunnel(self, _addr, _port):
            self.attempts += 1
            if self.attempts == 1:
                raise DeviceAlreadyConnectedError("u1")
            order.append("connect_wifi")
            return info

        async def disconnect(self, udid):
            order.append(f"disconnect:{udid}")

    class _AppState:
        def __init__(self) -> None:
            self.device_manager = _DM()

        async def terminate_engine(self, udid):
            order.append(f"terminate:{udid}")

        async def create_engine_for_device(self, udid):
            order.append(f"engine:{udid}")

    saved = getattr(ctx, "app_state", None)
    ctx.app_state = _AppState()
    try:
        async def run():
            await store.transition(
                "u1", DeviceState.CONNECTED, cause="user",
                metadata={"name": "iPhone", "ios_version": "26.5", "connection_type": "USB"},
            )
            with patch("services.connection_state.broadcast", new=AsyncMock()):
                return await connect_device_over_tunnel("fd00::1", 1)

        result = asyncio.run(run())
    finally:
        ctx.app_state = saved

    assert result["status"] == "connected"
    assert order == ["terminate:u1", "disconnect:u1", "connect_wifi", "engine:u1"]
    assert store.get("u1") == DeviceState.CONNECTED
    assert store.metadata_for("u1")["connection_type"] == "Network"
