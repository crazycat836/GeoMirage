"""Bookmark, place, and tag management with JSON file persistence.

Data model is dual-axis:
  * place_id (single) — "where": e.g. 富士山, 寺廟, default (未分類)
  * tags (multi)      — "what": e.g. 掃描器, 菇, 花

v0 stores had a single `category_id`; on load we migrate those dicts to the
new shape via :func:`_migrate_v0_to_v1` before handing them to Pydantic.
"""

from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from pydantic import ValidationError

from config import BOOKMARKS_FILE
from models.schemas import (
    BOOKMARK_STORE_VERSION,
    Bookmark,
    BookmarkPlace,
    BookmarkStore,
    BookmarkTag,
)
from services.bookmarks_migration import (
    PRESET_PLACES as _PRESET_PLACES,
    PRESET_TAGS as _PRESET_TAGS,
    build_preset_places as _build_preset_places,
    build_preset_tags as _build_preset_tags,
    migrate_v0_to_v1 as _migrate_v0_to_v1,
    now_iso as _now_iso,
)
from services.json_store import JsonModelStore, next_sort_order, reorder_by_ids

logger = logging.getLogger(__name__)


# Import dedup: a bookmark with the same (trimmed, case-folded) name and the
# same coordinates at this many decimals (~1 m) counts as already present.
_DEDUP_COORD_DECIMALS = 5


@dataclass(frozen=True)
class ImportResult:
    """Outcome of :meth:`BookmarkManager.import_json`."""

    imported: int
    skipped_duplicates: int
    # One entry per rejected row: {axis, index, field, reason}. ``reason`` is
    # a stable code ("missing" | "out_of_range" | "invalid") the UI maps to
    # its own wording.
    invalid: list[dict] = field(default_factory=list)


def _bookmark_key(bm: Bookmark) -> tuple[str, float, float]:
    return (
        bm.name.strip().casefold(),
        round(bm.lat, _DEDUP_COORD_DECIMALS),
        round(bm.lng, _DEDUP_COORD_DECIMALS),
    )


_RANGE_ERROR_TYPES = {"less_than", "less_than_equal", "greater_than", "greater_than_equal"}


def _describe_validation_error(exc: ValidationError) -> dict:
    """First error of *exc* as ``{field, reason}`` with a stable reason code."""
    errors = exc.errors()
    if not errors:
        return {"field": "", "reason": "invalid"}
    err = errors[0]
    loc = err.get("loc") or ()
    field_name = str(loc[0]) if loc else ""
    etype = err.get("type", "")
    if etype == "missing":
        reason = "missing"
    elif etype in _RANGE_ERROR_TYPES:
        reason = "out_of_range"
    else:
        reason = "invalid"
    return {"field": field_name, "reason": reason}


def _merge_axis(live: list, incoming: list) -> dict[str, str]:
    """Merge incoming places/tags into *live* (mutated in place).

    Returns the incoming-id → live-id map. An incoming entry whose id or
    case-insensitive name matches a live one maps onto it; the rest are
    appended under a fresh UUID.
    """
    id_map: dict[str, str] = {}
    live_ids = {item.id for item in live}
    by_name = {item.name.strip().casefold(): item.id for item in live}
    for item in incoming:
        if item.id in live_ids:
            id_map[item.id] = item.id
            continue
        name_key = item.name.strip().casefold()
        if name_key in by_name:
            id_map[item.id] = by_name[name_key]
            continue
        new_id = str(uuid.uuid4())
        id_map[item.id] = new_id
        live.append(item.model_copy(update={"id": new_id}))
        live_ids.add(new_id)
        by_name[name_key] = new_id
    return id_map


# Touch endpoint debounce window. Each `touch_bookmark` call writes the
# full bookmark JSON to disk, so a misbehaving renderer that fires the
# endpoint on every tap could thrash the FS — we collapse rapid repeats
# into a single bump per window. 5s matches the user-perceptible
# resolution of "recently used" sorting; bumping faster has no UI value.
_TOUCH_DEBOUNCE_S = 5.0


