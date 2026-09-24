"""Tests for api.websocket._send_initial_state.

The function is the new client's only on-connect read of the device list,
so it has to come from the unified ``services.connection_state`` store
instead of re-running ``discover_devices``. These tests pin that contract:

  * Snapshot lists every CONNECTED + DEGRADED device with the cached
    metadata payload the renderer expects.
  * DEGRADED devices also receive a follow-up ``tunnel_degraded`` frame
    so the renderer chip shows "reconnecting…" without waiting for the
    next transition.
  * ``DeviceManager.discover_devices`` is **not** invoked — that's the
    whole point of routing through the SSoT.

A minimal AppState stub (no DeviceManager, no engines, fixed cooldown
payload) is patched into ``context.ctx`` so the function only depends on
state we set up in each test.
"""

from __future__ import annotations

import asyncio
import json
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))


class _StubCooldown:
    def get_status(self) -> dict[str, Any]:
        return {"active": False, "remaining_sec": 0}


class _StubAppState:
    """Just enough of AppState for _send_initial_state to run.

    Real AppState pulls in BookmarkManager, settings I/O, the WS
    broadcaster — none of which the function actually touches. Keeping
    the stub tiny means a future AppState refactor can't accidentally
    break these tests.
    """

    def __init__(self) -> None:
        self.simulation_engines: dict[str, Any] = {}
        self.cooldown_timer = _StubCooldown()


@pytest.fixture(autouse=True)
def _reset_state_and_ctx() -> Iterator[None]:
    """Wipe connection_state + dedup + swap ctx.app_state for the stub."""
    from context import ctx
    from services import connection_state, disconnect_dedup

    connection_state.reset_for_tests()
    disconnect_dedup.reset_for_tests()
    original = getattr(ctx, "app_state", None)
    ctx.app_state = _StubAppState()
    try:
        yield
    finally:
        connection_state.reset_for_tests()
        disconnect_dedup.reset_for_tests()
        if original is not None:
            ctx.app_state = original


def _make_fake_ws() -> AsyncMock:
    """A WebSocket double that records every ``send_text`` call."""
    ws = AsyncMock()
    ws.send_text = AsyncMock()
    return ws


def _frames(ws: AsyncMock) -> list[dict[str, Any]]:
    """Parse every captured frame as JSON for easy assertions."""
    return [json.loads(c.args[0]) for c in ws.send_text.call_args_list]


def _by_type(frames: list[dict[str, Any]], type_: str) -> list[dict[str, Any]]:
    return [f for f in frames if f.get("type") == type_]


# ─── Empty-store path ────────────────────────────────────────────────

def test_empty_store_sends_empty_snapshot():
    """No devices known → device_snapshot.data.devices == []."""
    from api.websocket import _send_initial_state

    ws = _make_fake_ws()
    asyncio.run(_send_initial_state(ws))

    snaps = _by_type(_frames(ws), "device_snapshot")
    assert len(snaps) == 1
    assert snaps[0]["data"] == {"devices": []}


def test_empty_store_does_not_call_discover_devices():
    """SSoT principle: no usbmux round-trip just to build the snapshot."""
    from api.websocket import _send_initial_state
    from context import ctx

    discover = AsyncMock(return_value=[])
    # If the function ever reaches for a DeviceManager, blow up the test —
    # the whole point is that it shouldn't.
    ctx.app_state.device_manager = type("DM", (), {"discover_devices": discover})()

    ws = _make_fake_ws()
    asyncio.run(_send_initial_state(ws))

    discover.assert_not_called()


# ─── Populated-store path ────────────────────────────────────────────

def test_connected_device_appears_in_snapshot():
    """CONNECTED device → present in snapshot with cached metadata."""
    from api.websocket import _send_initial_state
    from services.connection_state import store, DeviceState

    async def _run() -> list[dict[str, Any]]:
        await store.transition(
            "udid-A", DeviceState.CONNECTED, cause="user",
            metadata={
                "name": "Test iPhone",
                "ios_version": "26.5",
                "connection_type": "USB",
            },
        )
        ws = _make_fake_ws()
        await _send_initial_state(ws)
        return _frames(ws)

    frames = asyncio.run(_run())
    snaps = _by_type(frames, "device_snapshot")
    assert len(snaps) == 1
    devices = snaps[0]["data"]["devices"]
    assert devices == [{
        "udid": "udid-A",
        "name": "Test iPhone",
        "ios_version": "26.5",
        "connection_type": "USB",
    }]
    # CONNECTED (not DEGRADED) → no extra tunnel_degraded.
    assert _by_type(frames, "tunnel_degraded") == []


