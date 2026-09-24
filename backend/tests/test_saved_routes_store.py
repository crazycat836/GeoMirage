"""Regression tests for ``SavedRoutesStore`` and ``BookmarkManager`` CRUD.

These rules decide what the user's saved data looks like (same-name
handling, case-insensitive rename checks, where routes go when their
category is deleted), so each one is pinned here against a real store on
``tmp_path`` and read back from disk.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

# Make `backend/` importable when pytest runs from the repo root.
_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

import services.bookmarks as bookmarks_service  # noqa: E402
from models.schemas import Coordinate, SavedRoute  # noqa: E402
from services.saved_routes import SavedRoutesStore  # noqa: E402


def run(coro):
    return asyncio.run(coro)


def _route(name: str, category_id: str = "default", lat: float = 25.0) -> SavedRoute:
    return SavedRoute(
        name=name,
        waypoints=[Coordinate(lat=lat, lng=121.5)],
        category_id=category_id,
    )


@pytest.fixture()
def path(tmp_path) -> Path:
    return tmp_path / "routes.json"


@pytest.fixture()
def store(path) -> SavedRoutesStore:
    return SavedRoutesStore(path)


def _reload(path: Path) -> SavedRoutesStore:
    return SavedRoutesStore(path)


# ── add: same-name policies ──────────────────────────────


def test_add_new_policy_keeps_both_same_name_routes(store, path):
    first, a1 = run(store.add(_route("Loop")))
    second, a2 = run(store.add(_route("loop "), on_conflict="new"))

    assert (a1, a2) == ("created", "created")
    assert first.id != second.id
    assert [r.name for r in _reload(path).list()] == ["Loop", "loop "]


def test_add_overwrite_policy_replaces_in_place(store, path):
    original, _ = run(store.add(_route("Loop", lat=25.0)))

    updated, action = run(store.add(_route(" LOOP", lat=26.0), on_conflict="overwrite"))

    assert action == "overwritten"
    assert updated.id == original.id
    assert updated.created_at == original.created_at
    reloaded = _reload(path).list()
    assert len(reloaded) == 1
    assert reloaded[0].waypoints[0].lat == 26.0


def test_add_reject_policy_returns_existing_without_saving(store, path):
    original, _ = run(store.add(_route("Loop")))

    existing, action = run(store.add(_route("loop"), on_conflict="reject"))

    assert action == "conflict"
    assert existing.id == original.id
    assert len(_reload(path).list()) == 1


def test_same_name_in_another_category_is_not_a_conflict(store):
    other = run(store.create_category(name="Other"))
    run(store.add(_route("Loop")))

    _, action = run(store.add(_route("Loop", other.id), on_conflict="reject"))

    assert action == "created"


def test_add_unknown_category_falls_back_to_default(store):
    saved, _ = run(store.add(_route("Loop", "missing")))
    assert saved.category_id == "default"


# ── rename ───────────────────────────────────────────────


def test_rename_conflict_with_other_route(store, path):
    a, _ = run(store.add(_route("Alpha")))
    b, _ = run(store.add(_route("Beta")))

    action, payload = run(store.rename(b.id, "ALPHA"))

    assert action == "conflict"
    assert payload.id == a.id
    assert sorted(r.name for r in _reload(path).list()) == ["Alpha", "Beta"]


def test_rename_case_only_change_is_allowed(store, path):
    a, _ = run(store.add(_route("alpha")))

    action, payload = run(store.rename(a.id, "Alpha"))

    assert action == "renamed"
    assert payload.name == "Alpha"
    assert _reload(path).get(a.id).name == "Alpha"


def test_rename_unknown_route_returns_none(store):
    assert run(store.rename("missing", "x")) is None


# ── move / delete_category / reorder ─────────────────────


def test_move_routes_between_categories(store, path):
    cat = run(store.create_category(name="Hikes"))
    a, _ = run(store.add(_route("A")))
    b, _ = run(store.add(_route("B")))

    moved = run(store.move([a.id, b.id, "missing"], cat.id))

    assert moved == 2
    assert {r.category_id for r in _reload(path).list()} == {cat.id}
    # Moving again to the same category changes nothing.
    assert run(store.move([a.id], cat.id)) == 0


def test_move_to_unknown_category_falls_back_to_default(store):
    cat = run(store.create_category(name="Hikes"))
    a, _ = run(store.add(_route("A", cat.id)))

    assert run(store.move([a.id], "missing")) == 1
    assert store.get(a.id).category_id == "default"


def test_delete_category_moves_routes_to_default(store, path):
    cat = run(store.create_category(name="Hikes"))
    a, _ = run(store.add(_route("A", cat.id)))

    assert run(store.delete_category(cat.id)) is True

    reloaded = _reload(path)
    assert reloaded.get(a.id).category_id == "default"
    assert cat.id not in {c.id for c in reloaded.list_categories()}


def test_default_category_cannot_be_deleted(store):
    assert run(store.delete_category("default")) is False
    assert run(store.delete_category("missing")) is False
    assert "default" in {c.id for c in store.list_categories()}


def test_update_category_partial(store, path):
    cat = run(store.create_category(name="Hikes", color="#10B981"))

    run(store.update_category(cat.id, name="Walks"))

    got = next(c for c in _reload(path).list_categories() if c.id == cat.id)
    assert (got.name, got.color) == ("Walks", "#10B981")
    assert run(store.update_category("missing", name="x")) is None


def test_reorder_routes_and_categories(store, path):
    a, _ = run(store.add(_route("A")))
    b, _ = run(store.add(_route("B")))
    c1 = run(store.create_category(name="One"))
    c2 = run(store.create_category(name="Two"))

    assert run(store.reorder_routes([b.id, a.id, "missing"])) == 2
    # default 0→2, Two 2→0; One stays at 1.
    assert run(store.reorder_categories([c2.id, c1.id, "default"])) == 2

    reloaded = _reload(path)
    routes = sorted(reloaded.list(), key=lambda r: r.sort_order)
    assert [r.name for r in routes] == ["B", "A"]
    assert [c.name for c in reloaded.list_categories()][:2] == ["Two", "One"]


# ── import_all / delete ──────────────────────────────────


def test_import_all_assigns_fresh_ids(store, path):
    existing, _ = run(store.add(_route("A")))
    incoming = [existing.model_copy(), _route("B", "missing")]

    assert run(store.import_all(incoming)) == 2

    routes = _reload(path).list()
    assert len({r.id for r in routes}) == 3
    assert [r.sort_order for r in routes] == [0, 1, 2]
    assert routes[-1].category_id == "default"
    assert run(store.import_all([])) == 0


def test_delete_and_batch_delete(store, path):
    a, _ = run(store.add(_route("A")))
    b, _ = run(store.add(_route("B")))
    c, _ = run(store.add(_route("C")))

    assert run(store.delete(a.id)) is True
    assert run(store.delete(a.id)) is False
    assert run(store.batch_delete([b.id, "missing"])) == 1
    assert [r.id for r in _reload(path).list()] == [c.id]


# ── BookmarkManager places ───────────────────────────────


@pytest.fixture()
def bookmarks(tmp_path, monkeypatch):
    monkeypatch.setattr(bookmarks_service, "BOOKMARKS_FILE", tmp_path / "bookmarks.json")
    return bookmarks_service.BookmarkManager()


def _reload_bookmarks():
    return bookmarks_service.BookmarkManager()


def test_place_create_rename_move_delete(bookmarks):
    place = run(bookmarks.create_place(name="Fuji", color="#FF6B6B"))
    other = run(bookmarks.create_place(name="Temple"))
    bm = run(bookmarks.create_bookmark(name="Spot", lat=35.36, lng=138.73, place_id=place.id))
    assert bm.place_id == place.id

    run(bookmarks.update_place(place.id, name="Mt. Fuji"))
    got = next(p for p in _reload_bookmarks().list_places() if p.id == place.id)
    assert (got.name, got.color) == ("Mt. Fuji", "#FF6B6B")

    assert run(bookmarks.move_bookmarks([bm.id], other.id)) == 1
    assert run(bookmarks.move_bookmarks([bm.id], "missing")) == 0
    assert _reload_bookmarks().list_bookmarks()[0].place_id == other.id

    assert run(bookmarks.delete_place(other.id)) is True
    reloaded = _reload_bookmarks()
    assert reloaded.list_bookmarks()[0].place_id == "default"
    assert other.id not in {p.id for p in reloaded.list_places()}


def test_default_place_cannot_be_deleted(bookmarks):
    assert run(bookmarks.delete_place("default")) is False
    assert run(bookmarks.delete_place("missing")) is False


def test_bookmark_unknown_place_and_tags_are_cleaned(bookmarks):
    bm = run(bookmarks.create_bookmark(
        name="Spot", lat=25.0, lng=121.5,
        place_id="missing", tags=["preset_scanner", "nope", "preset_scanner"],
    ))

    assert bm.place_id == "default"
    assert bm.tags == ["preset_scanner"]


def test_delete_tag_strips_it_from_bookmarks(bookmarks):
    tag = run(bookmarks.create_tag(name="Night"))
    bm = run(bookmarks.create_bookmark(name="Spot", lat=25.0, lng=121.5, tags=[tag.id]))

    assert run(bookmarks.delete_tag(tag.id)) is True

    reloaded = _reload_bookmarks()
    assert reloaded.list_bookmarks()[0].id == bm.id
    assert reloaded.list_bookmarks()[0].tags == []
