"""Tests for partial bookmark updates and the ``note`` field.

``PUT /api/bookmarks/{id}`` used to take a full ``Bookmark`` body, so the
inline rename (``{name}``) and "move to place" (``{place_id}``) calls were
rejected with 422, and any field the client left out was reset to its
default. The body is now a partial ``BookmarkUpdateRequest``. The
``note`` field used to be dropped silently because the model lacked it.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

# Make `backend/` importable when pytest runs from the repo root.
_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

import api.bookmarks as bookmarks_api  # noqa: E402
import services.bookmarks as bookmarks_service  # noqa: E402
from context import ctx  # noqa: E402
from models.schemas import Bookmark, BookmarkUpdateRequest  # noqa: E402


@pytest.fixture()
def geocode_calls(monkeypatch):
    """Replace the reverse geocoder with a recorder so tests stay offline."""
    calls: list[tuple[float, float]] = []

    async def _fake_resolve(lat: float, lng: float) -> tuple[str, str]:
        calls.append((lat, lng))
        return "JP", "Japan"

    monkeypatch.setattr(bookmarks_api, "_resolve_country", _fake_resolve)
    return calls


@pytest.fixture()
def manager(tmp_path, monkeypatch, geocode_calls):
    monkeypatch.setattr(bookmarks_service, "BOOKMARKS_FILE", tmp_path / "bookmarks.json")
    bm = bookmarks_service.BookmarkManager()
    monkeypatch.setattr(ctx, "app_state", SimpleNamespace(bookmark_manager=bm), raising=False)
    return bm


def _create(manager, **fields) -> Bookmark:
    body = Bookmark(
        name=fields.pop("name", "Spot"),
        lat=fields.pop("lat", 25.04),
        lng=fields.pop("lng", 121.56),
        address=fields.pop("address", "1 Main St"),
        tags=fields.pop("tags", ["preset_scanner"]),
        country_code="TW",
        country="Taiwan",
        **fields,
    )
    return asyncio.run(bookmarks_api.create_bookmark(body))


def _put(bookmark_id: str, payload: dict) -> Bookmark:
    # Parse exactly like FastAPI does for the request body.
    req = BookmarkUpdateRequest.model_validate(payload)
    return asyncio.run(bookmarks_api.update_bookmark(bookmark_id, req))


def _reloaded(bookmark_id: str) -> Bookmark:
    """Read the bookmark back from a fresh manager built from disk."""
    fresh = bookmarks_service.BookmarkManager()
    return next(b for b in fresh.list_bookmarks() if b.id == bookmark_id)


# ── #67 partial update ───────────────────────────────────


def test_put_name_only_keeps_other_fields(manager, geocode_calls):
    created = _create(manager)

    out = _put(created.id, {"name": "Renamed"})

    assert out.name == "Renamed"
    for got in (out, _reloaded(created.id)):
        assert got.name == "Renamed"
        assert (got.lat, got.lng) == (created.lat, created.lng)
        assert got.address == "1 Main St"
        assert got.tags == ["preset_scanner"]
        assert got.place_id == created.place_id
        assert (got.country_code, got.country) == ("TW", "Taiwan")
    assert geocode_calls == []


def test_put_place_id_only_moves_bookmark(manager, geocode_calls):
    created = _create(manager)
    place = asyncio.run(manager.create_place(name="Fuji"))

    out = _put(created.id, {"place_id": place.id})

    assert out.place_id == place.id
    assert out.name == "Spot"
    assert out.address == "1 Main St"
    assert out.tags == ["preset_scanner"]
    assert _reloaded(created.id).place_id == place.id
    assert geocode_calls == []


def test_put_new_coords_refreshes_country(manager, geocode_calls):
    created = _create(manager)

    out = _put(created.id, {"lat": 35.36, "lng": 138.73})

    assert (out.lat, out.lng) == (35.36, 138.73)
    assert (out.country_code, out.country) == ("JP", "Japan")
    assert geocode_calls == [(35.36, 138.73)]


def test_put_same_coords_does_not_regeocode(manager, geocode_calls):
    created = _create(manager)

    _put(created.id, {"name": "x", "lat": created.lat, "lng": created.lng})

    assert geocode_calls == []


def test_update_request_keeps_coordinate_range_validation():
    with pytest.raises(ValidationError):
        BookmarkUpdateRequest.model_validate({"lat": 91})


def test_put_unknown_id_is_404(manager):
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc_info:
        _put("missing", {"name": "x"})
    assert exc_info.value.status_code == 404


# ── #68 note round-trip ──────────────────────────────────


def test_note_round_trips_through_create_and_update(manager):
    created = _create(manager, note="bring a tripod")

    assert created.note == "bring a tripod"
    assert _reloaded(created.id).note == "bring a tripod"

    _put(created.id, {"note": "closed on Mondays"})
    assert _reloaded(created.id).note == "closed on Mondays"

    # An empty string clears the note.
    _put(created.id, {"note": ""})
    assert _reloaded(created.id).note == ""


def test_note_survives_export_import(manager):
    _create(manager, note="sunrise spot")
    exported = manager.export_json()

    count = asyncio.run(manager.import_json(exported))

    assert count == 1
    notes = [b.note for b in manager.list_bookmarks()]
    assert notes == ["sunrise spot", "sunrise spot"]


# ── #70 place / tag rename keeps color ───────────────────


def _put_axis(kind: str, item_id: str, payload: dict):
    req = bookmarks_api.BookmarkAxisUpdateRequest.model_validate(payload)
    handler = bookmarks_api.update_place if kind == "place" else bookmarks_api.update_tag
    return asyncio.run(handler(item_id, req))


@pytest.mark.parametrize("kind", ["place", "tag"])
def test_axis_rename_keeps_color(manager, kind):
    create = manager.create_place if kind == "place" else manager.create_tag
    item = asyncio.run(create(name="Scanner", color="#4A90E2"))

    out = _put_axis(kind, item.id, {"name": "  Scanners  "})

    assert out.name == "Scanners"
    assert out.color == "#4A90E2"


@pytest.mark.parametrize("kind", ["place", "tag"])
def test_axis_color_only_keeps_name(manager, kind):
    create = manager.create_place if kind == "place" else manager.create_tag
    item = asyncio.run(create(name="Flower", color="#EC4899"))

    out = _put_axis(kind, item.id, {"color": "#000000"})

    assert out.name == "Flower"
    assert out.color == "#000000"


@pytest.mark.parametrize("kind", ["place", "tag"])
def test_axis_blank_name_is_400(manager, kind):
    from fastapi import HTTPException

    create = manager.create_place if kind == "place" else manager.create_tag
    item = asyncio.run(create(name="Flower", color="#EC4899"))

    with pytest.raises(HTTPException) as exc_info:
        _put_axis(kind, item.id, {"name": "   "})
    assert exc_info.value.status_code == 400
    assert exc_info.value.detail["code"] == "invalid_name"