def test_disconnected_device_excluded():
    """An explicitly DISCONNECTED entry must not leak into the list."""
    from api.websocket import _send_initial_state
    from services.connection_state import store, DeviceState

    async def _run() -> list[dict[str, Any]]:
        # First connect, then disconnect — leaves the store with a known
        # DISCONNECTED entry rather than just "unknown UDID".
        await store.transition(
            "udid-A", DeviceState.CONNECTED, cause="user",
            metadata={"name": "A", "ios_version": "26.5", "connection_type": "USB"},
        )
        await store.transition("udid-A", DeviceState.DISCONNECTED, cause="user")
        ws = _make_fake_ws()
        await _send_initial_state(ws)
        return _frames(ws)

    snaps = _by_type(asyncio.run(_run()), "device_snapshot")
    assert snaps[0]["data"] == {"devices": []}


def test_degraded_device_in_snapshot_and_emits_tunnel_degraded():
    """DEGRADED → still in the device list, plus a tunnel_degraded follow-up."""
    from api.websocket import _send_initial_state
    from services import connection_state
    from services.connection_state import store, DeviceState

    async def _run() -> list[dict[str, Any]]:
        await store.transition(
            "udid-A", DeviceState.CONNECTED, cause="user",
            metadata={"name": "A", "ios_version": "26.5", "connection_type": "Network"},
        )
        await connection_state.mark_degraded("udid-A", cause="dvt_channel_dropped")
        ws = _make_fake_ws()
        await _send_initial_state(ws)
        return _frames(ws)

    frames = asyncio.run(_run())
    snaps = _by_type(frames, "device_snapshot")
    assert len(snaps) == 1
    assert snaps[0]["data"]["devices"][0]["udid"] == "udid-A"
    # Metadata survives the DEGRADED flip (see test_connection_state).
    assert snaps[0]["data"]["devices"][0]["connection_type"] == "Network"

    degraded = _by_type(frames, "tunnel_degraded")
    assert len(degraded) == 1
    assert degraded[0]["data"]["udid"] == "udid-A"
    # Cause is a synthetic "snapshot" tag — store doesn't remember the
    # original cause, and the renderer only cares about the event firing.
    assert degraded[0]["data"]["reason"] == "snapshot"


def test_two_devices_one_connected_one_degraded():
    """Multi-device mode: each device represented exactly once."""
    from api.websocket import _send_initial_state
    from services import connection_state
    from services.connection_state import store, DeviceState

    async def _run() -> list[dict[str, Any]]:
        await store.transition(
            "udid-A", DeviceState.CONNECTED, cause="user",
            metadata={"name": "A", "ios_version": "26.5", "connection_type": "USB"},
        )
        await store.transition(
            "udid-B", DeviceState.CONNECTED, cause="user",
            metadata={"name": "B", "ios_version": "17.4", "connection_type": "USB"},
        )
        await connection_state.mark_degraded("udid-B", cause="dvt_channel_dropped")
        ws = _make_fake_ws()
        await _send_initial_state(ws)
        return _frames(ws)

    frames = asyncio.run(_run())
    udids = {d["udid"] for d in _by_type(frames, "device_snapshot")[0]["data"]["devices"]}
    assert udids == {"udid-A", "udid-B"}
    degraded_udids = [f["data"]["udid"] for f in _by_type(frames, "tunnel_degraded")]
    assert degraded_udids == ["udid-B"]


# ─── On-connect DVT health probe ──────────────────────────────────────
#
# These tests pin the "validate on demand" safety net that fires after
# the cached device_snapshot is sent. The probe is async + debounced so
# the WS handshake itself isn't slowed; a dead DVT channel surfaces via
# ``mark_degraded`` within a couple of hundred ms instead of waiting for
# the user to click teleport (the May 15 incident: user noticed the
# stale tunnel 50s after the renderer reload).


