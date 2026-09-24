from __future__ import annotations

import json
import logging
import re
import urllib.parse
import uuid
from datetime import datetime, timezone

import gpxpy.gpx
from fastapi import APIRouter, UploadFile, File

from api._deps import get_gpx_service, get_route_service, get_saved_routes_store
from api._errors import ErrorCode, http_err
from fastapi.responses import Response
from pydantic import BaseModel, Field

from models.schemas import (
    ROUTE_STORE_VERSION,
    Coordinate,
    RouteBatchDeleteRequest,
    RouteCategory,
    RouteMoveRequest,
    RoutePlanRequest,
    SavedRoute,
)
from services.route_optimizer import optimize_order
from services.saved_routes import ConflictPolicy

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/route", tags=["route"])

# Reject GPX uploads larger than this before loading into memory. 10 MiB
# holds a long multi-day trace at 1 Hz; anything larger is either an
# accidental directory export or a DoS payload.
_MAX_GPX_BYTES = 10 * 1024 * 1024

# Accepted Content-Type values for GPX uploads. Browsers and `curl -F`
# usually send "application/gpx+xml" or "application/xml"; some legacy
# clients emit "text/xml" and many browsers fall back to
# "application/octet-stream" when they can't infer a MIME from the
# extension. Anything outside this set is rejected before parsing.
_GPX_ALLOWED_CONTENT_TYPES = frozenset({
    "application/gpx+xml",
    "application/xml",
    "text/xml",
    "application/octet-stream",
})


# The single SavedRoutesStore / RouteService / GpxService instances for
# the process live on AppState (see state.py) — the composition root —
# and are reached via api._deps so importing this module never hits the
# disk. The store class owns the dict + lock + persist cycle so the
# route handlers stay thin.


@router.post("/plan")
async def plan_route(req: RoutePlanRequest):
    route_service = get_route_service()
    # RouteUnavailableError → 503 is mapped once by the app-level handler
    # registered in main.py, so every route-service caller gets it for free.
    return await route_service.get_route(
        req.start.lat, req.start.lng, req.end.lat, req.end.lng, req.profile,
    )


class _OptimizeOrderRequest(BaseModel):
    """Reorder *waypoints* to minimise total travel time under *profile*.
    Index 0 is anchored (it usually matches the user's current device
    position), the rest are reshuffled. See
    :mod:`backend.services.route_optimizer` for the solver."""
    waypoints: list[Coordinate] = Field(min_length=2, max_length=64)
    profile: str = Field(default="walking", max_length=32)
    # True optimises a round trip back to the first waypoint (Loop mode);
    # False (default) optimises an open path (multi-stop).
    closed: bool = False


class _OptimizeOrderResponse(BaseModel):
    order: list[int]
    waypoints: list[Coordinate]
    total_seconds: float


@router.post("/optimize", response_model=_OptimizeOrderResponse)
async def optimize_route_order(req: _OptimizeOrderRequest):
    """Return the waypoint indices in optimised order plus the reshuffled
    coordinate list for direct UI consumption. The frontend typically
    replaces its local waypoints array with ``response.waypoints``."""
    points: list[tuple[float, float]] = [(c.lat, c.lng) for c in req.waypoints]
    try:
        order, total = await optimize_order(points, req.profile, closed=req.closed)
    except ValueError as exc:
        raise http_err(400, ErrorCode.VALIDATION_FAILED, str(exc))
    reordered = [req.waypoints[i] for i in order]
    return _OptimizeOrderResponse(
        order=order,
        waypoints=reordered,
        total_seconds=total,
    )


@router.get("/saved", response_model=list[SavedRoute])
async def list_saved():
    return get_saved_routes_store().list()


@router.post("/saved", response_model=SavedRoute)
async def save_route(
    route: SavedRoute,
    on_conflict: ConflictPolicy = "new",
):
    """Save a route. ``on_conflict`` controls what happens when a route
    with the same (case-insensitive) name already exists in the target
    category:

    * ``new`` (default, legacy behaviour) — always insert a fresh row
    * ``overwrite`` — replace the existing row in place; id, created_at,
      and sort_order are preserved so any UI references remain valid
    * ``reject`` — return 409 with the existing route so the UI can
      show its overwrite / save-as-new prompt

    Returns the freshly-saved (or overwritten) row directly to keep the
    legacy ``SavedRoute`` response contract.
    """
    saved, action = await get_saved_routes_store().add(route, on_conflict=on_conflict)
    if action == "conflict":
        # ``add`` already located the existing row under the lock and
        # returns it as the SavedRoute payload here. No follow-up
        # lock-free lookup — a concurrent delete cannot race us into
        # shipping a null id/timestamp.
        raise http_err(
            409,
            ErrorCode.ROUTE_NAME_CONFLICT,
            "A route with that name already exists in this category",
            existing_id=saved.id,
            existing_created_at=saved.created_at,
        )
    return saved


