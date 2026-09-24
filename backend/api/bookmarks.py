from __future__ import annotations

import json
import logging

from fastapi import APIRouter

from api._errors import ErrorCode, http_err
from fastapi.responses import Response
from pydantic import BaseModel, Field

from models.schemas import (
    Bookmark,
    BookmarkMoveRequest,
    BookmarkPlace,
    BookmarkStore,
    BookmarkTag,
    BookmarkTagRequest,
    BookmarkUpdateRequest,
    ReorderRequest,
)
from services.bookmarks_migration import migrate_v0_to_v1
from services.geocoding import GeocodingService

from api._deps import get_bookmark_manager

router = APIRouter(prefix="/api/bookmarks", tags=["bookmarks"])

logger = logging.getLogger(__name__)
_geocoder = GeocodingService()


class BookmarkListResponse(BaseModel):
    """Combined payload for the bookmark list endpoint — places, tags, and
    bookmarks together so the frontend can hydrate state in a single call."""
    places: list[BookmarkPlace]
    tags: list[BookmarkTag]
    bookmarks: list[Bookmark]


async def _resolve_country(lat: float, lng: float) -> tuple[str, str]:
    """Best-effort reverse-geocode for flag display. Never raises — falls
    back to empty strings so bookmark creation is never blocked by a
    Nominatim outage."""
    try:
        res = await _geocoder.reverse(lat, lng)
    except Exception:
        logger.debug("Reverse geocode for bookmark lookup failed", exc_info=True)
        return "", ""
    if res is None:
        return "", ""
    return res.country_code or "", res.country or ""


async def _ensure_country(bookmark: Bookmark) -> tuple[str, str]:
    """Return ``(country_code, country)`` for *bookmark*, reverse-geocoding
    only when the client didn't already supply a country code."""
    if bookmark.country_code:
        return bookmark.country_code, bookmark.country
    return await _resolve_country(bookmark.lat, bookmark.lng)


# ── Bookmarks ─────────────────────────────────────────────

@router.get("", response_model=BookmarkListResponse)
async def list_bookmarks():
    bm = get_bookmark_manager()
    return {
        "places": [p.model_dump() for p in bm.list_places()],
        "tags": [t.model_dump() for t in bm.list_tags()],
        "bookmarks": [b.model_dump() for b in bm.list_bookmarks()],
    }


@router.post("", response_model=Bookmark)
async def create_bookmark(bookmark: Bookmark):
    bm = get_bookmark_manager()
    # Auto-fill the country flag metadata when the client didn't supply it.
    country_code, country = await _ensure_country(bookmark)
    return await bm.create_bookmark(
        name=bookmark.name,
        lat=bookmark.lat,
        lng=bookmark.lng,
        address=bookmark.address,
        place_id=bookmark.place_id,
        tags=list(bookmark.tags),
        country_code=country_code,
        country=country,
        note=bookmark.note,
    )


@router.put("/{bookmark_id}", response_model=Bookmark)
async def update_bookmark(bookmark_id: str, req: BookmarkUpdateRequest):
    """Partial update: only the fields present in the body change."""
    bm = get_bookmark_manager()
    current = next((b for b in bm.list_bookmarks() if b.id == bookmark_id), None)
    if current is None:
        raise http_err(404, ErrorCode.BOOKMARK_NOT_FOUND, "Bookmark not found")
    updates = req.model_dump(exclude_none=True)
    # Re-resolve the country flag only when the coordinates actually move
    # and the client didn't send its own country code.
    lat = updates.get("lat", current.lat)
    lng = updates.get("lng", current.lng)
    if (lat, lng) != (current.lat, current.lng) and not updates.get("country_code"):
        updates["country_code"], updates["country"] = await _resolve_country(lat, lng)
    updated = await bm.update_bookmark(bookmark_id, **updates)
    if not updated:
        raise http_err(404, ErrorCode.BOOKMARK_NOT_FOUND, "Bookmark not found")
    return updated


