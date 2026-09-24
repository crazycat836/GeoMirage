"""Shutdown clears every device's location before the WiFi tunnel stops.

A WiFi device's clear travels through the in-process tunnel. The
lifespan used to stop the tunnel first, so the clear had no transport
and the iPhone stayed at the last simulated coordinate. The launcher
watch's hard exit must also leave time for every clear to finish.
"""

from __future__ import annotations

import asyncio
import inspect
import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

import main  # noqa: E402
from config import MAX_DEVICES  # noqa: E402
from core import parent_watch  # noqa: E402
from core.device_manager import (  # noqa: E402
    CLEAR_FLUSH_S,
    DeviceManager,
    _ActiveConnection,
)
from state import AppState  # noqa: E402


class _FakeLocation:
    def __init__(self, udid: str, order: list[str], *, hang: bool = False) -> None:
        self._udid = udid
        self._order = order
        self._hang = hang

    async def clear(self, *, quick: bool = False) -> None:
        if self._hang:
            await asyncio.Event().wait()
        self._order.append(f"clear:{self._udid}")

    async def aclose(self) -> None:
        return None


class _FakeTunnel:
    def __init__(self, order: list[str]) -> None:
        self._order = order

    async def stop(self) -> None:
        self._order.append("tunnel_stop")


class _FakeAppState:
    def __init__(self, dm: DeviceManager, order: list[str]) -> None:
        self.device_manager = dm
        self._order = order
        self.simulation_engines = {"usb-A": object(), "wifi-B": object()}

    async def terminate_engine(self, udid: str) -> None:
        self._order.append(f"terminate:{udid}")
        self.simulation_engines.pop(udid, None)

    async def cancel_sync_tasks(self) -> None:
        return None


def _dm_with(order: list[str], *, hang_usb: bool = False) -> DeviceManager:
    dm = DeviceManager()
    dm._connections = {
        "usb-A": _ActiveConnection(
            udid="usb-A", lockdown=object(), ios_version="17.0",
            location_service=_FakeLocation("usb-A", order, hang=hang_usb),
        ),
        "wifi-B": _ActiveConnection(
            udid="wifi-B", lockdown=object(), ios_version="17.0",
            connection_type="Network",
            location_service=_FakeLocation("wifi-B", order),
        ),
    }
    return dm


def test_every_clear_happens_before_tunnel_stop(monkeypatch):
    monkeypatch.setattr("core.device_manager.CLEAR_FLUSH_S", 0.0)
    order: list[str] = []
    dm = _dm_with(order)
    app_state = _FakeAppState(dm, order)

    asyncio.run(main._shutdown_devices(
        app_state, _FakeTunnel(order), lambda: order.append("cancel_watchdog"),
    ))

    stop_at = order.index("tunnel_stop")
    clears = [i for i, step in enumerate(order) if step.startswith("clear:")]
    assert {order[i] for i in clears} == {"clear:usb-A", "clear:wifi-B"}
    assert all(i < stop_at for i in clears), order
    # Engines stop before any clear; the watchdog is cancelled before the
    # tunnel stops; every device is disconnected.
    assert order.index("terminate:wifi-B") < clears[0]
    assert order.index("cancel_watchdog") < stop_at
    assert dm.connected_udids == []


def test_stuck_device_does_not_delay_the_other_clear(monkeypatch):
    """A device whose clear never returns is bounded by the timeout and
    doesn't hold up the other device's clear."""
    monkeypatch.setattr("core.device_manager.CLEAR_FLUSH_S", 0.0)
    order: list[str] = []
    dm = _dm_with(order, hang_usb=True)

    async def run() -> float:
        loop = asyncio.get_running_loop()
        started = loop.time()
        await dm.clear_all_locations(timeout=0.05)
        return loop.time() - started

    elapsed = asyncio.run(run())

    assert order == ["clear:wifi-B"]
    assert elapsed < 1.0


def test_hard_exit_leaves_time_for_every_clear():
    """Worst case before the last clear completes: the three cooperative
    loops each use their full grace window, every engine stop hits its
    timeout, then the (concurrent) clears hit theirs plus the flush."""
    terminate_timeout = (
        inspect.signature(AppState.terminate_engine).parameters["timeout"].default
    )
    worst_case = (
        3 * main._SHUTDOWN_GRACE_S
        + MAX_DEVICES * terminate_timeout
        + main._SHUTDOWN_CLEAR_TIMEOUT_S
        + CLEAR_FLUSH_S
    )
    # Keep a margin for uvicorn's own shutdown that runs before lifespan.
    assert worst_case + 10.0 <= parent_watch._HARD_EXIT_AFTER_S
