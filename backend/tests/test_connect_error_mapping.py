"""``POST /api/device/{udid}/connect`` must tell pairing / lock failures
apart from a generic connect failure.

A first-time user whose phone is locked or who hasn't tapped "Trust This
Computer" hit ``PairingError`` (or its subclass ``PasswordRequiredError``)
inside ``dm.connect``. The route used to collapse that into 500
``connect_failed`` ("please retry"), so the Trust hint never appeared.
``DeviceNotFoundError`` (unplugged between list and connect) maps to
``no_device``.
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

from pymobiledevice3.exceptions import (  # noqa: E402
    DeviceNotFoundError,
    PairingError,
    PasswordRequiredError,
)


class _RaisingDM:
    connected_count = 0

    def __init__(self, exc: BaseException) -> None:
        self._exc = exc

    def is_connected(self, _udid: str) -> bool:
        return False

    async def connect(self, _udid: str) -> None:
        raise self._exc


@pytest.fixture(autouse=True)
def _reset():
    from context import ctx
    from services import connection_state
    connection_state.reset_for_tests()
    saved = getattr(ctx, "app_state", None)
    yield
    ctx.app_state = saved
    connection_state.reset_for_tests()


def _connect_with(exc: BaseException):
    from fastapi import HTTPException
    from api import device
    from context import ctx

    class _AppState:
        device_manager = _RaisingDM(exc)

    ctx.app_state = _AppState()

    async def _run():
        with patch("services.connection_state.broadcast", new=AsyncMock()):
            with pytest.raises(HTTPException) as ei:
                await device.connect_device("u1")
            return ei.value

    return asyncio.run(_run())


@pytest.mark.parametrize("exc", [
    PairingError(),
    PasswordRequiredError(),
])
def test_pairing_errors_map_to_pairing_required(exc):
    err = _connect_with(exc)
    assert err.detail["code"] == "pairing_required"
    assert err.status_code == 409


def test_device_not_found_maps_to_no_device():
    err = _connect_with(DeviceNotFoundError("u1"))
    assert err.detail["code"] == "no_device"
    assert err.status_code == 404


def test_other_errors_still_connect_failed():
    err = _connect_with(RuntimeError("boom"))
    assert err.detail["code"] == "connect_failed"
    assert err.status_code == 500


# ─── connect_via_tunnel error chaining ───────────────────────────────

def _tunnel_raising(monkeypatch, exc: BaseException):
    import core.device_connect as dc

    class _Proxy:
        @staticmethod
        async def create(_lockdown):
            raise exc

    monkeypatch.setattr(dc, "CoreDeviceTunnelProxy", _Proxy)
    return dc


def test_tunnel_pairing_error_propagates_unchanged(monkeypatch):
    dc = _tunnel_raising(monkeypatch, PasswordRequiredError())
    with pytest.raises(PasswordRequiredError):
        asyncio.run(dc.connect_via_tunnel("u1", object(), "18.0"))


def test_tunnel_failure_keeps_cause(monkeypatch):
    original = OSError("tun open failed")
    dc = _tunnel_raising(monkeypatch, original)
    with pytest.raises(RuntimeError) as ei:
        asyncio.run(dc.connect_via_tunnel("u1", object(), "18.0"))
    assert ei.value.__cause__ is original
