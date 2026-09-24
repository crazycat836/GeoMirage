"""The WS payload check itself (models.ws_events.check_ws_event).

conftest turns the check on for the whole suite and fails any test that
emits a payload its model doesn't describe. These tests pin that the
check catches each kind of drift, and that StateChangeEvent describes
the mode-start payloads the engine really sends.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from models import ws_events  # noqa: E402


def _violations_for(event_type: str, data, **kw) -> list[str]:
    ws_events.VIOLATIONS.clear()
    ws_events.check_ws_event(event_type, data, **kw)
    found = list(ws_events.VIOLATIONS)
    ws_events.VIOLATIONS.clear()
    return found


def test_validation_is_on_in_tests():
    assert ws_events.VALIDATE_ENABLED


@pytest.mark.parametrize("payload", [
    {"state": "idle", "udid": "u"},
    {"state": "navigating", "destination": {"lat": 25.0, "lng": 121.5}},
    {"state": "looping", "waypoints": [{"lat": 25.0, "lng": 121.5}]},
    {"state": "multi_stop", "waypoints": [{"lat": 25.0, "lng": 121.5}],
     "stop_duration": 5, "loop": True},
    {"state": "random_walk", "center": {"lat": 25.0, "lng": 121.5}, "radius_m": 300.0},
    {"state": "paused", "paused_from": "navigating"},
    {"state": "paused", "paused_from": None},
])
def test_state_change_matches_real_payloads(payload):
    assert _violations_for("state_change", payload) == []


@pytest.mark.parametrize(("event_type", "payload", "needle"), [
    ("state_change", {"state": "idle", "detail": {}}, "undeclared fields ['detail']"),
    ("state_change", {}, "state"),
    ("state_change", {"state": 3}, "state"),
    ("no_such_event", {}, "unknown event type"),
    ("position_update", {"lat": 1.0}, "lng"),
])
def test_mismatch_is_recorded(event_type, payload, needle):
    found = _violations_for(event_type, payload)
    assert len(found) == 1
    assert needle in found[0]


def test_engine_emit_allows_udid_added_later():
    payload = {"stage": "simulation:joystick", "error": "boom"}
    assert _violations_for("device_error", payload, udid_added_later=True) == []
    assert _violations_for("device_error", payload) != []


def test_broadcast_checks_payload():
    from services import ws_broadcaster

    ws_events.VIOLATIONS.clear()
    asyncio.run(ws_broadcaster.broadcast("state_change", {"state": "idle", "detail": {}}))
    assert len(ws_events.VIOLATIONS) == 1
    ws_events.VIOLATIONS.clear()
