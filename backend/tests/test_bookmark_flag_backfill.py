"""Tests for ``POST /api/bookmarks/backfill-flags``.

A bookmark whose coordinates have no country (open sea, or a point
Nominatim answers with an error) used to be reverse-geocoded again on
every start, and each filled flag rewrote bookmarks.json once. The
backfill now marks every definitive answer as checked and persists once.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

import api.bookmarks as bookmarks_api  # noqa: E402
import services.bookmarks as bookmarks_service  # noqa: E402
from context import ctx  # noqa: E402

OCEAN = (0.0, -30.0)


class FakeGeocoder:
    """Answers reverse lookups: no country for OCEAN, "JP" elsewhere."""

    def __init__(self, fail: bool = False) -> None:
        self.calls: list[tuple[float, float]] = []
        self.fail = fail

    async def reverse(self, lat, lng, lang=None, *, strict=False):
        self.calls.append((lat, lng))
        if self.fail:
            assert strict, "backfill must ask for transport errors to be raised"
            raise httpx.ConnectError("offline")
        if (lat, lng) == OCEAN:
            return None
        return SimpleNamespace(country_code="jp", country="Japan")


@pytest.fixture()
def manager(tmp_path, monkeypatch):
    monkeypatch.setattr(bookmarks_service, "BOOKMARKS_FILE", tmp_path / "bookmarks.json")
    bm = bookmarks_service.BookmarkManager()
    monkeypatch.setattr(ctx, "app_state", SimpleNamespace(bookmark_manager=bm), raising=False)
    return bm


def _add(manager, lat, lng, name="Spot"):
    return asyncio.run(manager.create_bookmark(name=name, lat=lat, lng=lng))


def test_point_without_country_is_not_looked_up_again(manager, monkeypatch):
    _add(manager, *OCEAN, name="Sea")
    geo = FakeGeocoder()
    monkeypatch.setattr(bookmarks_api, "_geocoder", geo)

    assert asyncio.run(bookmarks_api.backfill_flags()) == {"filled": 0}
    assert asyncio.run(bookmarks_api.backfill_flags()) == {"filled": 0}

    assert geo.calls == [OCEAN]
    [sea] = manager.list_bookmarks()
    assert sea.flag_checked is True and sea.country_code == ""

    # The mark survives a restart.
    reloaded = bookmarks_service.BookmarkManager()
    assert reloaded.list_bookmarks()[0].flag_checked is True


def test_filling_many_flags_writes_the_file_once(manager, monkeypatch):
    for i in range(5):
        _add(manager, 35.0 + i * 0.01, 139.0, name=f"Tokyo {i}")
    monkeypatch.setattr(bookmarks_api, "_geocoder", FakeGeocoder())

    writes = []
    real_persist = manager._persist

    async def counting_persist():
        writes.append(1)
        await real_persist()

    monkeypatch.setattr(manager, "_persist", counting_persist)

    assert asyncio.run(bookmarks_api.backfill_flags()) == {"filled": 5}
    assert len(writes) == 1
    assert all(b.country_code == "jp" for b in manager.list_bookmarks())


def test_network_failure_does_not_mark_bookmarks_checked(manager, monkeypatch):
    _add(manager, 35.0, 139.0)
    monkeypatch.setattr(bookmarks_api, "_geocoder", FakeGeocoder(fail=True))

    assert asyncio.run(bookmarks_api.backfill_flags()) == {"filled": 0}
    [b] = manager.list_bookmarks()
    assert b.flag_checked is False


def test_moving_a_bookmark_clears_the_checked_mark(manager, monkeypatch):
    sea = _add(manager, *OCEAN, name="Sea")
    monkeypatch.setattr(bookmarks_api, "_geocoder", FakeGeocoder())
    asyncio.run(bookmarks_api.backfill_flags())

    moved = asyncio.run(manager.update_bookmark(sea.id, lat=35.0, lng=139.0))
    assert moved.flag_checked is False
