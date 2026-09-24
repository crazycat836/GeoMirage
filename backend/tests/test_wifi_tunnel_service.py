"""Tests for TunnelRunner.transport_alive and cleanup_wifi_connections.

The two surfaces fix the May 15 stale-tunnel bug from different angles:

  * ``TunnelRunner.transport_alive`` introspects pymobiledevice3's
    internal ``_tun_read_task`` / ``_sock_read_task`` so the liveness
    probe can see when those tasks have silently exited (the library
    catches ``ConnectionResetError`` and returns instead of raising).

  * ``cleanup_wifi_connections`` now routes every disconnect through
    ``services.connection_state.disconnect_device`` — the SSoT installed
    in commit ``3dc3bb4`` — instead of calling ``dm.disconnect`` and
    ``emit_device_disconnected`` directly. That ensures the state
    machine and WS broadcast stay in lockstep no matter who triggered
    the teardown.

Both surfaces are tested with mocks so the suite stays hermetic.
"""

from __future__ import annotations

import asyncio
import sys
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))


# ─── TunnelRunner.transport_alive direct unit tests ──────────────────


def _fake_task(*, done: bool):
    """Return a stand-in for an asyncio.Task whose ``.done()`` is fixed."""
    t = MagicMock()
    t.done = MagicMock(return_value=done)
    return t


def _runner_with_client(client):
    """Build a TunnelRunner with ``_client`` pre-populated. We bypass
    ``_run`` to avoid touching pymobiledevice3 / the real network."""
    from core.wifi_tunnel import TunnelRunner
    r = TunnelRunner()
    r._client = client
    return r


def test_transport_alive_returns_true_when_no_client():
    """No tunnel running yet (or already torn down) → not a "dead"
    signal. ``is_running()`` is the proper "running?" guard upstream;
    don't double-fail here."""
    from core.wifi_tunnel import TunnelRunner
    r = TunnelRunner()
    assert r.transport_alive() is True


def test_transport_alive_returns_true_when_both_tasks_running():
    """Healthy tunnel: neither read task has exited."""
    client = SimpleNamespace(
        _tun_read_task=_fake_task(done=False),
        _sock_read_task=_fake_task(done=False),
    )
    r = _runner_with_client(client)
    assert r.transport_alive() is True


def test_transport_alive_returns_false_when_tun_read_task_done():
    """tun_read_task.done() == True → pymobiledevice3 swallowed an
    upstream disconnect and exited the Mac→iPhone read loop. The data
    path is one-way dead even if the OS tun interface is still up.

    This is the May 15 incident scenario.
    """
    client = SimpleNamespace(
        _tun_read_task=_fake_task(done=True),
        _sock_read_task=_fake_task(done=False),
    )
    r = _runner_with_client(client)
    assert r.transport_alive() is False


def test_transport_alive_returns_false_when_sock_read_task_done():
    """Sock-read direction dead is also fatal — iPhone→Mac frames stop
    arriving even though writes from Mac still queue."""
    client = SimpleNamespace(
        _tun_read_task=_fake_task(done=False),
        _sock_read_task=_fake_task(done=True),
    )
    r = _runner_with_client(client)
    assert r.transport_alive() is False


def test_transport_alive_returns_true_on_missing_attrs():
    """A pymobiledevice3 upgrade that renames the internal attrs must
    not false-positive into a tunnel teardown — defaults to True so
    we behave like the pre-patch loop in unknown-library-shape cases.
    """
    client = SimpleNamespace()  # neither attribute exists
    r = _runner_with_client(client)
    assert r.transport_alive() is True


def test_transport_alive_returns_true_when_done_raises():
    """If introspecting the task itself raises (e.g. attribute exists
    but is not actually a Task), default to True rather than crash."""
    bogus = MagicMock()
    bogus.done = MagicMock(side_effect=RuntimeError("not a task"))
    client = SimpleNamespace(
        _tun_read_task=bogus,
        _sock_read_task=_fake_task(done=False),
    )
    r = _runner_with_client(client)
    # tun_read_task introspection failed → fall through to sock_read_task
    # check, which is alive → overall alive.
    assert r.transport_alive() is True


# ─── cleanup_wifi_connections SSoT routing tests ─────────────────────


@pytest.fixture(autouse=True)
def _reset_state_and_dedup() -> Iterator[None]:
    """Tests in this section exercise the SSoT path which mutates
    ``connection_state.store`` and ``disconnect_dedup``; reset both
    so cross-test residue can't bleed."""
    from services import connection_state, disconnect_dedup
    connection_state.reset_for_tests()
    disconnect_dedup.reset_for_tests()
    yield
    connection_state.reset_for_tests()
    disconnect_dedup.reset_for_tests()