@router.delete("/saved/{route_id}")
async def delete_saved(route_id: str):
    if not await get_saved_routes_store().delete(route_id):
        raise http_err(404, ErrorCode.ROUTE_NOT_FOUND, "Route not found")
    return {"status": "deleted"}


class _RouteRenameRequest(BaseModel):
    name: str = Field(max_length=512)


@router.patch("/saved/{route_id}", response_model=SavedRoute)
async def rename_saved(route_id: str, req: _RouteRenameRequest):
    name = req.name.strip()
    if not name:
        raise http_err(400, ErrorCode.INVALID_NAME, "Route name must not be empty")
    result = await get_saved_routes_store().rename(route_id, name)
    if result is None:
        raise http_err(404, ErrorCode.ROUTE_NOT_FOUND, "Route not found")
    action, payload = result
    if action == "conflict":
        # Renaming would create a same-name duplicate in the same
        # category. Surface the existing row's id so the UI can decide
        # whether to abort, force-rename, or open the existing route.
        raise http_err(
            409,
            ErrorCode.ROUTE_NAME_CONFLICT,
            "A route with that name already exists in this category",
            existing_id=payload.id,
            existing_created_at=payload.created_at,
        )
    return payload


@router.get("/saved/export")
async def export_all_saved_routes():
    """Export every saved route plus the categories they belong to, so a
    restore on a fresh install can rebuild the categories."""
    store = get_saved_routes_store()
    payload = {
        "version": ROUTE_STORE_VERSION,
        "categories": [c.model_dump(mode="json") for c in store.list_categories()],
        "routes": [r.model_dump(mode="json") for r in store.list()],
    }
    body = json.dumps(payload, ensure_ascii=False, indent=2)
    return Response(content=body, media_type="application/json",
                    headers={"Content-Disposition": 'attachment; filename="geomirage-routes.json"'})


class _RouteImportBody(BaseModel):
    # ``version`` / ``categories`` are absent in older exports, which
    # carried only ``routes``; those still import into existing categories.
    version: int = 0
    categories: list[RouteCategory] = Field(default_factory=list, max_length=1000)
    routes: list[SavedRoute] = Field(max_length=1000)


@router.post("/saved/import")
async def import_all_saved_routes(body: _RouteImportBody):
    """Merge imported routes into saved. Imports get fresh ids so they never collide."""
    imported = await get_saved_routes_store().import_all(body.routes, body.categories)
    return {"imported": imported}