def _make_dvt_location_service(udid: str, *, ensure_should_raise: Exception | None):
    """Build a real DvtLocationService whose ``_ensure_instrument`` is an
    AsyncMock, so the public ``probe_channel_alive`` path (lock, timeout,
    exception classification) is exercised for real.

    Returns ``(service, ensure_mock)`` so tests can assert the instrument
    handshake ran exactly once per debounce window.
    """
    from services.location_service import DvtLocationService

    ensure_mock = AsyncMock()
    if ensure_should_raise is not None:
        ensure_mock.side_effect = ensure_should_raise

    service = DvtLocationService(MagicMock(), udid=udid)
    service._ensure_instrument = ensure_mock  # type: ignore[method-assign]
    return service, ensure_mock


def _install_dm_with_conn(udid: str, *, ensure_should_raise: Exception | None):
    """Wire a fake DeviceManager + connection record onto ctx.app_state.

    Returns the AsyncMock backing ``_ensure_instrument`` so tests can
    assert it was called exactly once per debounce window.
    """
    from context import ctx

    location_service, ensure_mock = _make_dvt_location_service(
        udid, ensure_should_raise=ensure_should_raise,
    )

    conn = MagicMock()
    conn.location_service = location_service

    dm = MagicMock()
    dm.get_connection = MagicMock(return_value=conn)

    ctx.app_state.device_manager = dm
    return ensure_mock


def _reset_debounce_dict():
    """Reset the device_health probe debounce so repeated tests
    against the same UDID don't poison each other."""
    from services import device_health
    device_health.reset_for_tests()


async def _wait_for_probe_tasks() -> None:
    """Drain the device_health probe task set so a test can
    deterministically assert on the side effects (mark_degraded etc.)
    instead of racing with asyncio.run cleanup."""
    from services import device_health
    await device_health.drain_probe_tasks_for_tests()


def test_probe_skipped_when_no_device_manager():
    """When ``ctx.app_state.device_manager`` is missing (test stub),
    no probe task should be created — original behavior of the
    other tests in this file must stay deterministic.
    """
    from api.websocket import _send_initial_state
    from services import device_health
    from services.connection_state import store, DeviceState

    _reset_debounce_dict()

    async def _run() -> None:
        await store.transition(
            "udid-A", DeviceState.CONNECTED, cause="user",
            metadata={"name": "A", "ios_version": "26.5", "connection_type": "USB"},
        )
        ws = _make_fake_ws()
        await _send_initial_state(ws)

    asyncio.run(_run())
    # No DM means no debounce slot recorded — confirms the early-return.
    assert "udid-A" not in device_health._last_probe_at


def test_probe_spawned_for_connected_device():
    """With a DM in place and a CONNECTED udid in the store, the
    initial-state path should kick off ``_ensure_instrument()`` against
    the device's location_service."""
    from api.websocket import _send_initial_state
    from services.connection_state import store, DeviceState

    _reset_debounce_dict()

    async def _run() -> None:
        ensure_mock = _install_dm_with_conn(
            "udid-A", ensure_should_raise=None,
        )
        await store.transition(
            "udid-A", DeviceState.CONNECTED, cause="user",
            metadata={"name": "A", "ios_version": "26.5", "connection_type": "USB"},
        )
        ws = _make_fake_ws()
        await _send_initial_state(ws)
        await _wait_for_probe_tasks()
        ensure_mock.assert_awaited_once()

    asyncio.run(_run())


def test_probe_failure_marks_device_degraded():
    """A probe that raises a known channel-dead exception should
    transition the device to DEGRADED via the unified store so the
    existing DvtLocationService._reconnect ladder fires for the
    next teleport call."""
    from pymobiledevice3.exceptions import ConnectionTerminatedError

    from api.websocket import _send_initial_state
    from services.connection_state import store, DeviceState

    _reset_debounce_dict()

    async def _run() -> DeviceState:
        _install_dm_with_conn(
            "udid-A",
            ensure_should_raise=ConnectionTerminatedError("channel dead"),
        )
        await store.transition(
            "udid-A", DeviceState.CONNECTED, cause="user",
            metadata={"name": "A", "ios_version": "26.5", "connection_type": "USB"},
        )
        ws = _make_fake_ws()
        await _send_initial_state(ws)
        await _wait_for_probe_tasks()
        return store.get("udid-A")

    final_state = asyncio.run(_run())
    assert final_state == DeviceState.DEGRADED, (
        f"expected DEGRADED after probe failure, got {final_state}"
    )


