"""Unit tests for the WiFi tunnel liveness probe.

Mocks ``_tcp_probe``, ``cleanup_wifi_connections``, ``tunnel``, and
``ctx.app_state.device_manager`` so the loop can run end-to-end without
pymobiledevice3 / a real iOS device.

Uses ``asyncio.run`` directly inside sync pytest functions so the test
suite doesn't pick up a hard dependency on pytest-asyncio (not currently
in requirements.txt).
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

# Make backend/ importable regardless of where pytest is invoked from.
BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from core import tunnel_liveness  # noqa: E402


def _make_fake_tunnel(*, running: bool = True, generation: int = 1,
                      info: dict | None = None,
                      transport_alive: bool = True):
    """Build a SimpleNamespace that quacks like ``TunnelRunner`` enough for
    the probe loop. Provides an asyncio.Lock so ``async with tunnel.lock``
    works, and the same fields the loop reads from ``info``.

    *transport_alive* controls the deep transport check the loop performs
    in addition to the TCP probe — ``False`` simulates the
    pymobiledevice3 "silent ConnectionResetError" case from May 15.
    """
    return SimpleNamespace(
        lock=asyncio.Lock(),
        is_running=lambda: running,
        info=info if info is not None else {
            "rsd_address": "127.0.0.1",
            "rsd_port": 49152,
        },
        generation=generation,
        stop=AsyncMock(),
        transport_alive=lambda: transport_alive,
    )


def _patch_loop_deps(monkeypatch, *, tunnel, network_udids: list[str],
                     probe_results: list[bool]):
    """Wire all four late-imports the loop performs.

    *probe_results* drives _tcp_probe — index advances per call, repeats the
    last value once exhausted (so an "always-fail" test can pass `[False]`).
    Returns (cleanup_mock, probe_call_counter).
    """
    from context import ctx
    from services import wifi_tunnel_service as wt

    cleanup = AsyncMock(return_value=list(network_udids))
    monkeypatch.setattr(wt, "tunnel", tunnel, raising=True)
    monkeypatch.setattr(wt, "cleanup_wifi_connections", cleanup, raising=True)

    call_idx = {"n": 0}

    async def _probe(addr, port, timeout=2.0):
        i = min(call_idx["n"], len(probe_results) - 1)
        call_idx["n"] += 1
        return probe_results[i]
    monkeypatch.setattr(wt, "_tcp_probe", _probe, raising=True)

    dm = MagicMock()
    dm.udids_by_connection_type = MagicMock(return_value=list(network_udids))
    fake_app_state = SimpleNamespace(device_manager=dm)
    monkeypatch.setattr(ctx, "app_state", fake_app_state, raising=False)

    # Tighten the loop so tests run in milliseconds.
    monkeypatch.setattr(tunnel_liveness, "PROBE_INTERVAL_S", 0.02, raising=True)
    monkeypatch.setattr(tunnel_liveness, "PROBE_TIMEOUT_S", 0.05, raising=True)

    return cleanup, call_idx


async def _run_for(deadline_s: float, *, before_stop=None):
    """Spawn the loop, run for deadline_s (optionally invoking *before_stop*
    midway), then signal stop and await cleanup."""
    stop = asyncio.Event()
    task = asyncio.create_task(tunnel_liveness.tunnel_liveness_loop(stop))
    try:
        if before_stop is not None:
            await before_stop()
        await asyncio.sleep(deadline_s)
    finally:
        stop.set()
        await asyncio.wait_for(task, timeout=2.0)


def test_cleanup_after_threshold_misses(monkeypatch):
    """3 consecutive failed probes → cleanup called with the right reason
    and tunnel.stop() invoked."""
    tunnel = _make_fake_tunnel()
    cleanup, _ = _patch_loop_deps(
        monkeypatch, tunnel=tunnel, network_udids=["udid-A"],
        probe_results=[False],
    )

    asyncio.run(_run_for(0.4))

    assert cleanup.await_count >= 1, "expected at least one cleanup call"
    cleanup.assert_awaited_with(reason="tunnel_lost_liveness")
    assert tunnel.stop.await_count >= 1, "expected tunnel.stop() after cleanup"


def test_no_cleanup_when_probes_succeed(monkeypatch):
    """All probes succeed → no cleanup, no stop."""
    tunnel = _make_fake_tunnel()
    cleanup, _ = _patch_loop_deps(
        monkeypatch, tunnel=tunnel, network_udids=["udid-A"],
        probe_results=[True],
    )

    asyncio.run(_run_for(0.2))

    cleanup.assert_not_awaited()
    tunnel.stop.assert_not_awaited()


def test_no_cleanup_when_no_network_devices(monkeypatch):
    """Tunnel up but no Network-typed devices → loop skips probing entirely."""
    tunnel = _make_fake_tunnel()
    cleanup, call_idx = _patch_loop_deps(
        monkeypatch, tunnel=tunnel, network_udids=[],
        probe_results=[False],
    )

    asyncio.run(_run_for(0.2))

    cleanup.assert_not_awaited()
    tunnel.stop.assert_not_awaited()
    assert call_idx["n"] == 0, "loop should not call _tcp_probe with 0 consumers"


def test_no_cleanup_when_tunnel_not_running(monkeypatch):
    """Tunnel reports not running → loop short-circuits before probing."""
    tunnel = _make_fake_tunnel(running=False)
    cleanup, call_idx = _patch_loop_deps(
        monkeypatch, tunnel=tunnel, network_udids=["udid-A"],
        probe_results=[False],
    )

    asyncio.run(_run_for(0.2))

    cleanup.assert_not_awaited()
    tunnel.stop.assert_not_awaited()
    assert call_idx["n"] == 0


def test_miss_count_resets_on_recovery(monkeypatch):
    """A success in the middle of a fail streak resets miss_count, so a
    transient blip doesn't accumulate toward threshold."""
    tunnel = _make_fake_tunnel()
    # 2 fails → success → 2 fails → success: never 3 consecutive.
    cleanup, _ = _patch_loop_deps(
        monkeypatch, tunnel=tunnel, network_udids=["udid-A"],
        probe_results=[False, False, True, False, False, True],
    )

    asyncio.run(_run_for(0.25))

    cleanup.assert_not_awaited()
    tunnel.stop.assert_not_awaited()


