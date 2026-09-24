"""Persistent store for user-saved routes.

Wraps the in-memory list + asyncio.Lock + JSON persist cycle that used to
live as module-level globals in ``api/route.py``. Tests (and any future
multi-instance scenarios) can construct an isolated store instead of
inheriting whatever the real disk file contains.

The store is the single owner of mutation under its lock; callers only
interact via the async methods. ``add`` / ``import_all`` assign fresh
ids and ``created_at`` timestamps so imported / saved routes never
collide with existing entries.

Route-store v1 adds a ``categories`` axis modelled after the bookmark
store: every route carries a ``category_id``, and the on-disk file gains
a ``version`` + ``categories`` block. v0 files (flat ``routes`` list) are
re-shaped on load by :func:`_migrate_v0_to_v1`.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Literal

from models.schemas import (
    ROUTE_STORE_VERSION,
    RouteCategory,
    RouteStore,
    SavedRoute,
)
from services.json_store import JsonModelStore, next_sort_order, reorder_by_ids

logger = logging.getLogger(__name__)


# Stable preset category — always present so a route with
# ``category_id="default"`` never dangles after a delete-category cascade.
_DEFAULT_CATEGORY_ID = "default"
_PRESET_CATEGORIES: tuple[tuple[str, str, str, int], ...] = (
    (_DEFAULT_CATEGORY_ID, "預設", "#6c8cff", 0),
)


# What the POST /route/saved endpoint does when a request comes in with a
# name that already exists. ``new`` always saves a fresh row (the legacy
# behaviour); ``overwrite`` keeps the existing id+created_at and only
# replaces the mutable fields; ``reject`` lets the API hand a 409 back to
# the UI so the user can pick.
ConflictPolicy = Literal["new", "overwrite", "reject"]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _build_preset_categories() -> list[RouteCategory]:
    now = _now_iso()
    return [
        RouteCategory(id=cid, name=name, color=color, sort_order=order, created_at=now)
        for cid, name, color, order in _PRESET_CATEGORIES
    ]


def _migrate_v0_to_v1(raw: dict) -> tuple[dict, bool]:
    """Reshape a v0 routes file into v1 layout.

    v0: ``{"routes": [{id, name, waypoints, profile, created_at}, ...]}``
        — no ``version`` key, no per-route category.
    v1: ``{"version": 1, "categories": [...], "routes": [{..., category_id,
        updated_at, sort_order}, ...]}``.

    Every v0 route is back-filled to the preset "default" category. The
    ``updated_at`` field clones ``created_at`` (no edit signal exists for
    legacy rows), and ``sort_order`` is the insertion index so the UI's
    "default (insertion)" sort matches what the user remembers.

    Returns ``(new_raw, did_migrate)`` — ``did_migrate=True`` means the
    caller should re-persist the file with the migrated shape.
    """
    version = raw.get("version", 0)
    if version >= ROUTE_STORE_VERSION:
        return raw, False

    old_routes = raw.get("routes", []) or []
    new_routes: list[dict] = []
    for idx, route in enumerate(old_routes):
        new_route = dict(route)
        new_route.setdefault("category_id", _DEFAULT_CATEGORY_ID)
        new_route.setdefault("updated_at", new_route.get("created_at", ""))
        new_route.setdefault("sort_order", idx)
        new_routes.append(new_route)

    logger.info("Migrated route store v0→v1: %d routes", len(new_routes))
    return (
        {
            "version": ROUTE_STORE_VERSION,
            "categories": [],  # preset back-fill happens after schema load
            "routes": new_routes,
        },
        True,
    )


# Route name comparisons are case-insensitive trimmed — so "Mt. Fuji "
# and "mt. fuji" hit the same conflict bucket. Mirrors the user's mental
# model: the rename input strips whitespace before storing too.
def _normalise_name(name: str) -> str:
    return name.strip().casefold()


class SavedRoutesStore(JsonModelStore[RouteStore]):
    """Persistent route store with categories, guarded by an asyncio.Lock.

    Load / quarantine / persist / locking come from :class:`JsonModelStore`;
    this class owns the route/category mutators and the conflict policy.
    """

    store_label = "route"

    # ------------------------------------------------------------------
    # JsonModelStore hooks
    # ------------------------------------------------------------------

    def _build_default_store(self) -> RouteStore:
        return RouteStore(
            version=ROUTE_STORE_VERSION,
            categories=_build_preset_categories(),
            routes=[],
        )

    def _migrate(self, raw: dict) -> tuple[dict, bool]:
        return _migrate_v0_to_v1(raw)

    def _validate(self, raw: dict) -> RouteStore:
        return RouteStore(**raw)

    def _ensure_presets(self, store: RouteStore) -> tuple[RouteStore, bool]:
        """Return *store* with any missing preset categories appended.

        Idempotent — existing entries by id are preserved (covers
        hand-edited files that dropped the preset "default" category).
        """
        existing_ids = {c.id for c in store.categories}
        missing: list[RouteCategory] = []
        now = _now_iso()
        for cid, name, color, order in _PRESET_CATEGORIES:
            if cid in existing_ids:
                continue
            missing.append(
                RouteCategory(id=cid, name=name, color=color, sort_order=order, created_at=now)
            )
        if not missing:
            return store, False
        return store.model_copy(update={
            "categories": list(store.categories) + missing,
        }), True

    # ------------------------------------------------------------------
    # Read API (snapshots — never expose the live list)
    # ------------------------------------------------------------------

    def list(self) -> list[SavedRoute]:
        """Snapshot of every route in insertion order. Callers wanting to
        filter / search / sort do that themselves (route count is small)."""
        return list(self._store.routes)

    def list_categories(self) -> list[RouteCategory]:
        return sorted(self._store.categories, key=lambda c: c.sort_order)

    def get(self, route_id: str) -> SavedRoute | None:
        return next((r for r in self._store.routes if r.id == route_id), None)

    def __contains__(self, route_id: str) -> bool:
        return any(r.id == route_id for r in self._store.routes)

    # ------------------------------------------------------------------
    # Routes — mutators
    # ------------------------------------------------------------------

    async def add(
        self,
        route: SavedRoute,
        on_conflict: ConflictPolicy = "new",
    ) -> tuple[SavedRoute, Literal["created", "overwritten", "conflict"]]:
        """Save *route*, applying *on_conflict* when a same-name entry
        already exists.

        Returns ``(route, action)`` where ``action`` is one of:

        - ``"created"`` — fresh insert
        - ``"overwritten"`` — existing same-name entry was replaced in
          place; the returned route is the updated entry
        - ``"conflict"`` — ``on_conflict="reject"`` was passed and a
          same-name entry was found; the returned route is the **existing**
          entry so the API can ship its id/created_at to the UI without a
          follow-up lock-free lookup
        """
        async with self._lock:
            existing = self._find_same_name(route.name, route.category_id)
            if existing is not None:
                if on_conflict == "reject":
                    return existing, "conflict"
                if on_conflict == "overwrite":
                    return await self._overwrite_locked(existing, route), "overwritten"
                # on_conflict == "new" — fall through to fresh insert
            saved = await self._insert_locked(route)
            return saved, "created"

    async def _insert_locked(self, route: SavedRoute) -> SavedRoute:
        """Append a fresh row. Must be called under ``self._lock``."""
        now = _now_iso()
        new_route = route.model_copy(update={
            "id": str(uuid.uuid4()),
            "created_at": now,
            "updated_at": now,
            "sort_order": next_sort_order(self._store.routes),
            "category_id": self._resolve_category_id(route.category_id),
        })
        self._store.routes.append(new_route)
        await self._persist()
        return new_route

    async def _overwrite_locked(self, existing: SavedRoute, incoming: SavedRoute) -> SavedRoute:
        """Replace mutable fields on *existing* with *incoming*; keep id,
        created_at, sort_order. Must be called under ``self._lock``."""
        updated = existing.model_copy(update={
            "name": incoming.name,
            "waypoints": incoming.waypoints,
            "profile": incoming.profile,
            "category_id": self._resolve_category_id(incoming.category_id),
            "updated_at": _now_iso(),
        })
        idx = self._store.routes.index(existing)
        self._store.routes[idx] = updated
        await self._persist()
        return updated

    def _resolve_category_id(self, category_id: str) -> str:
        """Fall back to ``default`` when an unknown id is supplied — same
        contract as ``BookmarkManager`` for unknown place_id."""
        known = {c.id for c in self._store.categories}
        return category_id if category_id in known else _DEFAULT_CATEGORY_ID

    def _find_same_name(self, name: str, category_id: str) -> SavedRoute | None:
        """Locate an existing route with the same case-insensitive name
        in the same category. None if no match."""
        target = _normalise_name(name)
        resolved_cat = self._resolve_category_id(category_id)
        for r in self._store.routes:
            if r.category_id == resolved_cat and _normalise_name(r.name) == target:
                return r
        return None

    async def delete(self, route_id: str) -> bool:
        async with self._lock:
            before = len(self._store.routes)
            self._store.routes = [r for r in self._store.routes if r.id != route_id]
            if len(self._store.routes) == before:
                return False
            await self._persist()
            return True

    async def batch_delete(self, route_ids: list[str]) -> int:
        """Delete several routes in one persist cycle. Returns count deleted."""
        if not route_ids:
            return 0
        targets = set(route_ids)
        async with self._lock:
            before = len(self._store.routes)
            self._store.routes = [r for r in self._store.routes if r.id not in targets]
            deleted = before - len(self._store.routes)
            if deleted:
                await self._persist()
            return deleted

    async def move(self, route_ids: list[str], target_category_id: str) -> int:
        """Reassign *route_ids* to *target_category_id*. Unknown target
        falls back to "default" (matches bookmark semantics)."""
        if not route_ids:
            return 0
        targets = set(route_ids)
        async with self._lock:
            resolved = self._resolve_category_id(target_category_id)
            now = _now_iso()
            moved = 0
            new_routes: list[SavedRoute] = []
            for r in self._store.routes:
                if r.id not in targets or r.category_id == resolved:
                    new_routes.append(r)
                    continue
                new_routes.append(r.model_copy(update={
                    "category_id": resolved,
                    "updated_at": now,
                }))
                moved += 1
            if moved:
                self._store.routes = new_routes
                await self._persist()
            return moved

    async def rename(
        self,
        route_id: str,
        name: str,
    ) -> tuple[Literal["renamed", "conflict"], SavedRoute] | None:
        """Rename a route, enforcing the same case-insensitive uniqueness
        invariant that :meth:`add` does.

        Returns:

        - ``None`` — no route with *route_id* exists (API maps to 404)
        - ``("renamed", route)`` — happy path
        - ``("conflict", existing)`` — a *different* route in the same
          category already has this name; the existing one is returned
          so the API can ship its id to the UI (API maps to 409)

        Renames that resolve to the same normalised name as the route's
        current name are treated as success — re-saving "Mt. Fuji" as
        "mt. fuji " should not bounce.
        """
        async with self._lock:
            idx = next(
                (i for i, r in enumerate(self._store.routes) if r.id == route_id),
                None,
            )
            if idx is None:
                return None
            current = self._store.routes[idx]
            normalised = _normalise_name(name)
            if normalised != _normalise_name(current.name):
                conflict = self._find_same_name(name, current.category_id)
                if conflict is not None and conflict.id != route_id:
                    return "conflict", conflict
            new_route = current.model_copy(update={
                "name": name,
                "updated_at": _now_iso(),
            })
            self._store.routes[idx] = new_route
            await self._persist()
            return "renamed", new_route

    async def import_all(
        self,
        routes: list[SavedRoute],
        categories: list[RouteCategory] | None = None,
    ) -> int:
        """Merge *routes* (and the *categories* they reference) into the
        store with fresh ids. Returns count imported.

        Categories whose id already exists here are reused; the rest are
        appended under a new id, and each route's ``category_id`` is
        remapped through that old→new table (same approach as
        ``BookmarkManager.import_json``). Routes pointing at a category
        that is neither imported nor present fall back to ``default``.
        """
        if not routes:
            return 0
        async with self._lock:
            category_id_map: dict[str, str] = {}
            live_ids = {c.id for c in self._store.categories}
            for cat in categories or []:
                if cat.id in live_ids:
                    category_id_map[cat.id] = cat.id
                    continue
                new_id = str(uuid.uuid4())
                category_id_map[cat.id] = new_id
                self._store.categories.append(cat.model_copy(update={
                    "id": new_id,
                    "sort_order": next_sort_order(self._store.categories),
                }))
            now = _now_iso()
            base_order = next_sort_order(self._store.routes)
            for offset, r in enumerate(routes):
                mapped = category_id_map.get(r.category_id, r.category_id)
                self._store.routes.append(r.model_copy(update={
                    "id": str(uuid.uuid4()),
                    "created_at": now,
                    "updated_at": now,
                    "sort_order": base_order + offset,
                    "category_id": self._resolve_category_id(mapped),
                }))
            await self._persist()
            return len(routes)

    # ------------------------------------------------------------------
    # Categories — mutators
    # ------------------------------------------------------------------

    async def create_category(self, name: str, color: str = "#6c8cff") -> RouteCategory:
        async with self._lock:
            category = RouteCategory(
                id=str(uuid.uuid4()),
                name=name,
                color=color,
                sort_order=next_sort_order(self._store.categories),
                created_at=_now_iso(),
            )
            self._store.categories.append(category)
            await self._persist()
            return category

    async def update_category(
        self,
        category_id: str,
        name: str | None = None,
        color: str | None = None,
    ) -> RouteCategory | None:
        async with self._lock:
            idx = next(
                (i for i, c in enumerate(self._store.categories) if c.id == category_id),
                None,
            )
            if idx is None:
                return None
            applied = {k: v for k, v in (("name", name), ("color", color)) if v is not None}
            if not applied:
                return self._store.categories[idx]
            updated = self._store.categories[idx].model_copy(update=applied)
            self._store.categories[idx] = updated
            await self._persist()
            return updated

    async def reorder_categories(self, ordered_ids: list[str]) -> int:
        """Rewrite ``sort_order`` on categories to match the given id
        sequence. Unknown ids are ignored; categories not listed keep
        their current order. Returns the number whose sort_order
        actually changed."""
        async with self._lock:
            new_cats, changed = reorder_by_ids(self._store.categories, ordered_ids)
            if changed:
                self._store.categories = new_cats
                await self._persist()
            return changed

    async def reorder_routes(self, ordered_ids: list[str]) -> int:
        """Rewrite ``sort_order`` on routes to match the given id
        sequence. Same contract as :meth:`reorder_categories` — unknown
        ids ignored, untouched routes keep their order."""
        async with self._lock:
            new_routes, changed = reorder_by_ids(self._store.routes, ordered_ids)
            if changed:
                self._store.routes = new_routes
                await self._persist()
            return changed

    async def delete_category(self, category_id: str) -> bool:
        """Drop *category_id*; routes pointing at it fall back to ``default``.
        The preset ``default`` category is non-deletable."""
        if category_id == _DEFAULT_CATEGORY_ID:
            return False
        async with self._lock:
            existing = next(
                (c for c in self._store.categories if c.id == category_id),
                None,
            )
            if existing is None:
                return False
            now = _now_iso()
            self._store.routes = [
                r.model_copy(update={"category_id": _DEFAULT_CATEGORY_ID, "updated_at": now})
                if r.category_id == category_id else r
                for r in self._store.routes
            ]
            self._store.categories = [
                c for c in self._store.categories if c.id != category_id
            ]
            await self._persist()
            return True
