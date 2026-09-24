"""Tests for bookmark / saved-route write failures.

``JsonModelStore._persist_store`` used to ignore ``safe_write_json``'s
``False`` return, so a failed write (disk full, read-only volume, locked
file) still answered 200 and the new data lived only in memory until the
next restart dropped it. A failed write now raises ``StorePersistError``
(mapped to 500 ``store_persist_failed``) and rolls the in-memory store
back to what is on disk.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

# Make `backend/` importable when pytest runs from the repo root.
_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

import api.bookmarks as bookmarks_api  # noqa: E402
import services.bookmarks as bookmarks_service  # noqa: E402
import services.json_store as json_store  # noqa: E402
from api._envelope import store_persist_error_handler  # noqa: E402
from api._errors import ErrorCode  # noqa: E402
from context import ctx  # noqa: E402
from models.schemas import Coordinate, SavedRoute  # noqa: E402
from services.json_store import StorePersistError  # noqa: E402
from services.saved_routes import SavedRoutesStore  # noqa: E402


@pytest.fixture()
def fail_writes(monkeypatch):
    """Toggle: once ``state["fail"]`` is True every store write fails the
    way ``safe_write_json`` reports it (returns False, no exception)."""
    state = {"fail": False}
    real = json_store.safe_write_json

    def _write(path, payload, **kwargs):
        if state["fail"]:
            return False
        return real(path, payload, **kwargs)

    monkeypatch.setattr(json_store, "safe_write_json", _write)
    return state


def _route(name: str = "Loop") -> SavedRoute:
    return SavedRoute(name=name, waypoints=[Coordinate(lat=25.0, lng=121.5)])


def test_saved_route_add_raises_and_rolls_back(tmp_path, fail_writes):
    path = tmp_path / "routes.json"
    store = SavedRoutesStore(path)
    asyncio.run(store.add(_route("kept")))
    fail_writes["fail"] = True

    with pytest.raises(StorePersistError):
        asyncio.run(store.add(_route("lost")))

    # Memory matches disk: only the route that was actually written.
    assert [r.name for r in store.list()] == ["kept"]
    on_disk = json.loads(path.read_text(encoding="utf-8"))
    assert [r["name"] for r in on_disk["routes"]] == ["kept"]

    # The store keeps working once writes succeed again.
    fail_writes["fail"] = False
    asyncio.run(store.add(_route("later")))
    assert [r.name for r in SavedRoutesStore(path).list()] == ["kept", "later"]


def test_bookmark_create_raises_and_rolls_back(tmp_path, monkeypatch, fail_writes):
    monkeypatch.setattr(bookmarks_service, "BOOKMARKS_FILE", tmp_path / "bookmarks.json")
    bm = bookmarks_service.BookmarkManager()
    places_before = [p.id for p in bm.list_places()]
    fail_writes["fail"] = True

    with pytest.raises(StorePersistError):
        asyncio.run(bm.create_bookmark(name="Spot", lat=25.0, lng=121.5))
    with pytest.raises(StorePersistError):
        asyncio.run(bm.create_place(name="Fuji"))

    assert bm.list_bookmarks() == []
    assert [p.id for p in bm.list_places()] == places_before


def test_failed_write_during_load_does_not_crash_startup(tmp_path, fail_writes):
    """A migration re-persist that fails at startup is logged, not raised,
    so the app still boots."""
    path = tmp_path / "routes.json"
    path.write_text(json.dumps({"routes": []}), encoding="utf-8")  # v0 → migrates
    fail_writes["fail"] = True

    store = SavedRoutesStore(path)

    assert [c.id for c in store.list_categories()] == ["default"]


def test_bookmark_api_returns_500_store_persist_failed(tmp_path, monkeypatch, fail_writes):
    monkeypatch.setattr(bookmarks_service, "BOOKMARKS_FILE", tmp_path / "bookmarks.json")
    bm = bookmarks_service.BookmarkManager()
    monkeypatch.setattr(ctx, "app_state", SimpleNamespace(bookmark_manager=bm), raising=False)
    fail_writes["fail"] = True

    app = FastAPI()
    app.include_router(bookmarks_api.router)
    app.add_exception_handler(StorePersistError, store_persist_error_handler)
    resp = TestClient(app).post(
        "/api/bookmarks",
        json={"name": "Spot", "lat": 25.0, "lng": 121.5, "country_code": "TW"},
    )

    assert resp.status_code == 500
    body = resp.json()
    assert body["success"] is False
    assert body["error"]["code"] == "store_persist_failed"


def test_main_registers_store_persist_handler():
    import main

    assert main.app.exception_handlers.get(StorePersistError) is store_persist_error_handler


def test_store_persist_failed_is_a_registered_error_code():
    assert ErrorCode.STORE_PERSIST_FAILED.value == "store_persist_failed"