def test_probe_debounce_within_window():
    """Two consecutive _send_initial_state calls for the same UDID
    inside the debounce window must result in only one
    ``_ensure_instrument`` invocation. Models the renderer reload
    burst (connect → disconnect → connect within ~30ms) that
    otherwise double-probes."""
    from api.websocket import _send_initial_state
    from services.connection_state import store, DeviceState

    _reset_debounce_dict()

    async def _run():
        ensure_mock = _install_dm_with_conn(
            "udid-A", ensure_should_raise=None,
        )
        await store.transition(
            "udid-A", DeviceState.CONNECTED, cause="user",
            metadata={"name": "A", "ios_version": "26.5", "connection_type": "USB"},
        )

        # First connect — should probe.
        await _send_initial_state(_make_fake_ws())
        await _wait_for_probe_tasks()
        assert ensure_mock.await_count == 1

        # Second connect "immediately" (renderer reload) — must NOT probe again.
        await _send_initial_state(_make_fake_ws())
        await _wait_for_probe_tasks()
        assert ensure_mock.await_count == 1, (
            "debounce failed — _ensure_instrument was called twice in "
            "the same window"
        )

    asyncio.run(_run())


def test_probe_handles_unknown_exception_without_degrading():
    """An unexpected exception from _ensure_instrument (NOT in the
    known channel-dead set) must be swallowed without downgrading
    the device — false-positives would flap the UI."""
    from api.websocket import _send_initial_state
    from services.connection_state import store, DeviceState

    _reset_debounce_dict()

    async def _run() -> DeviceState:
        _install_dm_with_conn(
            "udid-A",
            ensure_should_raise=ValueError("unexpected"),
        )
        await store.transition(
            "udid-A", DeviceState.CONNECTED, cause="user",
            metadata={"name": "A", "ios_version": "26.5", "connection_type": "USB"},
        )
        ws = _make_fake_ws()
        await _send_initial_state(ws)
        await _wait_for_probe_tasks()
        return store.get("udid-A")

    final_state = asyncio.run(_run())
    assert final_state == DeviceState.CONNECTED, (
        f"unknown probe exception must not downgrade, got {final_state}"
    )


def test_probe_skipped_for_legacy_location_service():
    """LegacyLocationService (iOS < 17) has no DVT channel to probe;
    its ``probe_channel_alive`` (the base-class default) must report
    "can't safely check, assume alive" rather than degrade the device.
    """
    from api.websocket import _send_initial_state
    from context import ctx
    from services.connection_state import store, DeviceState
    from services.location_service import LegacyLocationService

    _reset_debounce_dict()

    async def _run() -> DeviceState:
        # Real legacy service (iOS < 17 path) — its probe_channel_alive
        # is the LocationService base default that always reports alive.
        legacy_loc = LegacyLocationService(MagicMock())
        conn = MagicMock()
        conn.location_service = legacy_loc

        dm = MagicMock()
        dm.get_connection = MagicMock(return_value=conn)
        ctx.app_state.device_manager = dm

        await store.transition(
            "udid-A", DeviceState.CONNECTED, cause="user",
            metadata={"name": "A", "ios_version": "16.4", "connection_type": "USB"},
        )
        ws = _make_fake_ws()
        await _send_initial_state(ws)
        await _wait_for_probe_tasks()
        return store.get("udid-A")

    final_state = asyncio.run(_run())
    assert final_state == DeviceState.CONNECTED


# ─── Transport-level liveness probe (closes the watchdog gap) ─────────
#
# The DVT instrument check above is a no-op when ``_location_sim`` is
# already cached (user already teleported in this session). When the
# phone is freshly disconnected — e.g. iPhone left WiFi 8s ago, renderer
# reloaded, WS just reconnected — the snapshot would still paint a
# "connected" pill because:
#   * The DVT probe finds the cached LocationSimulation and returns true.
#   * usbmux_presence_watchdog needs ~3s, tunnel_liveness_loop needs ~15s.
#
# The transport-level probe forces a synchronous TCP / usbmux round-trip
# and routes any provably-dead device through ``disconnect_device`` so
# the SSoT + WS observer fire together. Tests below pin the contract.


