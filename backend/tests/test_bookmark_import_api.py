"""Tests for ``POST /api/bookmarks/import`` validation.

The endpoint used to take ``data: dict`` with no schema or size cap, and
``BookmarkManager.import_json`` returned 0 for malformed payloads — so
garbage came back as the success envelope ``{"imported": 0}``,
indistinguishable from a legitimately empty import. The body is now
typed (``BookmarkImportRequest``) and the inner items are validated via
the same v0→v1 migration + ``BookmarkStore`` parse the manager uses, so
malformed payloads surface as a structured 400 ``validation_failed``.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

# Make `backend/` importable when pytest runs from the repo root.
_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

import services.bookmarks as bookmarks_service  # noqa: E402
from api.bookmarks import BookmarkImportRequest, import_bookmarks  # noqa: E402
from context import ctx  # noqa: E402


@pytest.fixture()
def bookmark_manager(tmp_path, monkeypatch):
    """Real BookmarkManager persisted to a tmp file, parked on ctx so the
    api._deps accessor resolves it."""
    monkeypatch.setattr(bookmarks_service, "BOOKMARKS_FILE", tmp_path / "bookmarks.json")
    bm = bookmarks_service.BookmarkManager()
    monkeypatch.setattr(ctx, "app_state", SimpleNamespace(bookmark_manager=bm), raising=False)
    return bm


def _run(req: BookmarkImportRequest) -> dict:
    return asyncio.run(import_bookmarks(req))


def test_malformed_row_is_reported_not_silently_dropped(bookmark_manager):
    """A bookmark missing required lat/lng passes the loose body schema but
    fails structural validation — it is reported by index and reason
    instead of the old silent ``{"imported": 0}``."""
    before = len(bookmark_manager.list_bookmarks())
    req = BookmarkImportRequest(bookmarks=[{"name": "no coords"}])

    out = _run(req)

    assert out["imported"] == 0
    assert out["invalid"][0]["index"] == 0
    assert out["invalid"][0]["axis"] == "bookmarks"
    assert out["invalid"][0]["reason"] == "missing"
    assert out["invalid"][0]["field"] in ("lat", "lng")
    assert len(bookmark_manager.list_bookmarks()) == before


def test_valid_v1_payload_imports_unchanged(bookmark_manager):
    req = BookmarkImportRequest(
        version=1,
        bookmarks=[{"id": "bm-1", "name": "Spot", "lat": 25.04, "lng": 121.56}],
    )

    out = _run(req)

    assert out == {"imported": 1, "skipped_duplicates": 0, "invalid": []}
    assert any(b.name == "Spot" for b in bookmark_manager.list_bookmarks())


def test_legacy_v0_payload_still_imports(bookmark_manager):
    """v0 exports (``categories`` + ``category_id``) must keep working —
    the typed body deliberately carries the legacy axis through."""
    req = BookmarkImportRequest(
        version=0,
        categories=[{"id": "cat-fuji", "name": "富士山", "color": "#FF6B6B"}],
        bookmarks=[{
            "id": "bm-1", "name": "富士山展望台",
            "lat": 35.36, "lng": 138.73, "category_id": "cat-fuji",
        }],
    )

    out = _run(req)

    assert out["imported"] == 1
    imported = next(b for b in bookmark_manager.list_bookmarks() if b.name == "富士山展望台")
    place = next(p for p in bookmark_manager.list_places() if p.id == imported.place_id)
    assert place.name == "富士山"


def test_empty_payload_is_a_legit_zero_import(bookmark_manager):
    """An empty (but well-formed) payload is NOT an error — it returns the
    success envelope with ``imported: 0``, distinct from the 400 path."""
    out = _run(BookmarkImportRequest())

    assert out == {"imported": 0, "skipped_duplicates": 0, "invalid": []}


def _backup() -> dict:
    return {
        "version": 1,
        "places": [{"id": "p-home", "name": "Home", "color": "#123456"}],
        "tags": [{"id": "t-cafe", "name": "Cafe", "color": "#654321"}],
        "bookmarks": [
            {"id": "b1", "name": "Spot A", "lat": 25.0330, "lng": 121.5654, "place_id": "p-home", "tags": ["t-cafe"]},
            {"id": "b2", "name": "Spot B", "lat": 35.3606, "lng": 138.7274},
        ],
    }


def test_same_backup_imported_twice_adds_nothing_the_second_time(bookmark_manager):
    first = _run(BookmarkImportRequest(**_backup()))
    assert first["imported"] == 2
    counts = (
        len(bookmark_manager.list_bookmarks()),
        len(bookmark_manager.list_places()),
        len(bookmark_manager.list_tags()),
    )

    second = _run(BookmarkImportRequest(**_backup()))

    assert second == {"imported": 0, "skipped_duplicates": 2, "invalid": []}
    assert (
        len(bookmark_manager.list_bookmarks()),
        len(bookmark_manager.list_places()),
        len(bookmark_manager.list_tags()),
    ) == counts


def test_duplicate_matches_on_rounded_coords_and_name(bookmark_manager):
    _run(BookmarkImportRequest(**_backup()))
    payload = _backup()
    # Same spot, coordinate noise below the rounding precision.
    payload["bookmarks"][0]["lat"] = 25.033001
    # Same coords, different name — a different bookmark.
    payload["bookmarks"][1]["name"] = "Spot B (sunset)"

    out = _run(BookmarkImportRequest(**payload))

    assert out["imported"] == 1
    assert out["skipped_duplicates"] == 1


def test_duplicates_within_one_file_are_skipped(bookmark_manager):
    payload = _backup()
    payload["bookmarks"].append(dict(payload["bookmarks"][1], id="b3"))

    out = _run(BookmarkImportRequest(**payload))

    assert out["imported"] == 2
    assert out["skipped_duplicates"] == 1


def test_bad_rows_are_reported_and_the_rest_imported(bookmark_manager):
    payload = _backup()
    payload["bookmarks"] = [
        payload["bookmarks"][0],
        {"id": "bad1", "name": "No lat", "lng": 121.0},
        {"id": "bad2", "name": "Off the globe", "lat": 200.0, "lng": 121.0},
        payload["bookmarks"][1],
    ]

    out = _run(BookmarkImportRequest(**payload))

    assert out["imported"] == 2
    assert out["invalid"] == [
        {"axis": "bookmarks", "index": 1, "field": "lat", "reason": "missing"},
        {"axis": "bookmarks", "index": 2, "field": "lat", "reason": "out_of_range"},
    ]
    names = {b.name for b in bookmark_manager.list_bookmarks()}
    assert {"Spot A", "Spot B"} <= names


def test_body_schema_rejects_non_list_axes():
    with pytest.raises(ValidationError):
        BookmarkImportRequest(bookmarks="not-a-list")


def test_body_schema_caps_list_sizes():
    with pytest.raises(ValidationError):
        BookmarkImportRequest(bookmarks=[{} for _ in range(10_001)])
    with pytest.raises(ValidationError):
        BookmarkImportRequest(places=[{} for _ in range(1_001)])
