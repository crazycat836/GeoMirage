"""Negative tests for the session-token gate (HTTP + WebSocket).

The packaged backend runs as root, so the token check is the only thing
between a local process and the device. These tests fail if a refactor
drops ``_TokenAuthMiddleware``, adds an ``/api/`` path to the exempt
list, mounts a router that bypasses the middleware, or lets the
WebSocket send anything before the auth frame is validated.
"""

from __future__ import annotations

import asyncio
import json
import re
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

import pytest
from fastapi import WebSocketDisconnect
from fastapi.routing import APIRoute
from starlette.testclient import TestClient

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

import auth  # noqa: E402
import main  # noqa: E402

_TOKEN = "test-token"


@pytest.fixture(autouse=True)
def _auth_on(monkeypatch) -> Iterator[None]:
    monkeypatch.setattr(auth, "_is_auth_disabled", lambda: False)
    monkeypatch.setattr(auth, "API_TOKEN", _TOKEN)
    yield


def _client() -> TestClient:
    return TestClient(
        main.app, base_url="http://127.0.0.1:8777", raise_server_exceptions=False,
    )


# ─── HTTP middleware ─────────────────────────────────────────────────


@pytest.mark.parametrize("headers", [
    {},
    {"X-GPS-Token": ""},
    {"X-GPS-Token": "wrong"},
    {"X-GPS-Token": _TOKEN + "x"},
    {"Authorization": f"Bearer {_TOKEN}"},  # wrong header name
])
def test_device_list_rejects_missing_or_wrong_token(headers):
    resp = _client().get("/api/device/list", headers=headers)
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "unauthorized"


def test_device_list_accepts_correct_token():
    resp = _client().get("/api/device/list", headers={"X-GPS-Token": _TOKEN})
    assert resp.status_code != 401


def test_empty_server_token_rejects_everything(monkeypatch):
    """Auth on but no token generated yet: nothing matches, not even ''."""
    monkeypatch.setattr(auth, "API_TOKEN", "")
    resp = _client().get("/api/device/list", headers={"X-GPS-Token": ""})
    assert resp.status_code == 401


def test_no_api_path_is_exempt():
    assert not [p for p in auth._AUTH_EXEMPT_PATHS if p.startswith("/api")]


def _full_routes() -> list[tuple[str, set[str]]]:
    """(full path, methods) for every HTTP route on the app.

    Newer FastAPI wraps each ``include_router`` in an included-router
    object whose ``effective_route_contexts()`` carries the prefixed path;
    older versions flatten to plain ``APIRoute`` entries.
    """
    out: list[tuple[str, set[str]]] = []
    for route in main.app.routes:
        if isinstance(route, APIRoute):
            out.append((route.path, set(route.methods)))
        elif hasattr(route, "effective_route_contexts"):
            for c in route.effective_route_contexts():
                if c.methods:
                    out.append((c.path, set(c.methods)))
    return out


def _api_routes() -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for full_path, methods in _full_routes():
        if not full_path.startswith("/api/"):
            continue
        path = re.sub(r"\{[^}]+\}", "x", full_path)
        for method in sorted(methods - {"HEAD", "OPTIONS"}):
            out.append((method, path))
    return out


def test_api_route_list_is_populated():
    # Guard against the parametrized test below silently running zero cases.
    assert len(_api_routes()) > 20


@pytest.mark.parametrize(("method", "path"), _api_routes())
def test_every_api_route_requires_token(method, path):
    resp = _client().request(method, path, headers={"X-GPS-Token": "wrong"})
    assert resp.status_code == 401, f"{method} {path} answered {resp.status_code}"


# ─── WebSocket auth frame ────────────────────────────────────────────


class _StubCooldown:
    def get_status(self) -> dict[str, Any]:
        return {"enabled": False, "is_active": False, "remaining_seconds": 0.0}


class _StubAppState:
    def __init__(self) -> None:
        self.simulation_engines: dict[str, Any] = {}
        self.cooldown_timer = _StubCooldown()


@pytest.fixture
def stub_ctx(monkeypatch) -> Iterator[None]:
    from context import ctx
    from services import connection_state

    connection_state.reset_for_tests()
    monkeypatch.setattr(ctx, "app_state", _StubAppState(), raising=False)
    yield
    connection_state.reset_for_tests()


def _ws_with_first_frame(first: str | None) -> AsyncMock:
    """Fake socket whose first receive yields *first*, or hangs if None."""
    ws = AsyncMock()
    ws.headers = {}
    ws.accept = AsyncMock()
    ws.close = AsyncMock()
    ws.send_text = AsyncMock()
    frames = [] if first is None else [first]

    async def _receive_text() -> str:
        if first is None:
            await asyncio.sleep(10)
        if frames:
            return frames.pop(0)
        raise WebSocketDisconnect(code=1000)

    ws.receive_text = _receive_text
    return ws


def _run(ws: AsyncMock) -> None:
    from api.websocket import websocket_endpoint

    asyncio.run(websocket_endpoint(ws))


@pytest.mark.parametrize("first", [
    json.dumps({"type": "auth", "token": "wrong"}),
    json.dumps({"type": "auth", "token": ""}),
    json.dumps({"type": "auth"}),
    json.dumps({"type": "joystick_input", "token": _TOKEN}),  # not an auth frame
    "not json",
])
def test_ws_bad_auth_frame_closes_4001_without_sending(stub_ctx, first):
    from services import ws_broadcaster

    ws = _ws_with_first_frame(first)
    _run(ws)

    ws.close.assert_awaited_once()
    assert ws.close.await_args.kwargs.get("code") == 4001
    ws.send_text.assert_not_awaited()
    assert ws not in ws_broadcaster._connections


def test_ws_auth_timeout_closes_4001_without_sending(stub_ctx, monkeypatch):
    import api.websocket as ws_mod

    monkeypatch.setattr(ws_mod, "_WS_AUTH_TIMEOUT_SECONDS", 0.01)
    ws = _ws_with_first_frame(None)
    _run(ws)

    ws.close.assert_awaited_once()
    assert ws.close.await_args.kwargs.get("code") == 4001
    ws.send_text.assert_not_awaited()


def test_ws_correct_token_gets_initial_state(stub_ctx):
    ws = _ws_with_first_frame(json.dumps({"type": "auth", "token": _TOKEN}))
    _run(ws)

    ws.close.assert_not_awaited()
    types = [json.loads(c.args[0])["type"] for c in ws.send_text.await_args_list]
    assert "device_snapshot" in types