def _install_dm_with_type(udid: str, conn_type: str, *, via_tunnel: bool = True):
    """Wire a fake DM whose ``get_connection_type`` returns *conn_type*.

    Sets up a benign DVT mock (``_ensure_instrument`` succeeds) so the
    only state transitions observed in transport tests originate from
    the transport probe, not the DVT fallback. Also seeds
    ``app_state.terminate_engine`` and ``dm.disconnect`` as AsyncMocks
    since the disconnect path calls both.
    """
    from context import ctx

    location_service, _ = _make_dvt_location_service(
        udid, ensure_should_raise=None,
    )

    conn = MagicMock()
    conn.location_service = location_service
    conn.connection_type = conn_type

    dm = MagicMock()
    dm.get_connection = MagicMock(return_value=conn)
    dm.get_connection_type = MagicMock(return_value=conn_type)
    dm.is_via_wifi_tunnel = MagicMock(
        return_value=conn_type == "Network" and via_tunnel,
    )
    dm.disconnect = AsyncMock()

    ctx.app_state.device_manager = dm
    ctx.app_state.terminate_engine = AsyncMock()
    return dm


def test_dead_wifi_tunnel_marks_device_disconnected(monkeypatch):
    """Network device + tunnel torn down → DISCONNECTED.

    Models the case where the WiFi tunnel went away (Mac woke from
    sleep, user disabled WiFi, etc.) but ``connection_state.store``
    still has the device CONNECTED because the liveness loop's 15s
    threshold hasn't fired yet.
    """
    from api.websocket import _send_initial_state
    from services.connection_state import store, DeviceState
    from services import wifi_tunnel_service

    _reset_debounce_dict()

    monkeypatch.setattr(wifi_tunnel_service.tunnel, "task", None, raising=False)
    monkeypatch.setattr(wifi_tunnel_service.tunnel, "info", None, raising=False)

    async def _run() -> DeviceState:
        _install_dm_with_type("udid-A", "Network")
        await store.transition(
            "udid-A", DeviceState.CONNECTED, cause="user",
            metadata={"name": "A", "ios_version": "26.5", "connection_type": "Network"},
        )
        ws = _make_fake_ws()
        await _send_initial_state(ws)
        await _wait_for_probe_tasks()
        return store.get("udid-A")

    final_state = asyncio.run(_run())
    assert final_state == DeviceState.DISCONNECTED, (
        f"expected DISCONNECTED when WiFi tunnel is down, got {final_state}"
    )


def _usbmux_network_scenario(monkeypatch, listed: list[str]):
    """usbmux Network device (Finder Wi-Fi sync, no in-process tunnel),
    in-process tunnel not running, usbmux listing *listed* as Network.
    Returns the device's state after a WS (re)connect probe."""
    from api.websocket import _send_initial_state
    from services.connection_state import store, DeviceState
    from services import wifi_tunnel_service

    _reset_debounce_dict()
    monkeypatch.setattr(wifi_tunnel_service.tunnel, "task", None, raising=False)
    monkeypatch.setattr(wifi_tunnel_service.tunnel, "info", None, raising=False)

    class _FakeDev:
        def __init__(self, serial):
            self.serial = serial
            self.connection_type = "Network"

    async def _list():
        return [_FakeDev(u) for u in listed]
    import pymobiledevice3.usbmux as _usbmux_mod
    monkeypatch.setattr(_usbmux_mod, "list_devices", _list, raising=True)

    async def _run() -> DeviceState:
        _install_dm_with_type("udid-A", "Network", via_tunnel=False)
        await store.transition(
            "udid-A", DeviceState.CONNECTED, cause="user",
            metadata={"name": "A", "ios_version": "26.5", "connection_type": "Network"},
        )
        await _send_initial_state(_make_fake_ws())
        await _wait_for_probe_tasks()
        return store.get("udid-A")

    return asyncio.run(_run())


