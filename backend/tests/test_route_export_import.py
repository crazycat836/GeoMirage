"""Tests for the saved-route JSON export / import round trip.

The export used to carry only ``routes`` (each with a ``category_id``)
and the import only accepted ``routes``, so restoring a backup on a
fresh install dropped every route into the default category. The export
now includes ``version`` + ``categories`` and the import rebuilds the
categories and remaps each route's ``category_id``.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

# Make `backend/` importable when pytest runs from the repo root.
_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

import api.route as route_api  # noqa: E402
from context import ctx  # noqa: E402
from models.schemas import Coordinate, SavedRoute  # noqa: E402
from services.saved_routes import SavedRoutesStore  # noqa: E402


def _use_store(monkeypatch, store: SavedRoutesStore) -> None:
    monkeypatch.setattr(ctx, "app_state", SimpleNamespace(saved_routes_store=store), raising=False)


def _route(name: str, category_id: str = "default") -> SavedRoute:
    return SavedRoute(
        name=name,
        waypoints=[Coordinate(lat=25.0, lng=121.5)],
        category_id=category_id,
    )


def _export() -> dict:
    resp = asyncio.run(route_api.export_all_saved_routes())
    return json.loads(resp.body)


def _import(payload: dict) -> dict:
    body = route_api._RouteImportBody.model_validate(payload)
    return asyncio.run(route_api.import_all_saved_routes(body))


def _membership(store: SavedRoutesStore) -> dict[str, tuple[str, str]]:
    """route name → (category name, category color)."""
    cats = {c.id: c for c in store.list_categories()}
    return {r.name: (cats[r.category_id].name, cats[r.category_id].color) for r in store.list()}


def test_export_import_on_fresh_store_restores_categories(tmp_path, monkeypatch):
    src = SavedRoutesStore(tmp_path / "src.json")
    hikes = asyncio.run(src.create_category(name="Hikes", color="#10B981"))
    city = asyncio.run(src.create_category(name="City", color="#F59E0B"))
    asyncio.run(src.add(_route("Fuji", hikes.id)))
    asyncio.run(src.add(_route("Shibuya", city.id)))
    asyncio.run(src.add(_route("Home")))
    _use_store(monkeypatch, src)
    exported = _export()
    assert exported["version"] >= 1
    assert {c["name"] for c in exported["categories"]} >= {"Hikes", "City"}

    dst = SavedRoutesStore(tmp_path / "dst.json")  # "new machine"
    _use_store(monkeypatch, dst)
    out = _import(exported)

    assert out == {"imported": 3}
    expected = {
        "Fuji": ("Hikes", "#10B981"),
        "Shibuya": ("City", "#F59E0B"),
    }
    got = _membership(dst)
    for name, cat in expected.items():
        assert got[name] == cat
    assert dst.get(next(r.id for r in dst.list() if r.name == "Home")).category_id == "default"
    # The preset default category is reused, not duplicated.
    assert [c.id for c in dst.list_categories()].count("default") == 1
    # Survives a reload from disk.
    assert _membership(SavedRoutesStore(tmp_path / "dst.json")) == got


def test_import_reuses_existing_category_ids(tmp_path, monkeypatch):
    store = SavedRoutesStore(tmp_path / "routes.json")
    hikes = asyncio.run(store.create_category(name="Hikes", color="#10B981"))
    asyncio.run(store.add(_route("Fuji", hikes.id)))
    _use_store(monkeypatch, store)
    exported = _export()

    _import(exported)

    assert [c.name for c in store.list_categories()].count("Hikes") == 1
    assert all(r.category_id == hikes.id for r in store.list())


def test_legacy_routes_only_file_still_imports(tmp_path, monkeypatch):
    store = SavedRoutesStore(tmp_path / "routes.json")
    _use_store(monkeypatch, store)
    legacy = {"routes": [_route("Old", "gone-category").model_dump(mode="json")]}

    out = _import(legacy)

    assert out == {"imported": 1}
    assert [(r.name, r.category_id) for r in store.list()] == [("Old", "default")]


def test_import_body_caps_categories():
    with pytest.raises(Exception):
        route_api._RouteImportBody.model_validate({
            "routes": [],
            "categories": [{"name": str(i)} for i in range(1001)],
        })