@router.post("/{bookmark_id}/touch", response_model=Bookmark)
async def touch_bookmark(bookmark_id: str):
    """Record that a bookmark was just used. Server-stamps ``last_used_at``."""
    bm = get_bookmark_manager()
    touched = await bm.touch_bookmark(bookmark_id)
    if not touched:
        raise http_err(404, ErrorCode.BOOKMARK_NOT_FOUND, "Bookmark not found")
    return touched


@router.delete("/{bookmark_id}")
async def delete_bookmark(bookmark_id: str):
    bm = get_bookmark_manager()
    if not await bm.delete_bookmark(bookmark_id):
        raise http_err(404, ErrorCode.BOOKMARK_NOT_FOUND, "Bookmark not found")
    return {"status": "deleted"}


class BatchDeleteRequest(BaseModel):
    # Same cap as the cross-module batch endpoints — see _MAX_BATCH_IDS
    # in models/schemas.py for rationale.
    ids: list[str] = Field(max_length=10_000)


@router.post("/batch-delete")
async def delete_bookmarks_batch(req: BatchDeleteRequest):
    """Delete many bookmarks in one request. Using POST /batch-delete (rather
    than DELETE with a body) sidesteps FastAPI/CORS + middleware quirks around
    body-bearing DELETE requests and keeps the endpoint trivially cacheable."""
    bm = get_bookmark_manager()
    removed = await bm.delete_bookmarks(req.ids)
    return {"deleted": removed, "requested": len(req.ids)}


@router.post("/move")
async def move_bookmarks(req: BookmarkMoveRequest):
    bm = get_bookmark_manager()
    count = await bm.move_bookmarks(req.bookmark_ids, req.target_place_id)
    return {"moved": count}


@router.post("/tag")
async def tag_bookmarks(req: BookmarkTagRequest):
    bm = get_bookmark_manager()
    count = await bm.tag_bookmarks(req.bookmark_ids, req.tag_ids_add, req.tag_ids_remove)
    return {"tagged": count}


@router.post("/backfill-flags")
async def backfill_flags():
    """Reverse-geocode and fill country_code/country for any bookmark that
    lacks them. Safe to re-run: already-populated entries are skipped."""
    bm = get_bookmark_manager()
    filled = 0
    for b in bm.list_bookmarks():
        if b.country_code:
            continue
        cc, country = await _resolve_country(b.lat, b.lng)
        if cc:
            await bm.update_bookmark(b.id, country_code=cc, country=country)
            filled += 1
    return {"filled": filled}


# ── Places ────────────────────────────────────────────────

@router.get("/places", response_model=list[BookmarkPlace])
async def list_places():
    return get_bookmark_manager().list_places()


@router.post("/places", response_model=BookmarkPlace)
async def create_place(place: BookmarkPlace):
    return await get_bookmark_manager().create_place(name=place.name, color=place.color)


@router.put("/places/{place_id}", response_model=BookmarkPlace)
async def update_place(place_id: str, place: BookmarkPlace):
    updated = await get_bookmark_manager().update_place(place_id, name=place.name, color=place.color)
    if not updated:
        raise http_err(404, ErrorCode.PLACE_NOT_FOUND, "Place not found")
    return updated


@router.delete("/places/{place_id}")
async def delete_place(place_id: str):
    if place_id == "default":
        raise http_err(400, ErrorCode.DEFAULT_PLACE_IMMUTABLE, "Cannot delete the default place")
    if not await get_bookmark_manager().delete_place(place_id):
        raise http_err(404, ErrorCode.PLACE_NOT_FOUND, "Place not found")
    return {"status": "deleted"}


@router.post("/places/reorder")
async def reorder_places(req: ReorderRequest):
    changed = await get_bookmark_manager().reorder_places(req.ordered_ids)
    return {"reordered": changed}


# ── Tags ──────────────────────────────────────────────────

@router.get("/tags", response_model=list[BookmarkTag])
async def list_tags():
    return get_bookmark_manager().list_tags()