def _patch_wifi_service_deps(monkeypatch, *, network_udids: list[str]):
    """Stand up a fake AppState + DeviceManager + connection_state on
    ctx.app_state, returning the patched ``disconnect_device`` mock
    so tests can assert per-udid invocation."""
    from context import ctx
    from services import wifi_tunnel_service as svc

    dm = MagicMock()
    dm.udids_by_connection_type = MagicMock(return_value=list(network_udids))
    dm.disconnect = AsyncMock()  # SSoT layer wraps this, must accept calls

    app_state = SimpleNamespace(
        device_manager=dm,
        terminate_engine=AsyncMock(),
    )
    monkeypatch.setattr(ctx, "app_state", app_state, raising=False)

    # Patch the SSoT helper at the wifi_tunnel_service import site so
    # we can confirm cleanup goes through it instead of bypassing.
    disconnect_mock = AsyncMock()
    monkeypatch.setattr(
        svc.connection_state, "disconnect_device", disconnect_mock,
        raising=True,
    )
    return dm, app_state, disconnect_mock


def test_cleanup_routes_through_connection_state(monkeypatch):
    """Every Network UDID must be disconnected via
    ``connection_state.disconnect_device(dm, udid, cause="wifi_dropped")``,
    not ``dm.disconnect(udid)`` directly. This is what the SSoT
    refactor was for — without it, the WS broadcast and the state
    machine drift out of sync.
    """
    from services.wifi_tunnel_service import cleanup_wifi_connections

    dm, app_state, disconnect_mock = _patch_wifi_service_deps(
        monkeypatch, network_udids=["udid-A", "udid-B"],
    )

    result = asyncio.run(cleanup_wifi_connections(reason="tunnel_lost_liveness"))

    # Per-udid SSoT call with the wifi-dropped cause.
    assert disconnect_mock.await_count == 2
    disconnect_mock.assert_any_await(dm, "udid-A", cause="wifi_dropped")
    disconnect_mock.assert_any_await(dm, "udid-B", cause="wifi_dropped")

    # dm.disconnect must NOT have been called directly — that's the
    # bypass we're guarding against.
    dm.disconnect.assert_not_awaited()

    # Returned list matches the udids that were disconnected.
    assert sorted(result) == ["udid-A", "udid-B"]


def test_cleanup_terminates_engine_before_disconnect(monkeypatch):
    """Engine teardown happens *before* transport teardown so a
    running Navigate / RandomWalk loop doesn't fire location_service
    calls against a dead RSD between the two steps."""
    from services.wifi_tunnel_service import cleanup_wifi_connections

    call_order: list[str] = []
    dm, app_state, disconnect_mock = _patch_wifi_service_deps(
        monkeypatch, network_udids=["udid-A"],
    )
    app_state.terminate_engine.side_effect = lambda udid: call_order.append(
        f"terminate:{udid}",
    )
    disconnect_mock.side_effect = lambda *args, **kw: call_order.append(
        f"disconnect:{args[1]}",
    )

    asyncio.run(cleanup_wifi_connections())

    assert call_order == ["terminate:udid-A", "disconnect:udid-A"], (
        f"engine teardown must precede transport teardown, got {call_order}"
    )


def test_cleanup_no_network_devices_is_noop(monkeypatch):
    """Empty Network-device list → no calls into SSoT or engine
    teardown. Return value is the same empty list."""
    from services.wifi_tunnel_service import cleanup_wifi_connections

    dm, app_state, disconnect_mock = _patch_wifi_service_deps(
        monkeypatch, network_udids=[],
    )

    result = asyncio.run(cleanup_wifi_connections())

    assert result == []
    disconnect_mock.assert_not_awaited()
    app_state.terminate_engine.assert_not_awaited()


def test_cleanup_swallows_per_udid_failures(monkeypatch):
    """One failing disconnect must not block the others. The May 15
    cleanup loop logged exceptions per udid and moved on — we keep
    that resilience here so a single transport hiccup doesn't strand
    other devices in DEGRADED limbo.
    """
    from services.wifi_tunnel_service import cleanup_wifi_connections

    dm, app_state, disconnect_mock = _patch_wifi_service_deps(
        monkeypatch, network_udids=["udid-A", "udid-B"],
    )

    async def _maybe_fail(_dm, udid, **_kw):
        if udid == "udid-A":
            raise RuntimeError("simulated transport hiccup")

    disconnect_mock.side_effect = _maybe_fail

    # Should NOT raise — the per-udid failure is logged + swallowed.
    asyncio.run(cleanup_wifi_connections())

    # Both UDIDs were attempted even though udid-A failed.
    assert disconnect_mock.await_count == 2


