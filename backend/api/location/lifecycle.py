"""Lifecycle endpoints — pause/resume/restore/stop/apply-speed.

These operate on a running simulation. apply-speed hot-swaps the
profile mid-route; stop/pause/resume/restore touch device state and so
funnel through :func:`guard` (or :func:`exec_with_retry` for restore
which deliberately retries once on DeviceLost).
"""

from __future__ import annotations

import logging

from fastapi import APIRouter
from pydantic import BaseModel

from api._errors import ErrorCode, http_err
from api.location._helpers import (
    exec_with_retry,
    get_engine,
    guard,
)
from config import resolve_speed_profile
from models.schemas import MovementMode

logger = logging.getLogger("geomirage")

router = APIRouter()


class ApplySpeedRequest(BaseModel):
    mode: MovementMode = MovementMode.WALKING
    speed_kmh: float | None = None
    speed_min_kmh: float | None = None
    speed_max_kmh: float | None = None
    udid: str | None = None


@router.post("/apply-speed")
async def apply_speed(req: ApplySpeedRequest):
    """Hot-swap the active navigation's speed profile. The current
    _move_along_route loop re-interpolates from the current position
    with the new speed; already-completed progress is kept."""
    engine = await get_engine(req.udid)
    profile = resolve_speed_profile(
        req.mode.value,
        speed_kmh=req.speed_kmh,
        speed_min_kmh=req.speed_min_kmh,
        speed_max_kmh=req.speed_max_kmh,
    )
    swapped = await engine.apply_speed(profile)
    if not swapped:
        raise http_err(400, ErrorCode.NO_ACTIVE_ROUTE, "No active route; cannot apply a new speed")
    return {"status": "applied", "speed_mps": profile["speed_mps"]}


@router.post("/pause")
async def pause(udid: str | None = None):
    engine = await get_engine(udid)
    await guard(engine.pause(), udid)
    return {"status": "paused"}


@router.post("/resume")
async def resume(udid: str | None = None):
    engine = await get_engine(udid)
    await guard(engine.resume(), udid)
    return {"status": "resumed"}


@router.post("/restore")
async def restore(udid: str | None = None):
    engine = await get_engine(udid)
    await exec_with_retry(udid, engine, "restore", lambda e: e.restore())
    return {"status": "restored"}


@router.post("/stop")
async def stop_movement(udid: str | None = None):
    """Stop active movement without clearing the simulated location.
    Keeps the device at its last reported position instead of restoring
    real GPS. restore() is a separate endpoint for that."""
    engine = await get_engine(udid)
    await guard(engine.stop(), udid)
    return {"status": "stopped"}