class BookmarkManager(JsonModelStore[BookmarkStore]):
    """CRUD manager for bookmarks, places, and tags.

    State is persisted to :data:`BOOKMARKS_FILE` (JSON) on every write.
    Load / quarantine / persist / locking come from :class:`JsonModelStore`;
    every public mutator holds ``self._lock`` across the mutate +
    ``await self._persist()`` cycle so concurrent POST /api/bookmarks (and
    place/tag/import) requests cannot interleave list mutations and write a
    torn JSON snapshot to disk.
    """

    store_label = "bookmark"

    def __init__(self) -> None:
        # Module-global lookup (not the import-time constant) so tests can
        # monkeypatch services.bookmarks.BOOKMARKS_FILE before construction.
        super().__init__(Path(BOOKMARKS_FILE))

    @property
    def store(self) -> BookmarkStore:
        """Public alias for the underlying store (historical API)."""
        return self._store

    @store.setter
    def store(self, value: BookmarkStore) -> None:
        self._store = value

    # ------------------------------------------------------------------
    # JsonModelStore hooks
    # ------------------------------------------------------------------

    def _build_default_store(self) -> BookmarkStore:
        return BookmarkStore(
            version=BOOKMARK_STORE_VERSION,
            places=_build_preset_places(),
            tags=_build_preset_tags(),
            bookmarks=[],
        )

    def _migrate(self, raw: dict) -> tuple[dict, bool]:
        """Migrate v0 stores to v1 at the raw-dict level before Pydantic
        validation so we don't lose data to the stricter schema."""
        return _migrate_v0_to_v1(raw)

    def _validate(self, raw: dict) -> BookmarkStore:
        return BookmarkStore(**raw)

    def _log_loaded(self, store: BookmarkStore) -> None:
        logger.info(
            "Loaded %d bookmarks across %d places, %d tags",
            len(store.bookmarks),
            len(store.places),
            len(store.tags),
        )

    def _ensure_presets(self, store: BookmarkStore) -> tuple[BookmarkStore, bool]:
        """Return *store* with any missing preset places/tags appended.

        Idempotent by id; existing entries are preserved.
        """
        added = False
        now = _now_iso()

        new_places: list[BookmarkPlace] = list(store.places)
        place_ids = {p.id for p in new_places}
        for pid, name, color, order in _PRESET_PLACES:
            if pid in place_ids:
                continue
            new_places.append(
                BookmarkPlace(id=pid, name=name, color=color, sort_order=order, created_at=now)
            )
            added = True

        new_tags: list[BookmarkTag] = list(store.tags)
        tag_ids = {t.id for t in new_tags}
        for pid, name, color, order in _PRESET_TAGS:
            if pid in tag_ids:
                continue
            new_tags.append(
                BookmarkTag(id=pid, name=name, color=color, sort_order=order, created_at=now)
            )
            added = True

        if not added:
            return store, False
        logger.info("Backfilled missing preset places/tags")
        return store.model_copy(update={
            "places": new_places,
            "tags": new_tags,
        }), True

    # ------------------------------------------------------------------
    # Generic helpers (places / tags share the same shape)
    # ------------------------------------------------------------------

    def _update_item(
        self,
        items_attr_name: Literal["places", "tags"],
        item_id: str,
        **field_updates: object,
    ) -> object | None:
        """Find an item by id on ``self.store.<items_attr_name>``, apply
        non-None ``field_updates`` via ``model_copy``, swap into the list,
        and return the updated item (or the original when there were no
        updates). Returns ``None`` if the item id was not found.

        Generalises the find/copy/replace dance shared by ``update_place``
        and ``update_tag``. Caller still owns locking + ``_persist()``.
        """
        items = getattr(self.store, items_attr_name)
        idx = next((i for i, x in enumerate(items) if x.id == item_id), None)
        if idx is None:
            return None
        item = items[idx]
        applied = {k: v for k, v in field_updates.items() if v is not None}
        if not applied:
            return item
        new_item = item.model_copy(update=applied)
        new_items = list(items)
        new_items[idx] = new_item
        setattr(self.store, items_attr_name, new_items)
        return new_item

    def _reorder_items(
        self,
        items_attr_name: Literal["places", "tags", "bookmarks"],
        ordered_ids: list[str],
    ) -> int:
        """Rewrite ``sort_order`` on ``self.store.<items_attr_name>`` to
        match ``ordered_ids``. Unknown ids are ignored; entries not in
        ``ordered_ids`` keep their current order. Returns the number of
        items whose ``sort_order`` actually changed. Caller owns locking.
        """
        new_items, changed = reorder_by_ids(getattr(self.store, items_attr_name), ordered_ids)
        if changed:
            setattr(self.store, items_attr_name, new_items)
        return changed

    # ------------------------------------------------------------------
    # Places
    # ------------------------------------------------------------------

    async def create_place(self, name: str, color: str = "#6c8cff") -> BookmarkPlace:
        async with self._lock:
            place = BookmarkPlace(
                id=str(uuid.uuid4()),
                name=name,
                color=color,
                sort_order=next_sort_order(self.store.places),
                created_at=_now_iso(),
            )
            self.store.places.append(place)
            await self._persist()
            return place

    async def update_place(
        self,
        place_id: str,
        name: str | None = None,
        color: str | None = None,
    ) -> BookmarkPlace | None:
        async with self._lock:
            updated = self._update_item("places", place_id, name=name, color=color)
            if updated is None:
                return None
            await self._persist()
            return updated  # type: ignore[return-value]

    async def delete_place(self, place_id: str) -> bool:
        """Delete a place; bookmarks pointing at it fall back to *default*."""
        if place_id == "default":
            logger.warning("Cannot delete the default place")
            return False
        async with self._lock:
            if self._find_place(place_id) is None:
                return False

            self.store.bookmarks = [
                bm.model_copy(update={"place_id": "default"}) if bm.place_id == place_id else bm
                for bm in self.store.bookmarks
            ]

            self.store.places = [p for p in self.store.places if p.id != place_id]
            await self._persist()
            return True

    def list_places(self) -> list[BookmarkPlace]:
        return sorted(self.store.places, key=lambda p: p.sort_order)

    async def reorder_places(self, ordered_ids: list[str]) -> int:
        """Rewrite sort_order to match the given id sequence. Unknown ids are
        ignored. Returns number of places whose sort_order actually changed."""
        async with self._lock:
            changed = self._reorder_items("places", ordered_ids)
            if changed:
                await self._persist()
            return changed

    def _find_place(self, place_id: str) -> BookmarkPlace | None:
        return next((p for p in self.store.places if p.id == place_id), None)

    # ------------------------------------------------------------------
    # Tags
    # ------------------------------------------------------------------

    async def create_tag(self, name: str, color: str = "#A855F7") -> BookmarkTag:
        async with self._lock:
            tag = BookmarkTag(
                id=str(uuid.uuid4()),
                name=name,
                color=color,
                sort_order=next_sort_order(self.store.tags),
                created_at=_now_iso(),
            )
            self.store.tags.append(tag)
            await self._persist()
            return tag

    async def update_tag(
        self,
        tag_id: str,
        name: str | None = None,
        color: str | None = None,
    ) -> BookmarkTag | None:
        async with self._lock:
            updated = self._update_item("tags", tag_id, name=name, color=color)
            if updated is None:
                return None
            await self._persist()
            return updated  # type: ignore[return-value]

    async def delete_tag(self, tag_id: str) -> bool:
        """Delete a tag. Also strips it from every bookmark's tags list."""
        async with self._lock:
            if self._find_tag(tag_id) is None:
                return False
            self.store.bookmarks = [
                bm.model_copy(update={"tags": [t for t in bm.tags if t != tag_id]})
                if tag_id in bm.tags
                else bm
                for bm in self.store.bookmarks
            ]
            self.store.tags = [t for t in self.store.tags if t.id != tag_id]
            await self._persist()
            return True

    def list_tags(self) -> list[BookmarkTag]:
        return sorted(self.store.tags, key=lambda t: t.sort_order)

    async def reorder_tags(self, ordered_ids: list[str]) -> int:
        async with self._lock:
            changed = self._reorder_items("tags", ordered_ids)
            if changed:
                await self._persist()
            return changed

    def _find_tag(self, tag_id: str) -> BookmarkTag | None:
        return next((t for t in self.store.tags if t.id == tag_id), None)

    # ------------------------------------------------------------------
    # Bookmark item ordering (separate from place/tag axis ordering)
    # ------------------------------------------------------------------

    async def reorder_bookmarks(self, ordered_ids: list[str]) -> int:
        """Rewrite ``sort_order`` on bookmarks to match the given id
        sequence. Unknown ids are ignored; bookmarks not in
        ``ordered_ids`` keep their current sort_order. Returns count
        whose sort_order actually changed."""
        async with self._lock:
            changed = self._reorder_items("bookmarks", ordered_ids)
            if changed:
                await self._persist()
            return changed

    # ------------------------------------------------------------------
    # Bookmarks
    # ------------------------------------------------------------------

    async def create_bookmark(
        self,
        name: str,
        lat: float,
        lng: float,
        address: str = "",
        place_id: str = "default",
        tags: list[str] | None = None,
        country_code: str = "",
        country: str = "",
        note: str = "",
    ) -> Bookmark:
        async with self._lock:
            if self._find_place(place_id) is None:
                place_id = "default"

            known_tag_ids = {t.id for t in self.store.tags}
            # Filter unknown ids first, then dedupe preserving order — a
            # bookmark's tag list is a set semantically; duplicates would
            # double-render in the UI and waste storage.
            cleaned_tags = list(dict.fromkeys(
                t for t in (tags or []) if t in known_tag_ids
            ))

            now = _now_iso()
            bm = Bookmark(
                id=str(uuid.uuid4()),
                name=name,
                lat=lat,
                lng=lng,
                address=address,
                place_id=place_id,
                tags=cleaned_tags,
                created_at=now,
                last_used_at=now,
                country_code=country_code,
                country=country,
                note=note,
            )
            self.store.bookmarks.append(bm)
            await self._persist()
            return bm

    async def update_bookmark(self, bm_id: str, **kwargs: object) -> Bookmark | None:
        async with self._lock:
            bm = self._find_bookmark(bm_id)
            if bm is None:
                return None

            allowed = {
                "name", "lat", "lng", "address", "place_id", "tags",
                "last_used_at", "country_code", "country", "note",
            }
            updates: dict[str, object] = {}
            for key, value in kwargs.items():
                if key not in allowed or value is None:
                    continue
                if key == "place_id" and self._find_place(str(value)) is None:
                    continue  # reject unknown place silently; keep current value
                if key == "tags":
                    known = {t.id for t in self.store.tags}
                    # Filter unknown ids + dedupe preserving order.
                    value = list(dict.fromkeys(
                        t for t in value if t in known  # type: ignore[union-attr]
                    ))
                updates[key] = value

            if updates:
                new_bm = bm.model_copy(update=updates)
                idx = self.store.bookmarks.index(bm)
                self.store.bookmarks[idx] = new_bm
                bm = new_bm

            await self._persist()
            return bm

    async def touch_bookmark(self, bm_id: str) -> Bookmark | None:
        """Stamp ``last_used_at`` on *bm_id* with the current UTC time.

        Server-stamped so clients can't drift the timestamp; kept separate
        from :meth:`update_bookmark` so a usage tick never accidentally
        re-geocodes or revalidates the row.

        Debounced via :data:`_TOUCH_DEBOUNCE_S` — repeated taps inside the
        window short-circuit to the cached row without touching disk.
        """
        async with self._lock:
            bm = self._find_bookmark(bm_id)
            if bm is None:
                return None
            now = datetime.now(timezone.utc)
            if bm.last_used_at:
                try:
                    last = datetime.fromisoformat(bm.last_used_at)
                    if (now - last).total_seconds() < _TOUCH_DEBOUNCE_S:
                        return bm
                except ValueError:
                    # Legacy / hand-edited timestamps fall through to the
                    # write path — better to re-stamp than to silently
                    # freeze last_used_at forever.
                    pass
            new_bm = bm.model_copy(update={"last_used_at": now.isoformat()})
            idx = self.store.bookmarks.index(bm)
            self.store.bookmarks[idx] = new_bm
            await self._persist()
            return new_bm

    async def delete_bookmark(self, bm_id: str) -> bool:
        async with self._lock:
            before = len(self.store.bookmarks)
            self.store.bookmarks = [b for b in self.store.bookmarks if b.id != bm_id]
            if len(self.store.bookmarks) < before:
                await self._persist()
                return True
            return False

    async def delete_bookmarks(self, bm_ids: list[str]) -> int:
        if not bm_ids:
            return 0
        async with self._lock:
            ids = set(bm_ids)
            before = len(self.store.bookmarks)
            self.store.bookmarks = [b for b in self.store.bookmarks if b.id not in ids]
            removed = before - len(self.store.bookmarks)
            if removed:
                await self._persist()
            return removed

    def list_bookmarks(self) -> list[Bookmark]:
        return list(self.store.bookmarks)

    async def move_bookmarks(self, bookmark_ids: list[str], target_place_id: str) -> int:
        """Move multiple bookmarks to *target_place_id*.

        Returns the number of bookmarks actually moved.
        """
        async with self._lock:
            if self._find_place(target_place_id) is None:
                logger.warning("Target place %s does not exist", target_place_id)
                return 0

            moved = 0
            ids_set = set(bookmark_ids)
            new_bookmarks: list[Bookmark] = []
            for bm in self.store.bookmarks:
                if bm.id in ids_set and bm.place_id != target_place_id:
                    new_bookmarks.append(bm.model_copy(update={"place_id": target_place_id}))
                    moved += 1
                else:
                    new_bookmarks.append(bm)

            if moved:
                self.store.bookmarks = new_bookmarks
                await self._persist()
            return moved

    async def tag_bookmarks(
        self,
        bookmark_ids: list[str],
        tag_ids_add: list[str] | None = None,
        tag_ids_remove: list[str] | None = None,
    ) -> int:
        """Apply tag diffs to the given bookmarks. Unknown tag ids are ignored
        (never silently created). Returns the number of bookmarks whose tag
        list actually changed."""
        if not bookmark_ids:
            return 0

        async with self._lock:
            known = {t.id for t in self.store.tags}
            add = [t for t in (tag_ids_add or []) if t in known]
            remove_set = set(tag_ids_remove or [])
            ids_set = set(bookmark_ids)

            changed = 0
            new_bookmarks: list[Bookmark] = []
            for bm in self.store.bookmarks:
                if bm.id not in ids_set:
                    new_bookmarks.append(bm)
                    continue
                before = list(bm.tags)
                after = [t for t in before if t not in remove_set]
                for t in add:
                    if t not in after:
                        after.append(t)
                if after != before:
                    new_bookmarks.append(bm.model_copy(update={"tags": after}))
                    changed += 1
                else:
                    new_bookmarks.append(bm)

            if changed:
                self.store.bookmarks = new_bookmarks
                await self._persist()
            return changed

    def _find_bookmark(self, bm_id: str) -> Bookmark | None:
        return next((b for b in self.store.bookmarks if b.id == bm_id), None)

    # ------------------------------------------------------------------
    # Import / Export
    # ------------------------------------------------------------------

    def export_json(self) -> str:
        return self.store.model_dump_json(indent=2)

    async def import_json(self, data: str) -> ImportResult:
        """Import bookmarks (and places/tags) from a JSON string.

        Accepts both v0 (`categories` + `category_id`) and v1 payloads — v0
        blobs are run through the same migration as on-disk loads.

        Rows are validated one by one: a bad row is skipped and reported
        (``invalid``: axis, index, field, reason) while the rest import.

        Re-importing is idempotent:

        - A place/tag whose id or (case-insensitive) name already exists
          maps onto the live entry instead of being cloned.
        - A bookmark whose name and coordinates (rounded to
          :data:`_DEDUP_COORD_DECIMALS` places, ~1 m) match an existing
          one — or an earlier row of the same file — is skipped and
          counted in ``skipped_duplicates``.

        New places/tags/bookmarks get freshly-minted UUIDs, and the
        bookmark's `place_id` / `tags` references are remapped through the
        old→new id translation. This prevents a crafted payload from
        re-using preset ids (e.g. ``default``, ``preset_scanner``) to
        shadow built-in places/tags. Mirrors the regenerate-on-import
        behaviour of ``api/route.py:import_all_saved_routes``.
        """
        try:
            raw = json.loads(data)
            raw, _ = _migrate_v0_to_v1(raw)
        except Exception as exc:
            logger.error("Invalid bookmark JSON: %s", exc)
            return ImportResult(0, 0, [{"axis": "file", "index": -1, "field": "", "reason": "invalid"}])

        invalid: list[dict] = []

        def _parse(axis: str, model, items) -> list:
            parsed = []
            for index, item in enumerate(items or []):
                try:
                    parsed.append(model.model_validate(item))
                except ValidationError as exc:
                    invalid.append({"axis": axis, "index": index, **_describe_validation_error(exc)})
            return parsed

        in_places = _parse("places", BookmarkPlace, raw.get("places"))
        in_tags = _parse("tags", BookmarkTag, raw.get("tags"))
        in_bookmarks = _parse("bookmarks", Bookmark, raw.get("bookmarks"))
        # Report bookmark rows first (what the user cares about), in file order.
        invalid.sort(key=lambda e: (e["axis"] != "bookmarks", e["axis"], e["index"]))

        async with self._lock:
            # ── Places / tags ─────────────────────────────────────────
            # Build an old_id → new_id translation so bookmark references
            # survive the UUID remint. An id or name that already lives in
            # our store (preset like ``default`` or an entry from a previous
            # import) redirects to the *live* entry instead of cloning.
            axis_sizes = (len(self.store.places), len(self.store.tags))
            place_id_map = _merge_axis(self.store.places, in_places)
            tag_id_map = _merge_axis(self.store.tags, in_tags)

            # ── Bookmarks ─────────────────────────────────────────────
            # Refresh post-import id sets so a bookmark pointing at an
            # un-declared place/tag id collapses cleanly to default /
            # gets dropped instead of carrying a dangling reference.
            valid_place_ids = {p.id for p in self.store.places}
            valid_tag_ids = {t.id for t in self.store.tags}
            seen = {_bookmark_key(b) for b in self.store.bookmarks}
            imported = 0
            skipped = 0
            for bm in in_bookmarks:
                key = _bookmark_key(bm)
                if key in seen:
                    skipped += 1
                    continue
                seen.add(key)
                mapped_place = place_id_map.get(bm.place_id, bm.place_id)
                if mapped_place not in valid_place_ids:
                    mapped_place = "default"
                mapped_tags = [tag_id_map.get(t, t) for t in bm.tags]
                mapped_tags = [t for t in mapped_tags if t in valid_tag_ids]
                new_bm = bm.model_copy(update={
                    "id": str(uuid.uuid4()),
                    "place_id": mapped_place,
                    "tags": mapped_tags,
                })
                self.store.bookmarks.append(new_bm)
                imported += 1

            if imported or (len(self.store.places), len(self.store.tags)) != axis_sizes:
                await self._persist()
            logger.info(
                "Imported %d bookmarks (%d duplicates skipped, %d invalid rows)",
                imported, skipped, len(invalid),
            )
            return ImportResult(imported, skipped, invalid)