def test_cleanup_skips_usbmux_network_devices(monkeypatch):
    """Stopping the WiFi tunnel disconnects only the device that rides
    it; a usbmux Network (Wi-Fi sync) device keeps its connection."""
    from context import ctx
    from core.device_manager import DeviceManager, _ActiveConnection
    from services.wifi_tunnel_service import cleanup_wifi_connections

    dm = DeviceManager()
    dm._connections = {
        "tunnel-A": _ActiveConnection(
            udid="tunnel-A", lockdown=object(), ios_version="26.0",
            connection_type="Network", via_tunnel=True,
        ),
        "usbmux-B": _ActiveConnection(
            udid="usbmux-B", lockdown=object(), ios_version="26.0",
            connection_type="Network",
        ),
    }
    app_state = SimpleNamespace(device_manager=dm, terminate_engine=AsyncMock())
    monkeypatch.setattr(ctx, "app_state", app_state, raising=False)

    result = asyncio.run(cleanup_wifi_connections())

    assert result == ["tunnel-A"]
    assert dm.connected_udids == ["usbmux-B"]
    app_state.terminate_engine.assert_awaited_once_with("tunnel-A")


# ─── reconnect_usb_over_wifi metadata ────────────────────────────────


def test_usb_to_wifi_fallback_announces_tunnel_metadata(monkeypatch):
    """After USB→WiFi fallback the unplugged device is gone from usbmux,
    so metadata must come from the tunnel's own DeviceInfo. Otherwise the
    re-announce broadcast ``name ""`` / ``connection_type "USB"`` and
    ``/api/device/list`` replayed the same wrong values."""
    from api.device import list_devices
    from context import ctx
    from models.schemas import DeviceInfo
    from services import connection_state
    from services import wifi_tunnel_service as svc
    from services.connection_state import DeviceState, store

    new_info = DeviceInfo(
        udid="u1", name="Gary iPhone", ios_version="26.5",
        connection_type="Network", is_connected=True,
    )
    dm = MagicMock()
    dm.disconnect = AsyncMock()
    dm.connect_wifi_tunnel = AsyncMock(return_value=new_info)
    dm.discover_devices = AsyncMock(return_value=[])  # USB unplugged
    app_state = SimpleNamespace(
        device_manager=dm,
        terminate_engine=AsyncMock(),
        create_engine_for_device=AsyncMock(),
    )
    monkeypatch.setattr(ctx, "app_state", app_state, raising=False)

    fake_tunnel = SimpleNamespace(
        is_running=lambda: True,
        transport_alive=lambda: True,
        info={"rsd_address": "fd00::1", "rsd_port": 5555},
    )
    monkeypatch.setattr(svc, "tunnel", fake_tunnel)

    async def _run():
        connection_state.install_ws_observer()
        await store.transition(
            "u1", DeviceState.CONNECTED, cause="auto_usb",
            metadata={"name": "Gary iPhone", "ios_version": "26.5", "connection_type": "USB"},
        )
        with patch("services.connection_state.broadcast", new=AsyncMock()) as mock_bcast:
            ok = await svc.reconnect_usb_over_wifi("u1")
        listed = await list_devices()
        return ok, mock_bcast, listed

    ok, mock_bcast, listed = asyncio.run(_run())

    assert ok is True
    connected = [
        c.args[1] for c in mock_bcast.await_args_list
        if c.args and c.args[0] == "device_connected"
    ]
    assert connected == [{
        "udid": "u1",
        "name": "Gary iPhone",
        "ios_version": "26.5",
        "connection_type": "Network",
    }]
    assert [(d.udid, d.name, d.ios_version, d.connection_type) for d in listed] == [
        ("u1", "Gary iPhone", "26.5", "Network"),
    ]


def test_usb_fallback_leaves_other_devices_tunnel_alone(monkeypatch):
    """A on USB, B on the only WiFi tunnel. Unplugging A must not connect
    through B's tunnel: B's connection record and engine stay as they
    are and the fallback reports False."""
    from context import ctx
    from core.device_manager import DeviceManager, _ActiveConnection
    from services import wifi_tunnel_service as svc

    dm = DeviceManager()
    conn_b = _ActiveConnection(
        udid="B", lockdown=object(), ios_version="26.0",
        connection_type="Network", via_tunnel=True,
    )
    dm._connections = {
        "A": _ActiveConnection(udid="A", lockdown=object(), ios_version="26.0"),
        "B": conn_b,
    }
    dm.connect_wifi_tunnel = AsyncMock()
    engines = {"A": object(), "B": object()}
    app_state = SimpleNamespace(
        device_manager=dm,
        terminate_engine=AsyncMock(),
        create_engine_for_device=AsyncMock(),
        simulation_engines=engines,
    )
    monkeypatch.setattr(ctx, "app_state", app_state, raising=False)
    monkeypatch.setattr(svc, "tunnel", SimpleNamespace(
        is_running=lambda: True,
        transport_alive=lambda: True,
        info={"rsd_address": "fd00::1", "rsd_port": 5555},
    ))

    ok = asyncio.run(svc.reconnect_usb_over_wifi("A"))

    assert ok is False
    assert dm.get_connection("B") is conn_b
    assert "B" in engines
    dm.connect_wifi_tunnel.assert_not_awaited()
    for call in app_state.terminate_engine.await_args_list:
        assert call.args[0] != "B"
