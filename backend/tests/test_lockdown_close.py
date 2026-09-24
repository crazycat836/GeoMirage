"""usbmux lockdown clients must be closed on every path that opens one.

pymobiledevice3's ``LockdownClient`` has no ``__del__``; an unclosed one
lingers until the asyncio transport is collected and then emits
``ResourceWarning``. Paths covered:

  * ``discover_devices`` opens one per device per poll.
  * ``disconnect`` must close ``conn.usbmux_lockdown``.
  * ``connect`` must close the lockdown it opened when it fails
    (tunnel error, iOS below minimum).
  * ``LegacyLocationService._reset_service`` must await the async
    ``DtSimulateLocation.close()``.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

import core.device_manager as dm_mod  # noqa: E402


class _FakeLockdown:
    def __init__(self, version: str = "18.2") -> None:
        self.all_values = {"ProductVersion": version, "DeviceName": "Phone"}
        self.close_calls = 0

    async def get_developer_mode_status(self) -> bool:
        return True

    async def close(self) -> None:
        self.close_calls += 1


def _patch_usbmux(monkeypatch, lockdown: _FakeLockdown) -> None:
    async def _list_devices():
        return [SimpleNamespace(serial="u1", connection_type="USB")]

    async def _create(serial, autopair=True):
        return lockdown

    monkeypatch.setattr(dm_mod, "list_devices", _list_devices)
    monkeypatch.setattr(dm_mod, "create_using_usbmux", _create)


def test_discover_closes_lockdown(monkeypatch):
    lockdown = _FakeLockdown()
    _patch_usbmux(monkeypatch, lockdown)

    devices = asyncio.run(dm_mod.DeviceManager().discover_devices())

    assert [d.udid for d in devices] == ["u1"]
    assert lockdown.close_calls == 1


def test_connect_tunnel_failure_closes_lockdown(monkeypatch):
    lockdown = _FakeLockdown("18.2")
    _patch_usbmux(monkeypatch, lockdown)

    async def _boom(*_args, **_kwargs):
        raise RuntimeError("tunnel failed")

    monkeypatch.setattr(dm_mod, "connect_via_tunnel", _boom)

    with pytest.raises(RuntimeError):
        asyncio.run(dm_mod.DeviceManager().connect("u1"))
    assert lockdown.close_calls == 1


def test_connect_unsupported_ios_closes_lockdown(monkeypatch):
    lockdown = _FakeLockdown("15.7")
    _patch_usbmux(monkeypatch, lockdown)

    with pytest.raises(dm_mod.UnsupportedIosVersionError):
        asyncio.run(dm_mod.DeviceManager().connect("u1"))
    assert lockdown.close_calls == 1


def test_disconnect_closes_usbmux_lockdown(monkeypatch):
    lockdown = _FakeLockdown("16.7")
    _patch_usbmux(monkeypatch, lockdown)

    async def _run():
        dm = dm_mod.DeviceManager()
        await dm.connect("u1")  # iOS 16 legacy path: lockdown == usbmux_lockdown
        assert lockdown.close_calls == 0
        await dm.disconnect("u1")

    asyncio.run(_run())
    assert lockdown.close_calls == 1


def test_legacy_reset_service_awaits_close():
    from services.location_service import LegacyLocationService

    closed: list[bool] = []

    class _Svc:
        async def close(self) -> None:
            closed.append(True)

    service = LegacyLocationService(object())
    service._service = _Svc()

    asyncio.run(service._reset_service())

    assert closed == [True]
    assert service._service is None