def test_usbmux_network_device_survives_ws_reconnect(monkeypatch):
    """A usbmux Network connection has no in-process tunnel, so a
    stopped TunnelRunner must not count as its transport dying."""
    from services.connection_state import DeviceState

    assert _usbmux_network_scenario(monkeypatch, ["udid-A"]) == DeviceState.CONNECTED


def test_usbmux_network_device_gone_from_usbmux_disconnects(monkeypatch):
    from services.connection_state import DeviceState

    assert _usbmux_network_scenario(monkeypatch, []) == DeviceState.DISCONNECTED


def test_dead_wifi_transport_marks_device_disconnected(monkeypatch):
    """Network device + tunnel running but transport_alive()=False → DISCONNECTED.

    The pymobiledevice3 read tasks silently exited (iPhone left the WiFi
    network), but the outer tunnel task is still parked on the stop
    event. The on-connect probe must catch this without waiting for the
    liveness loop's 3-miss threshold.
    """
    from api.websocket import _send_initial_state
    from services.connection_state import store, DeviceState
    from services import wifi_tunnel_service

    _reset_debounce_dict()

    class _LiveTask:
        def done(self):
            return False
    monkeypatch.setattr(wifi_tunnel_service.tunnel, "task", _LiveTask(), raising=False)
    monkeypatch.setattr(wifi_tunnel_service.tunnel, "info", {
        "rsd_address": "fd00::1", "rsd_port": 12345,
    }, raising=False)
    monkeypatch.setattr(
        wifi_tunnel_service.tunnel, "transport_alive",
        lambda: False, raising=False,
    )

    async def _run() -> DeviceState:
        _install_dm_with_type("udid-A", "Network")
        await store.transition(
            "udid-A", DeviceState.CONNECTED, cause="user",
            metadata={"name": "A", "ios_version": "26.5", "connection_type": "Network"},
        )
        ws = _make_fake_ws()
        await _send_initial_state(ws)
        await _wait_for_probe_tasks()
        return store.get("udid-A")

    final_state = asyncio.run(_run())
    assert final_state == DeviceState.DISCONNECTED


def test_alive_wifi_transport_keeps_device_connected(monkeypatch):
    """Network device + tunnel running + transport_alive()=True → no transition.

    Negative case: ensures the probe doesn't false-positive into a
    disconnect when everything looks fine.
    """
    from api.websocket import _send_initial_state
    from services.connection_state import store, DeviceState
    from services import wifi_tunnel_service

    _reset_debounce_dict()

    class _LiveTask:
        def done(self):
            return False
    monkeypatch.setattr(wifi_tunnel_service.tunnel, "task", _LiveTask(), raising=False)
    monkeypatch.setattr(wifi_tunnel_service.tunnel, "info", {
        "rsd_address": "fd00::1", "rsd_port": 12345,
    }, raising=False)
    monkeypatch.setattr(
        wifi_tunnel_service.tunnel, "transport_alive",
        lambda: True, raising=False,
    )

    async def _run() -> DeviceState:
        _install_dm_with_type("udid-A", "Network")
        await store.transition(
            "udid-A", DeviceState.CONNECTED, cause="user",
            metadata={"name": "A", "ios_version": "26.5", "connection_type": "Network"},
        )
        ws = _make_fake_ws()
        await _send_initial_state(ws)
        await _wait_for_probe_tasks()
        return store.get("udid-A")

    final_state = asyncio.run(_run())
    assert final_state == DeviceState.CONNECTED


def test_usb_device_missing_from_usbmux_marks_disconnected(monkeypatch):
    """USB device + not present in ``list_devices()`` → DISCONNECTED.

    Closes the ~3s gap before the usbmux watchdog detects an unplug.
    The user can reload the renderer faster than that.
    """
    from api.websocket import _send_initial_state
    from services.connection_state import store, DeviceState

    _reset_debounce_dict()

    async def _empty_list():
        return []
    import pymobiledevice3.usbmux as _usbmux_mod
    monkeypatch.setattr(_usbmux_mod, "list_devices", _empty_list, raising=True)

    async def _run() -> DeviceState:
        _install_dm_with_type("udid-A", "USB")
        await store.transition(
            "udid-A", DeviceState.CONNECTED, cause="user",
            metadata={"name": "A", "ios_version": "26.5", "connection_type": "USB"},
        )
        ws = _make_fake_ws()
        await _send_initial_state(ws)
        await _wait_for_probe_tasks()
        return store.get("udid-A")

    final_state = asyncio.run(_run())
    assert final_state == DeviceState.DISCONNECTED


