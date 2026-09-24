"""Per-mode dispatch endpoints under /api/location.

Each mode (teleport / navigate / loop / multistop / random-walk / flower /
joystick)
posts a typed request, resolves an engine (lazily rebuilt on demand), and
either runs synchronously (teleport / joystick) or fires-and-forgets a
movement task (navigate / loop / multistop / random-walk / flower). Gold-Ditto
shares teleport's resilience semantics so it lives here too.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from api._deps import get_app_state, get_cooldown_timer
from api._errors import ErrorCode, http_err
from api.location._helpers import (
    exec_with_retry,
    get_engine,
    guard,
    spawn,
)
from models.schemas import (
    Coordinate,
    FlowerRequest,
    JoystickStartRequest,
    Latitude,
    Longitude,
    LoopRequest,
    MultiStopRequest,
    NavigateRequest,
    RandomWalkRequest,
    TeleportRequest,
)

logger = logging.getLogger("geomirage")

router = APIRouter()


@router.post("/teleport")
async def teleport(req: TeleportRequest):
    engine = await get_engine(req.udid)
    cooldown = get_cooldown_timer()

    # Group mode (2+ engines): bypass cooldown entirely. The UI also locks the
    # toggle off, but the saved cooldown_enabled value is preserved so single-
    # device mode restores the user's preference automatically.
    _app_state = get_app_state()
    dual_mode = len(_app_state.simulation_engines) >= 2

    # Enforce cooldown server-side: if enabled and currently active,
    # refuse the teleport so API clients cannot bypass the UI guard.
    if not dual_mode and cooldown.enabled and cooldown.is_active and cooldown.remaining > 0:
        raise http_err(
            429, ErrorCode.COOLDOWN_ACTIVE,
            f"Cooldown active; wait {int(cooldown.remaining)} more seconds",
            remaining_seconds=cooldown.remaining,
        )

    old_pos = engine.current_position
    try:
        await exec_with_retry(
            req.udid, engine, "teleport",
            lambda e: e.teleport(req.lat, req.lng),
        )
    except HTTPException:
        raise
    except Exception:
        logger.exception("Teleport failed")
        raise http_err(500, ErrorCode.TELEPORT_FAILED, "Teleport failed; see ~/.geomirage/logs/backend.log")

    if old_pos and cooldown.enabled and not dual_mode:
        await cooldown.start(old_pos.lat, old_pos.lng, req.lat, req.lng)

    _app_state.update_last_position(req.lat, req.lng)

    # Start/stop idle GPS jitter around the new point per the request flag.
    try:
        await engine.set_auto_jitter(req.auto_jitter)
    except Exception:
        logger.exception("Failed to apply auto-jitter for %s", req.udid)

    return {"status": "ok", "lat": req.lat, "lng": req.lng}


@router.post("/navigate")
async def navigate(req: NavigateRequest):
    engine = await get_engine(req.udid)
    if engine.current_position is None:
        raise http_err(400, ErrorCode.NO_POSITION, "No current position; teleport to a coordinate first")
    spawn(engine.navigate(
        Coordinate(lat=req.lat, lng=req.lng), req.mode,
        speed_kmh=req.speed_kmh,
        speed_min_kmh=req.speed_min_kmh, speed_max_kmh=req.speed_max_kmh,
        straight_line=req.straight_line,
    ), label="navigate", udid=req.udid)
    return {"status": "started", "destination": {"lat": req.lat, "lng": req.lng}, "mode": req.mode}


@router.post("/loop")
async def loop(req: LoopRequest):
    engine = await get_engine(req.udid)
    spawn(engine.start_loop(
        req.waypoints, req.mode,
        speed_kmh=req.speed_kmh,
        speed_min_kmh=req.speed_min_kmh, speed_max_kmh=req.speed_max_kmh,
        pause_enabled=req.pause_enabled, pause_min=req.pause_min, pause_max=req.pause_max,
        straight_line=req.straight_line,
        lap_count=req.lap_count,
    ), label="loop", udid=req.udid)
    return {"status": "started", "waypoints": len(req.waypoints), "mode": req.mode}


@router.post("/multistop")
async def multi_stop(req: MultiStopRequest):
    engine = await get_engine(req.udid)
    spawn(engine.multi_stop(
        req.waypoints, req.mode, req.stop_duration, req.loop,
        speed_kmh=req.speed_kmh,
        speed_min_kmh=req.speed_min_kmh, speed_max_kmh=req.speed_max_kmh,
        pause_enabled=req.pause_enabled, pause_min=req.pause_min, pause_max=req.pause_max,
        straight_line=req.straight_line,
        lap_count=req.lap_count,
    ), label="multi_stop", udid=req.udid)
    return {"status": "started", "stops": len(req.waypoints), "mode": req.mode}


@router.post("/randomwalk")
async def random_walk(req: RandomWalkRequest):
    engine = await get_engine(req.udid)
    spawn(engine.random_walk(
        req.center, req.radius_m, req.mode,
        speed_kmh=req.speed_kmh,
        speed_min_kmh=req.speed_min_kmh, speed_max_kmh=req.speed_max_kmh,
        pause_enabled=req.pause_enabled, pause_min=req.pause_min, pause_max=req.pause_max,
        seed=req.seed,
        straight_line=req.straight_line,
    ), label="random_walk", udid=req.udid)
    return {"status": "started", "radius_m": req.radius_m, "mode": req.mode}


@router.post("/flower")
async def flower(req: FlowerRequest):
    engine = await get_engine(req.udid)
    if req.transfer == "walk" and engine.current_position is None:
        raise http_err(400, ErrorCode.NO_POSITION, "No current position; teleport to a coordinate first")

    # Teleport transfers follow the teleport endpoint's cooldown rules:
    # group mode bypasses cooldown; otherwise an active cooldown refuses
    # the start, and each hop during the run waits out / starts one.
    cooldown = None
    if req.transfer == "teleport":
        dual_mode = len(get_app_state().simulation_engines) >= 2
        if not dual_mode:
            cooldown = get_cooldown_timer()
            if cooldown.enabled and cooldown.is_active and cooldown.remaining > 0:
                raise http_err(
                    429, ErrorCode.COOLDOWN_ACTIVE,
                    f"Cooldown active; wait {int(cooldown.remaining)} more seconds",
                    remaining_seconds=cooldown.remaining,
                )

    spawn(engine.flower(
        req.waypoints, req.mode,
        radius_m=req.radius_m,
        segments=req.segments,
        laps=req.laps,
        rounds=req.rounds,
        wait_before_s=req.wait_before_s,
        wait_after_s=req.wait_after_s,
        transfer=req.transfer,
        speed_kmh=req.speed_kmh,
        speed_min_kmh=req.speed_min_kmh, speed_max_kmh=req.speed_max_kmh,
        pause_enabled=req.pause_enabled, pause_min=req.pause_min, pause_max=req.pause_max,
        straight_line=req.straight_line,
        cooldown=cooldown,
    ), label="flower", udid=req.udid)
    return {"status": "started", "spots": len(req.waypoints), "mode": req.mode}


@router.post("/joystick/start")
async def joystick_start(req: JoystickStartRequest):
    engine = await get_engine(req.udid)
    try:
        await guard(engine.joystick_start(req.mode), req.udid)
    except HTTPException:
        raise
    except Exception:
        logger.exception("joystick_start failed")
        raise http_err(500, ErrorCode.JOYSTICK_START_FAILED, "Joystick start failed; see ~/.geomirage/logs/backend.log")
    return {"status": "started", "mode": req.mode}


@router.post("/joystick/stop")
async def joystick_stop(udid: str | None = None):
    engine = await get_engine(udid)
    await guard(engine.joystick_stop(), udid)
    return {"status": "stopped"}


class _GoldDittoRequest(BaseModel):
    """``lat``/``lng`` is the user's real-world position (the in-app
    "A coordinate"). The handler pushes simulated GPS to this anchor
    then immediately restores real GPS — the apparent jump back from
    the gold-flower spot is what Pikmin Bloom registers as a swipe."""
    lat: Latitude
    lng: Longitude
    udid: str | None = None


@router.post("/gold-ditto")
async def gold_ditto(req: _GoldDittoRequest):
    """One-shot Gold Ditto (拉金盆) cycle.

    Cooldown is bypassed by design — the action is itself a "restore"
    flavour and the user has just manually stopped any sim to open the
    flower bud. ``exec_with_retry`` is used so a transient DVT drop
    triggers a single hard-reconnect retry, matching teleport's
    resilience semantics.
    """
    engine = await get_engine(req.udid)
    try:
        await exec_with_retry(
            req.udid, engine, "gold_ditto",
            lambda e: e.gold_ditto_cycle(req.lat, req.lng),
        )
    except HTTPException:
        raise
    except Exception:
        logger.exception("Gold Ditto cycle failed")
        raise http_err(500, ErrorCode.TELEPORT_FAILED, "Gold Ditto failed; see backend.log")
    return {"status": "done"}