def test_dead_transport_escalates_to_cleanup_immediately(monkeypatch):
    """When ``tunnel.transport_alive()`` returns False, the loop jumps
    straight to cleanup on the first iteration without waiting for 3
    TCP misses.

    Models the May 15 incident: pymobiledevice3's tun_read_task swallowed
    a ConnectionResetError and exited silently, but the TCP probe to the
    RSD port continued to succeed for 6.5 hours. The deep transport check
    catches this case where the TCP probe lies.

    TCP probe is scripted to return True (alive) — the *only* trigger
    must be ``transport_alive=False``. If the loop still gates on TCP
    misses, this test would not see cleanup fire.
    """
    tunnel = _make_fake_tunnel(transport_alive=False)
    cleanup, call_idx = _patch_loop_deps(
        monkeypatch, tunnel=tunnel, network_udids=["udid-A"],
        probe_results=[True],  # TCP probe lies — would never trigger cleanup
    )

    asyncio.run(_run_for(0.1))  # 1-2 iterations is enough

    assert cleanup.await_count >= 1, (
        "expected immediate cleanup on transport_alive=False; "
        "loop is still waiting on TCP misses"
    )
    cleanup.assert_awaited_with(reason="tunnel_lost_liveness")
    assert tunnel.stop.await_count >= 1
    # We should not have called TCP probe at all (the deep check
    # short-circuited the iteration before TCP).
    assert call_idx["n"] == 0, (
        f"TCP probe ran {call_idx['n']} times — deep check should "
        f"short-circuit it on transport_alive=False"
    )


def test_alive_transport_still_uses_tcp_threshold(monkeypatch):
    """When transport_alive=True, behaviour is identical to before —
    the loop still requires 3 consecutive TCP misses before tearing
    down. Regression guard against my "always escalate" mistake.
    """
    tunnel = _make_fake_tunnel(transport_alive=True)
    cleanup, call_idx = _patch_loop_deps(
        monkeypatch, tunnel=tunnel, network_udids=["udid-A"],
        probe_results=[True],  # all probes succeed → no cleanup
    )

    asyncio.run(_run_for(0.2))

    cleanup.assert_not_awaited()
    tunnel.stop.assert_not_awaited()
    # We DID exercise the TCP probe path — confirms we didn't accidentally
    # short-circuit it when transport_alive is True.
    assert call_idx["n"] >= 1


