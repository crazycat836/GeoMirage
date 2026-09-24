from __future__ import annotations

import asyncio
import json
import logging
import secrets

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

import auth
from api._deps import get_app_state
from models.schemas import JoystickInput
from models.ws_events import check_ws_event
from services import device_health
from services.ws_broadcaster import (
    broadcast,
    connection_count,
    register,
    unregister,
)

# Re-export broadcast so existing call sites that still use
# ``from api.websocket import broadcast`` keep compiling during the
# migration to services.ws_broadcaster. New code should import from
# services.ws_broadcaster directly so core/ never has to reach back
# into api/ — see tools/check_layers.py.
__all__ = ["broadcast", "router"]

router = APIRouter(tags=["websocket"])
logger = logging.getLogger(__name__)

# Close codes we use for auth failures. 4001 is in the app-specific
# range (4000-4999) and distinct from the standard codes, so the
# renderer can distinguish "auth failed, stop reconnecting" from a
# generic disconnect.
_WS_AUTH_FAIL_CODE = 4001
_WS_AUTH_TIMEOUT_SECONDS = 5.0
# Standard "policy violation" close, used to refuse a foreign Origin.
_WS_POLICY_VIOLATION_CODE = 1008


async def _send_event(ws: WebSocket, event_type: str, data: dict) -> None:
    check_ws_event(event_type, data)
    await ws.send_text(json.dumps({"type": event_type, "data": data}))


async def _send_initial_state(ws: WebSocket) -> None:
    """Push current position, cooldown, and device snapshot to a newly
    connected client.

    The ``device_snapshot`` event is the authoritative ground truth for the
    frontend's device list on (re)connect. Without it the renderer would
    keep whatever stale list it had from before the WS drop and show
    phantom "connected" pills until the next REST-poll-driven scan completes
    (~30s worst case).

    Reads from ``connection_state.store`` — the unified SSoT — instead of
    re-running ``discover_devices``. The store caches name / ios_version /
    connection_type from the original connect, so the payload is identical
    without paying a fresh usbmux round-trip on every renderer reload. A
    DEGRADED device also gets a follow-up ``tunnel_degraded`` so the new
    client sees the "reconnecting…" hint that earlier clients received as
    a transition event.

    Also kicks off a non-blocking two-layer health probe per connected
    device via :func:`services.device_health.schedule_probes` (debounced
    per UDID). The probe
    catches the case where the cached ``CONNECTED`` state is stale —
    e.g. the iPhone left WiFi or was unplugged while the renderer was
    unmounted. Transport-level failure transitions the device to
    DISCONNECTED via :mod:`services.connection_state`; DVT-channel-only
    failure transitions to DEGRADED so the existing
    :meth:`DvtLocationService._reconnect` ladder picks it up.
    """
    from services import connection_state
    from services.connection_state import DeviceState

    app_state = get_app_state()
    # Current position from any active engine
    for engine in app_state.simulation_engines.values():
        pos = engine.current_position
        if pos:
            await _send_event(ws, "position_update", {"lat": pos.lat, "lng": pos.lng})
            break
    # Cooldown state
    cd = app_state.cooldown_timer.get_status()
    await _send_event(ws, "cooldown_update", cd)

    # Device snapshot — pulled directly from the unified state store. Both
    # CONNECTED and DEGRADED count as "this device exists" for the list;
    # DEGRADED additionally gets a tunnel_degraded follow-up below.
    snapshot = connection_state.store.snapshot()
    connected: list[dict[str, str]] = []
    degraded_udids: list[str] = []
    for udid, state in snapshot.items():
        if state not in (DeviceState.CONNECTED, DeviceState.DEGRADED):
            continue
        md = connection_state.store.metadata_for(udid)
        connected.append({
            "udid": udid,
            "name": md.get("name", ""),
            "ios_version": md.get("ios_version", ""),
            "connection_type": md.get("connection_type", "USB"),
        })
        if state == DeviceState.DEGRADED:
            degraded_udids.append(udid)

    await _send_event(ws, "device_snapshot", {"devices": connected})

    # Re-emit tunnel_degraded for any device currently mid-reconnect so the
    # fresh client's chip shows the same "reconnecting…" hint other clients
    # already have. The store doesn't remember the original cause string,
    # so we use a generic "snapshot" tag — the renderer cares about the
    # event, not the reason text.
    for udid in degraded_udids:
        await _send_event(ws, "tunnel_degraded", {"udid": udid, "reason": "snapshot"})

    # Kick off a debounced health probe per snapshotted udid. The
    # service skips entirely when no DeviceManager is wired up (test
    # stubs) so existing ``test_websocket_initial_state`` cases stay
    # deterministic, and debounces per UDID internally.
    device_health.schedule_probes([entry["udid"] for entry in connected])