@router.post("/gpx/import")
async def import_gpx(file: UploadFile = File(...)):
    # Content-Type guard. Cheapest reject: do this before any read so a
    # bogus binary upload (a JPG renamed to .gpx, a malicious payload
    # mislabelled as some other type) never reaches gpxpy.
    content_type = (file.content_type or "").lower().split(";", 1)[0].strip()
    if content_type and content_type not in _GPX_ALLOWED_CONTENT_TYPES:
        raise http_err(400, ErrorCode.GPX_DECODE_FAILED, f"Unsupported content-type: {content_type!r}")

    # Filename extension guard. Defence-in-depth alongside the MIME
    # check — clients can spoof either, but spoofing both is rarer and
    # almost certainly intentional. Empty filename means "browser didn't
    # send one"; we accept and rely on MIME + content parsing.
    filename = (file.filename or "").lower()
    if filename and not filename.endswith(".gpx"):
        raise http_err(400, ErrorCode.GPX_DECODE_FAILED, "Filename must end in .gpx")

    # NOTE on XXE / billion-laughs: gpxpy uses xml.etree.ElementTree
    # internally, which is vulnerable to entity-expansion attacks in
    # principle. The hardened alternative is `defusedxml`, but it isn't
    # in requirements.txt and adding it just for this one endpoint isn't
    # justified for a single-user desktop app. The 10 MiB byte cap below
    # bounds the worst case — even a maliciously expanded payload can't
    # exceed that, and gpxpy's own parser short-circuits on
    # malformed XML before doing meaningful expansion. Revisit if this
    # endpoint is ever exposed to untrusted multi-tenant traffic.

    # Reject oversized uploads before `await file.read()` loads the whole
    # body into memory. `file.size` is populated when the client sent a
    # Content-Length; fall back to a bounded-chunk read otherwise.
    if file.size is not None and file.size > _MAX_GPX_BYTES:
        raise http_err(413, ErrorCode.GPX_TOO_LARGE, f"GPX exceeds {_MAX_GPX_BYTES // (1024 * 1024)} MiB limit")
    content = await file.read(_MAX_GPX_BYTES + 1)
    if len(content) > _MAX_GPX_BYTES:
        raise http_err(413, ErrorCode.GPX_TOO_LARGE, f"GPX exceeds {_MAX_GPX_BYTES // (1024 * 1024)} MiB limit")
    # Most GPX exporters write UTF-8, but real-world devices ship UTF-16
    # and latin-1 too. Try the common encodings before giving up so the
    # user gets a structured 400 they can act on instead of an opaque 500
    # from an uncaught UnicodeDecodeError.
    text: str | None = None
    for encoding in ("utf-8", "utf-16", "latin-1"):
        try:
            text = content.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        raise http_err(400, ErrorCode.GPX_DECODE_FAILED, "GPX file is not valid UTF-8, UTF-16, or latin-1")
    # gpxpy raises GPXXMLSyntaxException (subclass of GPXException) on
    # malformed XML. Unguarded, that escapes as a plain-text 500 instead
    # of the structured envelope every other decode failure here uses.
    try:
        coords = get_gpx_service().parse_gpx(text)
    except gpxpy.gpx.GPXException as e:
        logger.warning("GPX parse failed for %r: %s", file.filename, e)
        raise http_err(400, ErrorCode.GPX_DECODE_FAILED, "GPX file could not be parsed as valid GPX XML")
    # Strip the .gpx extension from the filename so the rename input
    # doesn't show "myroute.gpx" — the format suffix is irrelevant to the
    # in-app route name.
    raw_name = file.filename or "Imported GPX"
    base_name = raw_name.rsplit(".", 1)[0] if raw_name.lower().endswith(".gpx") else raw_name
    route = SavedRoute(
        id=str(uuid.uuid4()),
        name=base_name or "Imported GPX",
        waypoints=coords,
        profile="walking",
        created_at=datetime.now(timezone.utc).isoformat(),
    )
    # get_saved_routes_store().add() reassigns a fresh id + created_at and persists.
    # GPX import always inserts (the user explicitly picked the file and
    # we just stripped the extension), so conflict policy is "new" — a
    # rare same-name match still ships as a fresh row rather than
    # surprising the user with an overwrite prompt mid-import.
    saved, _action = await get_saved_routes_store().add(route, on_conflict="new")
    return {"status": "imported", "id": saved.id, "points": len(coords)}


def _ascii_safe_filename(name: str) -> str:
    """Reduce a route name to a strict ASCII filename fallback.

    HTTP headers are encoded latin-1 by ASGI servers, so raw non-ASCII
    in the ``filename="..."`` parameter blows up with UnicodeEncodeError
    and returns a 500. This strips to a safe ASCII subset for the legacy
    parameter; modern clients read the ``filename*=UTF-8''`` form below.
    """
    safe = re.sub(r"[^A-Za-z0-9_.\-]+", "_", name).strip("_.")
    return safe or "route"


@router.get("/gpx/export/{route_id}")
async def export_gpx(route_id: str):
    route = get_saved_routes_store().get(route_id)
    if route is None:
        raise http_err(404, ErrorCode.ROUTE_NOT_FOUND, "Route not found")
    points = [{"lat": c.lat, "lng": c.lng} for c in route.waypoints]
    gpx_xml = get_gpx_service().generate_gpx(points, name=route.name)
    # RFC 5987 / RFC 6266: emit both a plain ASCII `filename` for legacy
    # clients and `filename*=UTF-8''<percent-encoded>` so modern browsers
    # save routes with Chinese / emoji / etc. names intact. Previously the
    # raw `filename="{name}.gpx"` triggered a 500 whenever the route name
    # contained non-ASCII because ASGI refuses to encode it as latin-1.
    ascii_name = _ascii_safe_filename(route.name) + ".gpx"
    utf8_encoded = urllib.parse.quote(route.name + ".gpx", safe="")
    disposition = (
        f'attachment; filename="{ascii_name}"; '
        f"filename*=UTF-8''{utf8_encoded}"
    )
    return Response(
        content=gpx_xml,
        media_type="application/gpx+xml",
        headers={"Content-Disposition": disposition},
    )


