"""``POST /api/device/{udid}/amfi/reveal-developer-mode`` must actually send
the AMFI request.

``AmfiService.reveal_developer_mode_option_in_ui`` is a coroutine in the
installed pymobiledevice3. Calling it without ``await`` only built the
coroutine, so nothing reached the phone and the route always answered
``ok``. On iOS 17+ ``conn.lockdown`` is the RSD; the AMFI lockdown
service lives on the usbmux lockdown, so the route must prefer that.
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

import pymobiledevice3.services.amfi as amfi  # noqa: E402
from pymobiledevice3.exceptions import PyMobileDevice3Exception  # noqa: E402


class _FakeDM:
    def __init__(self, conn) -> None:
        self._conn = conn

    def get_connection(self, _udid):
        return self._conn


def _conn(**overrides):
    base = dict(
        ios_version="18.2",
        connection_type="USB",
        lockdown="rsd",
        usbmux_lockdown="usbmux",
        developer_mode_enabled=False,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def _fake_amfi(calls: list, exc: BaseException | None = None):
    class _Amfi:
        def __init__(self, lockdown) -> None:
            calls.append(("init", lockdown))

        async def reveal_developer_mode_option_in_ui(self):
            calls.append(("reveal", None))
            if exc is not None:
                raise exc

    return _Amfi


@pytest.fixture
def route(monkeypatch):
    from api import device

    def _install(conn, amfi_cls):
        monkeypatch.setattr(device, "get_device_manager", lambda: _FakeDM(conn))
        monkeypatch.setattr(amfi, "AmfiService", amfi_cls)
        return device.amfi_reveal_developer_mode

    return _install


def test_reveal_awaits_amfi_on_usbmux_lockdown(route):
    calls: list = []
    conn = _conn()
    handler = route(conn, _fake_amfi(calls))

    result = asyncio.run(handler("u1"))

    assert result == {"status": "ok", "udid": "u1"}
    # The coroutine ran (not just created) against the usbmux lockdown.
    assert calls == [("init", "usbmux"), ("reveal", None)]
    assert conn.developer_mode_enabled is None


def test_reveal_falls_back_to_lockdown_without_usbmux(route):
    calls: list = []
    handler = route(_conn(ios_version="16.4", usbmux_lockdown=None, lockdown="lk"),
                    _fake_amfi(calls))

    asyncio.run(handler("u1"))

    assert calls[0] == ("init", "lk")


def test_reveal_device_failure_returns_error_not_ok(route):
    from fastapi import HTTPException

    calls: list = []
    conn = _conn()
    handler = route(conn, _fake_amfi(
        calls, PyMobileDevice3Exception("create_AMFIShowOverridePath() failed"),
    ))

    with pytest.raises(HTTPException) as ei:
        asyncio.run(handler("u1"))

    assert ei.value.status_code == 500
    assert ei.value.detail["code"] == "amfi_reveal_failed"
    # A failed reveal must not invalidate the cached Developer Mode state.
    assert conn.developer_mode_enabled is False