async def _require_auth_frame(ws: WebSocket) -> bool:
    """Consume the first incoming frame and validate the session token.

    Returns True if the client is authenticated (or auth is disabled in
    dev mode) and the socket should remain open. Returns False after
    closing the socket with 4001 on any failure.
    """
    if auth._is_auth_disabled():
        return True
    try:
        raw = await asyncio.wait_for(ws.receive_text(), timeout=_WS_AUTH_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        await ws.close(code=_WS_AUTH_FAIL_CODE, reason="auth timeout")
        return False
    except WebSocketDisconnect:
        return False
    try:
        msg = json.loads(raw)
    except json.JSONDecodeError:
        await ws.close(code=_WS_AUTH_FAIL_CODE, reason="bad auth frame")
        return False
    supplied = msg.get("token", "") if msg.get("type") == "auth" else ""
    if not auth.API_TOKEN or not secrets.compare_digest(str(supplied), auth.API_TOKEN):
        await ws.close(code=_WS_AUTH_FAIL_CODE, reason="auth rejected")
        return False
    return True


@router.websocket("/ws/status")
async def websocket_endpoint(ws: WebSocket):
    # WebSockets are not covered by CORS. With auth disabled (dev mode) the
    # Origin check is the only thing stopping any open web page from reading
    # position / device events and sending joystick frames, so refuse
    # foreign origins before accepting (the client sees an HTTP 403).
    if auth._is_auth_disabled() and not auth.is_origin_allowed(ws.headers.get("origin")):
        logger.warning("Rejected WebSocket from origin %r", ws.headers.get("origin"))
        await ws.close(code=_WS_POLICY_VIOLATION_CODE)
        return
    await ws.accept()
    if not await _require_auth_frame(ws):
        return
    register(ws)
    logger.info("WebSocket client connected (%d total)", connection_count())

    try:
        await _send_initial_state(ws)
    except Exception:
        logger.debug("Failed to send initial state to new WS client", exc_info=True)

    try:
        while True:
            text = await ws.receive_text()
            try:
                msg = json.loads(text)
            except json.JSONDecodeError:
                continue

            msg_type = msg.get("type", "")

            if msg_type == "joystick_input":
                data = msg.get("data", {})
                app_state = get_app_state()
                # Route per-udid if provided; otherwise fan out to all engines.
                udid = msg.get("udid") or data.get("udid")
                # JoystickInput enforces strict bounds (direction 0–360,
                # intensity 0–1, sensitivity 0.1–2.0). A malformed frame
                # must be dropped — letting the ValidationError escape to
                # the outer `except Exception` would kill the receive
                # loop and starve the client of all events until it
                # reconnects.
                try:
                    inp = JoystickInput(
                        direction=data.get("direction", 0),
                        intensity=data.get("intensity", 0),
                        sensitivity=data.get("sensitivity", 1.0),
                    )
                except (ValidationError, TypeError):
                    logger.debug("Dropping malformed joystick_input frame: %s", text)
                    continue
                if udid:
                    engine = app_state.get_engine(udid)
                    if engine:
                        engine.joystick_move(inp)
                else:
                    for engine in list(app_state.simulation_engines.values()):
                        engine.joystick_move(inp)

            elif msg_type == "joystick_stop":
                app_state = get_app_state()
                udid = msg.get("udid") or msg.get("data", {}).get("udid")
                if udid:
                    engine = app_state.get_engine(udid)
                    if engine:
                        await engine.joystick_stop()
                else:
                    for engine in list(app_state.simulation_engines.values()):
                        await engine.joystick_stop()

    except WebSocketDisconnect:
        pass
    except RuntimeError as e:
        # Starlette raises "WebSocket is not connected" instead of
        # WebSocketDisconnect when the client cuts the TCP stream
        # mid-frame (page reload, hot-restart, abrupt close). Treat
        # as a normal disconnect so it doesn't pollute the error log.
        msg = str(e)
        if "not connected" in msg or 'call "accept"' in msg:
            logger.debug("WebSocket disconnected mid-frame: %s", e)
        else:
            logger.error("WebSocket runtime error: %s", e)
    except Exception as e:
        logger.error("WebSocket error: %s", e)
    finally:
        unregister(ws)
        logger.info("WebSocket client disconnected (%d remaining)", connection_count())
