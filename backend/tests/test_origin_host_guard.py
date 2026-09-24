"""Host / Origin guards that hold even with GEOMIRAGE_DEV_NOAUTH=1.

With auth disabled the token gate lets everything through, and
WebSockets are not covered by CORS. Without these guards any web page
open in the developer's browser could:

  * open ``ws://127.0.0.1:8777/ws/status``, read the simulated position
    and device list, and send ``joystick_input`` frames;
  * use DNS rebinding (Host: attacker.example) to read and write the
    whole REST API;
  * fire body-less cross-site form POSTs such as ``/api/location/stop``.

Contract pinned here:
  * Any HTTP request whose Host is not 127.0.0.1 / localhost gets 400,
    with or without auth.
  * In dev (no-auth) mode, a WebSocket from a non-allowlisted Origin is
    refused before ``accept()``; the app's own origins still connect.
  * In dev (no-auth) mode, an HTTP request carrying a foreign Origin is
    rejected; no Origin (curl, Electron main process) and app origins pass.
"""

from __future__ import annotations

import asyncio
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

import pytest
from fastapi import WebSocketDisconnect
from starlette.testclient import TestClient

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

import auth  # noqa: E402
import main  # noqa: E402


@pytest.fixture
def dev_noauth(monkeypatch) -> Iterator[None]:
    monkeypatch.setattr(auth, "_is_auth_disabled", lambda: True)
    yield


# ─── Host allowlist (DNS rebinding) ─────────────────────────────────


@pytest.mark.parametrize("base_url", [
    "http://127.0.0.1:8777",
    "http://localhost:8777",
])
def test_loopback_host_is_accepted(base_url):
    resp = TestClient(main.app, base_url=base_url).get("/")
    assert resp.status_code == 200


@pytest.mark.parametrize("auth_disabled", [True, False])
def test_foreign_host_is_rejected(monkeypatch, auth_disabled):
    monkeypatch.setattr(auth, "_is_auth_disabled", lambda: auth_disabled)
    client = TestClient(main.app, base_url="http://attacker.example:8777")
    assert client.get("/").status_code == 400
    assert client.post("/api/location/stop").status_code == 400


# ─── HTTP Origin check in dev (no-auth) mode ─────────────────────────


def _loopback_client() -> TestClient:
    return TestClient(main.app, base_url="http://127.0.0.1:8777")


def test_dev_mode_rejects_foreign_origin_http(dev_noauth):
    resp = _loopback_client().get(
        "/api/device/list", headers={"Origin": "http://example.com"},
    )
    assert resp.status_code == 401


@pytest.mark.parametrize("origin", [None, "http://localhost:5173", "http://127.0.0.1:5173"])
def test_dev_mode_allows_app_origin_or_none_http(dev_noauth, origin):
    headers = {"Origin": origin} if origin else {}
    # `/` is a cheap route that doesn't need a running AppState.
    resp = _loopback_client().get("/", headers=headers)
    assert resp.status_code == 200


# ─── WebSocket Origin check in dev (no-auth) mode ────────────────────


class _StubCooldown:
    def get_status(self) -> dict[str, Any]:
        return {"enabled": False, "is_active": False, "remaining_seconds": 0.0}


class _StubAppState:
    def __init__(self) -> None:
        self.simulation_engines: dict[str, Any] = {}
        self.cooldown_timer = _StubCooldown()


def _fake_ws(origin: str | None) -> AsyncMock:
    ws = AsyncMock()
    ws.headers = {"origin": origin} if origin is not None else {}
    ws.accept = AsyncMock()
    ws.close = AsyncMock()
    ws.send_text = AsyncMock()

    async def _receive_text() -> str:
        raise WebSocketDisconnect(code=1000)

    ws.receive_text = _receive_text
    return ws


@pytest.fixture
def stub_ctx(monkeypatch) -> Iterator[None]:
    from context import ctx
    from services import connection_state

    connection_state.reset_for_tests()
    monkeypatch.setattr(ctx, "app_state", _StubAppState(), raising=False)
    yield
    connection_state.reset_for_tests()


@pytest.mark.parametrize("origin", ["http://example.com", "null", "http://localhost:5174"])
def test_dev_mode_ws_rejects_foreign_origin(dev_noauth, stub_ctx, origin):
    from api.websocket import websocket_endpoint

    ws = _fake_ws(origin)
    asyncio.run(websocket_endpoint(ws))

    ws.accept.assert_not_awaited()
    ws.close.assert_awaited_once()
    ws.send_text.assert_not_awaited()


@pytest.mark.parametrize("origin", ["http://localhost:5173", "http://127.0.0.1:5173", None])
def test_dev_mode_ws_accepts_app_origin(dev_noauth, stub_ctx, origin):
    from api.websocket import websocket_endpoint

    ws = _fake_ws(origin)
    asyncio.run(websocket_endpoint(ws))

    ws.accept.assert_awaited_once()
    ws.send_text.assert_awaited()  # initial state went out