@router.post("/tags", response_model=BookmarkTag)
async def create_tag(tag: BookmarkTag):
    return await get_bookmark_manager().create_tag(name=tag.name, color=tag.color)


@router.put("/tags/{tag_id}", response_model=BookmarkTag)
async def update_tag(tag_id: str, tag: BookmarkTag):
    updated = await get_bookmark_manager().update_tag(tag_id, name=tag.name, color=tag.color)
    if not updated:
        raise http_err(404, ErrorCode.TAG_NOT_FOUND, "Tag not found")
    return updated


@router.delete("/tags/{tag_id}")
async def delete_tag(tag_id: str):
    if not await get_bookmark_manager().delete_tag(tag_id):
        raise http_err(404, ErrorCode.TAG_NOT_FOUND, "Tag not found")
    return {"status": "deleted"}


@router.post("/tags/reorder")
async def reorder_tags(req: ReorderRequest):
    changed = await get_bookmark_manager().reorder_tags(req.ordered_ids)
    return {"reordered": changed}


@router.post("/reorder")
async def reorder_bookmarks(req: ReorderRequest):
    """Persist a drag-reorder of bookmark items. Distinct from
    /places/reorder + /tags/reorder which order the *axes*; this orders
    individual bookmarks within whichever sort the frontend is using."""
    changed = await get_bookmark_manager().reorder_bookmarks(req.ordered_ids)
    return {"reordered": changed}


# ── Import / Export ───────────────────────────────────────

@router.get("/export")
async def export_bookmarks():
    bm = get_bookmark_manager()
    data = bm.export_json()
    return Response(content=data, media_type="application/json",
                    headers={"Content-Disposition": 'attachment; filename="bookmarks.json"'})


# Import payload caps. Mirrors the conventions used elsewhere: the route
# import body caps at 1000 entries; batch-id endpoints cap at 10_000
# (see _MAX_BATCH_IDS in models/schemas.py).
_MAX_IMPORT_AXIS_ITEMS = 1_000
_MAX_IMPORT_BOOKMARKS = 10_000


class BookmarkImportRequest(BaseModel):
    """Typed body for ``POST /import`` — mirrors :class:`BookmarkStore`
    plus the legacy v0 ``categories`` axis.

    The axis items stay loosely-typed dicts because v0 bookmarks carry
    ``category_id`` (not ``place_id``) and only become valid v1 models
    after the migration; full structural validation runs against
    ``BookmarkStore`` in the handler below.
    """
    version: int = 0
    places: list[dict] = Field(default_factory=list, max_length=_MAX_IMPORT_AXIS_ITEMS)
    tags: list[dict] = Field(default_factory=list, max_length=_MAX_IMPORT_AXIS_ITEMS)
    categories: list[dict] = Field(default_factory=list, max_length=_MAX_IMPORT_AXIS_ITEMS)
    bookmarks: list[dict] = Field(default_factory=list, max_length=_MAX_IMPORT_BOOKMARKS)


@router.post("/import")
async def import_bookmarks(req: BookmarkImportRequest):
    """Import a bookmark export (v0 or v1 shape).

    The body shape is enforced by :class:`BookmarkImportRequest`
    (non-list axes / oversized payloads → 422 ``validation_failed``);
    the inner items are validated here by running the same v0→v1
    migration + ``BookmarkStore`` parse the manager uses, so a malformed
    payload surfaces as 400 ``validation_failed`` instead of the old
    silent success envelope ``{"imported": 0}``. A legitimately empty
    import still returns ``{"imported": 0}`` with ``success: true``.
    """
    raw = req.model_dump()
    try:
        migrated, _ = migrate_v0_to_v1(dict(raw))
        BookmarkStore(**migrated)
    except Exception:
        logger.warning("Bookmark import rejected: payload failed validation", exc_info=True)
        raise http_err(
            400, ErrorCode.VALIDATION_FAILED,
            "Bookmark import payload failed validation",
        )
    bm = get_bookmark_manager()
    count = await bm.import_json(json.dumps(raw))
    return {"imported": count}