# ── Categories ─────────────────────────────────────────────────────
# Mirrors the bookmark-places surface (see api/bookmarks.py) so the
# frontend's category-sidebar component can be shared once both modules
# settle on the same shape.


class _CategoryCreateRequest(BaseModel):
    name: str = Field(max_length=128)
    color: str = Field(default="#6c8cff", max_length=32)


class _CategoryUpdateRequest(BaseModel):
    name: str | None = Field(default=None, max_length=128)
    color: str | None = Field(default=None, max_length=32)


@router.get("/saved/categories", response_model=list[RouteCategory])
async def list_categories():
    return get_saved_routes_store().list_categories()


@router.post("/saved/categories", response_model=RouteCategory)
async def create_category(req: _CategoryCreateRequest):
    name = req.name.strip()
    if not name:
        raise http_err(400, ErrorCode.INVALID_NAME, "Category name must not be empty")
    return await get_saved_routes_store().create_category(name=name, color=req.color)


@router.put("/saved/categories/{category_id}", response_model=RouteCategory)
async def update_category(category_id: str, req: _CategoryUpdateRequest):
    name = req.name.strip() if req.name is not None else None
    if name is not None and not name:
        raise http_err(400, ErrorCode.INVALID_NAME, "Category name must not be empty")
    updated = await get_saved_routes_store().update_category(category_id, name=name, color=req.color)
    if updated is None:
        raise http_err(404, ErrorCode.ROUTE_CATEGORY_NOT_FOUND, "Category not found")
    return updated


@router.delete("/saved/categories/{category_id}")
async def delete_category(category_id: str):
    # The preset "default" bucket is the fallback for orphaned routes after
    # any other category deletion — deleting it would leave routes pointing
    # at a non-existent category id, so the store refuses the request.
    ok = await get_saved_routes_store().delete_category(category_id)
    if not ok:
        if category_id == "default":
            raise http_err(
                400,
                ErrorCode.ROUTE_CATEGORY_IMMUTABLE,
                "The default category cannot be deleted",
            )
        raise http_err(404, ErrorCode.ROUTE_CATEGORY_NOT_FOUND, "Category not found")
    return {"status": "deleted"}


# ── Batch operations ────────────────────────────────────────────────


@router.post("/saved/batch-delete")
async def batch_delete_routes(req: RouteBatchDeleteRequest):
    deleted = await get_saved_routes_store().batch_delete(req.route_ids)
    return {"deleted": deleted}


@router.post("/saved/move")
async def move_routes_to_category(req: RouteMoveRequest):
    # Validate the target before the store demotes unknown ids to
    # "default" — that fallback is the right call when an inbound route
    # carries a stale category, but on /move the target IS the entire
    # point of the call, so a typo should surface as a 404 instead of
    # silently re-bucketing every selected route.
    known = {c.id for c in get_saved_routes_store().list_categories()}
    if req.target_category_id not in known:
        raise http_err(
            404,
            ErrorCode.ROUTE_CATEGORY_NOT_FOUND,
            "Target category does not exist",
        )
    moved = await get_saved_routes_store().move(req.route_ids, req.target_category_id)
    return {"moved": moved}


# ── Drag-reorder ────────────────────────────────────────────────────


class _RouteReorderRequest(BaseModel):
    # Same cap as the cross-module batch endpoints — see _MAX_BATCH_IDS
    # in models/schemas.py for rationale.
    ordered_ids: list[str] = Field(max_length=10_000)


@router.post("/saved/reorder")
async def reorder_routes(req: _RouteReorderRequest):
    """Persist a drag-reorder of route items within the current sort.
    Unknown ids are ignored — the frontend's optimistic update doesn't
    have to wait for the server to validate the id set before moving on."""
    changed = await get_saved_routes_store().reorder_routes(req.ordered_ids)
    return {"reordered": changed}


@router.post("/saved/categories/reorder")
async def reorder_categories(req: _RouteReorderRequest):
    """Persist a drag-reorder of category items in the sidebar."""
    changed = await get_saved_routes_store().reorder_categories(req.ordered_ids)
    return {"reordered": changed}