def test_usb_device_still_in_usbmux_stays_connected(monkeypatch):
    """USB device present in ``list_devices()`` → stays CONNECTED.

    Negative case for the USB transport probe — must not flap when the
    device is still attached.
    """
    from api.websocket import _send_initial_state
    from services.connection_state import store, DeviceState

    _reset_debounce_dict()

    class _FakeDev:
        def __init__(self, serial):
            self.serial = serial
            self.connection_type = "USB"
    async def _present_list():
        return [_FakeDev("udid-A")]
    import pymobiledevice3.usbmux as _usbmux_mod
    monkeypatch.setattr(_usbmux_mod, "list_devices", _present_list, raising=True)

    async def _run() -> DeviceState:
        _install_dm_with_type("udid-A", "USB")
        await store.transition(
            "udid-A", DeviceState.CONNECTED, cause="user",
            metadata={"name": "A", "ios_version": "26.5", "connection_type": "USB"},
        )
        ws = _make_fake_ws()
        await _send_initial_state(ws)
        await _wait_for_probe_tasks()
        return store.get("udid-A")

    final_state = asyncio.run(_run())
    assert final_state == DeviceState.CONNECTED


def test_list_devices_failure_does_not_false_positive(monkeypatch):
    """list_devices() raising → stays CONNECTED.

    The probe must default to "alive" when it cannot reach usbmuxd —
    otherwise a transient usbmux blip would falsely disconnect every
    USB device on every WS reconnect.
    """
    from api.websocket import _send_initial_state
    from services.connection_state import store, DeviceState

    _reset_debounce_dict()

    async def _boom():
        raise ConnectionRefusedError("usbmuxd not reachable")
    import pymobiledevice3.usbmux as _usbmux_mod
    monkeypatch.setattr(_usbmux_mod, "list_devices", _boom, raising=True)

    async def _run() -> DeviceState:
        _install_dm_with_type("udid-A", "USB")
        await store.transition(
            "udid-A", DeviceState.CONNECTED, cause="user",
            metadata={"name": "A", "ios_version": "26.5", "connection_type": "USB"},
        )
        ws = _make_fake_ws()
        await _send_initial_state(ws)
        await _wait_for_probe_tasks()
        return store.get("udid-A")

    final_state = asyncio.run(_run())
    assert final_state == DeviceState.CONNECTED


def test_transport_probe_failure_terminates_engine_before_disconnect(monkeypatch):
    """Engine teardown happens *before* the SSoT disconnect.

    Mirrors the watchdog + cleanup_wifi_connections discipline so a
    running Navigate / RandomWalk loop doesn't keep emitting events
    against a dead transport between the two steps.
    """
    from api.websocket import _send_initial_state
    from context import ctx
    from services.connection_state import store, DeviceState
    from services import wifi_tunnel_service

    _reset_debounce_dict()

    monkeypatch.setattr(wifi_tunnel_service.tunnel, "info", None, raising=False)
    monkeypatch.setattr(wifi_tunnel_service.tunnel, "task", None, raising=False)

    call_order: list[str] = []

    async def _track_terminate(udid):
        call_order.append(f"terminate:{udid}")

    async def _run() -> list[str]:
        dm = _install_dm_with_type("udid-A", "Network")
        ctx.app_state.terminate_engine = _track_terminate  # type: ignore[assignment]

        async def _track_disconnect(udid):
            call_order.append(f"dm.disconnect:{udid}")
        dm.disconnect.side_effect = _track_disconnect

        await store.transition(
            "udid-A", DeviceState.CONNECTED, cause="user",
            metadata={"name": "A", "ios_version": "26.5", "connection_type": "Network"},
        )
        ws = _make_fake_ws()
        await _send_initial_state(ws)
        await _wait_for_probe_tasks()
        return call_order

    order = asyncio.run(_run())
    assert order == ["terminate:udid-A", "dm.disconnect:udid-A"], (
        f"engine teardown must precede transport teardown, got {order}"
    )