def test_generation_change_aborts_cleanup(monkeypatch):
    """If tunnel.generation moves between probe-snapshot and the post-threshold
    re-check, the loop yields to the new tunnel and does NOT tear down.

    Bumps generation inside the probe function so the bump lands between the
    snapshot at the top of the iteration and the cleanup re-check at the
    bottom — the exact race window the generation guard exists to defend.
    """
    from context import ctx
    from services import wifi_tunnel_service as wt

    tunnel = _make_fake_tunnel(generation=7)
    cleanup = AsyncMock(return_value=["udid-A"])
    monkeypatch.setattr(wt, "tunnel", tunnel, raising=True)
    monkeypatch.setattr(wt, "cleanup_wifi_connections", cleanup, raising=True)

    call_count = {"n": 0}

    async def _probe(addr, port, timeout=2.0):
        call_count["n"] += 1
        # Iteration 3 (the one that trips the threshold) bumps generation
        # between snapshot and re-check — exactly the race window the
        # guard exists to cover. From iteration 4 onward we simulate
        # a healthy new tunnel by returning True, so subsequent misses
        # don't accumulate and trigger an unrelated cleanup.
        if call_count["n"] == 3:
            tunnel.generation = 8
            return False
        if call_count["n"] >= 4:
            return True
        return False
    monkeypatch.setattr(wt, "_tcp_probe", _probe, raising=True)

    dm = MagicMock()
    dm.udids_by_connection_type = MagicMock(return_value=["udid-A"])
    monkeypatch.setattr(ctx, "app_state",
                        SimpleNamespace(device_manager=dm), raising=False)

    monkeypatch.setattr(tunnel_liveness, "PROBE_INTERVAL_S", 0.02, raising=True)
    monkeypatch.setattr(tunnel_liveness, "PROBE_TIMEOUT_S", 0.05, raising=True)

    asyncio.run(_run_for(0.2))

    cleanup.assert_not_awaited()
    tunnel.stop.assert_not_awaited()


def _stoppable_tunnel(order: list[str]):
    """Fake tunnel whose stop() really stops it and records the
    generation it stopped."""
    state = {"running": True}

    async def _stop():
        order.append(f"stop:gen{tunnel.generation}")
        state["running"] = False

    tunnel = SimpleNamespace(
        lock=asyncio.Lock(),
        is_running=lambda: state["running"],
        info={"rsd_address": "127.0.0.1", "rsd_port": 49152},
        generation=1,
        stop=_stop,
        transport_alive=lambda: False,  # escalate on the first iteration
    )
    return tunnel


def test_restart_during_cleanup_is_not_stopped(monkeypatch):
    """A user stop+start that lands while liveness is cleaning up must
    wait for the teardown, so tunnel.stop() only ever hits the dead
    generation, never the new tunnel."""
    order: list[str] = []
    tunnel = _stoppable_tunnel(order)
    cleanup, _ = _patch_loop_deps(
        monkeypatch, tunnel=tunnel, network_udids=["udid-A"],
        probe_results=[True],
    )
    from services import wifi_tunnel_service as wt
    monkeypatch.setattr(wt, "cancel_watchdog", lambda: None)

    async def _user_restart():
        async with tunnel.lock:
            tunnel.generation += 1
            order.append(f"restart:gen{tunnel.generation}")

    async def _slow_cleanup(**_kw):
        asyncio.get_running_loop().create_task(_user_restart())
        await asyncio.sleep(0.02)  # cleanup takes a while
        return ["udid-A"]
    cleanup.side_effect = _slow_cleanup

    asyncio.run(_run_for(0.15))

    assert order[:2] == ["stop:gen1", "restart:gen2"], order
    assert "stop:gen2" not in order


def test_liveness_teardown_emits_one_tunnel_event(monkeypatch):
    """The watchdog is cancelled before the tunnel stops, and the loop
    emits a single tunnel_lost after the devices are disconnected."""
    order: list[str] = []
    tunnel = _stoppable_tunnel(order)
    cleanup, _ = _patch_loop_deps(
        monkeypatch, tunnel=tunnel, network_udids=["udid-A"],
        probe_results=[True],
    )
    cleanup.side_effect = lambda **_kw: order.append("cleanup") or ["udid-A"]
    from services import wifi_tunnel_service as wt
    from services import ws_broadcaster
    monkeypatch.setattr(wt, "cancel_watchdog", lambda: order.append("cancel_watchdog"))

    async def _broadcast(event, data):
        order.append(event)
    monkeypatch.setattr(ws_broadcaster, "broadcast", _broadcast)

    asyncio.run(_run_for(0.15))

    assert order == ["cleanup", "cancel_watchdog", "stop:gen1", "tunnel_lost"], order
