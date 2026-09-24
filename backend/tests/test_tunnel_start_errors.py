"""Tests for api.tunnel.lifecycle._do_tunnel_start error mapping.

Regression guard: pymobiledevice3 raises ``ConnectionTerminatedError``
when the device answers the RemotePairing pair-verify with an ERROR TLV
(stale/revoked pair record, or connecting via the USB-NCM link-local
interface). That used to surface as the generic ``tunnel_spawn_failed``,
which told the user nothing actionable. It must map to the dedicated
``tunnel_pair_rejected`` code so the UI can point at re-pairing / wrong
network instead of "could not start process".
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))


class _FakeTunnelRunner:
    def __init__(self, start_exc: BaseException) -> None:
        self.lock = asyncio.Lock()
        self.task = None
        self.info = None
        self.generation = 0
        self.start = AsyncMock(side_effect=start_exc)

    def is_running(self) -> bool:
        return False


def _run_start_with(exc: BaseException) -> HTTPException:
    from api.tunnel import lifecycle

    runner = _FakeTunnelRunner(exc)
    req = lifecycle.WifiTunnelStartRequest(
        ip="192.168.10.9", port=49152, udid="00008140-TEST",
    )

    async def _run():
        # No other RemotePairing port turns up, so the original error is
        # what gets mapped (and no real mDNS / port scan runs in tests).
        with patch.object(lifecycle, "get_tunnel_runner", return_value=runner), \
             patch.object(lifecycle, "discover_remotepairing_ports", AsyncMock(return_value=[])):
            await lifecycle._do_tunnel_start(req)

    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(_run())
    return excinfo.value


def test_pair_verify_rejection_maps_to_tunnel_pair_rejected():
    from pymobiledevice3.exceptions import ConnectionTerminatedError

    err = _run_start_with(ConnectionTerminatedError())
    assert err.detail["code"] == "tunnel_pair_rejected"


def test_other_spawn_failures_keep_tunnel_spawn_failed():
    err = _run_start_with(RuntimeError("boom"))
    assert err.detail["code"] == "tunnel_spawn_failed"


def test_timeout_keeps_tunnel_timeout():
    err = _run_start_with(asyncio.TimeoutError())
    assert err.detail["code"] == "tunnel_timeout"


class _FakeDeviceManager:
    def __init__(self, network_udids: list[str]) -> None:
        self._network_udids = network_udids
        self.connected_count = len(network_udids)

    def udids_by_connection_type(self, kind: str) -> list[str]:
        return list(self._network_udids) if kind == "Network" else []


def test_start_and_connect_short_circuits_when_device_already_on_wifi():
    """A device that usbmux WiFi-sync already connected (Network transport,
    own CoreDevice tunnel) does not need the manual RemotePairing tunnel —
    starting one anyway just races a second tunnel against the live one
    (or times out against a sleeping phone). The route must report
    'already_connected' without touching the tunnel runner."""
    from api.tunnel import lifecycle

    dm = _FakeDeviceManager(["UDID-A"])
    req = lifecycle.WifiTunnelStartRequest(ip="192.168.2.238", port=49152)

    async def _run():
        with (
            patch.object(lifecycle, "get_device_manager", return_value=dm),
            patch.object(
                lifecycle.connection_state.store,
                "metadata_for",
                return_value={"name": "Gary", "ios_version": "27.0"},
            ),
            patch.object(
                lifecycle, "_do_tunnel_start",
                new=AsyncMock(side_effect=AssertionError("tunnel must not start")),
            ),
        ):
            return await lifecycle.wifi_tunnel_start_and_connect(req)

    res = asyncio.run(_run())
    assert res["status"] == "already_connected"
    assert res["udid"] == "UDID-A"
    assert res["name"] == "Gary"
    assert res["connection_type"] == "Network"


def test_start_and_connect_proceeds_for_a_different_udid():
    """An explicit udid that is NOT the WiFi-connected device must still go
    through the normal tunnel start (multi-device case)."""
    from api.tunnel import lifecycle

    dm = _FakeDeviceManager(["UDID-A"])
    req = lifecycle.WifiTunnelStartRequest(
        ip="192.168.2.50", port=49152, udid="UDID-B",
    )

    async def _run():
        with (
            patch.object(lifecycle, "get_device_manager", return_value=dm),
            patch.object(
                lifecycle, "_do_tunnel_start",
                new=AsyncMock(return_value={"status": "started"}),
            ),
        ):
            return await lifecycle.wifi_tunnel_start_and_connect(req)

    # Reaching the RSD-missing check proves the short-circuit was skipped.
    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(_run())
    assert excinfo.value.detail["code"] == "tunnel_no_rsd"


# ─── One WiFi tunnel at a time ───────────────────────────────────────


class _RunningTunnel:
    """A tunnel already up for device A at 192.168.2.10."""

    def __init__(self) -> None:
        self.lock = asyncio.Lock()
        self.info = {
            "rsd_address": "fd00::1", "rsd_port": 5555,
            "ip": "192.168.2.10",
        }
        self.start = AsyncMock(side_effect=AssertionError("must not restart"))

    def is_running(self) -> bool:
        return True


def _start_and_connect_with_running_tunnel(req):
    from api.tunnel import lifecycle

    dm = _FakeDeviceManager(["UDID-A"])

    async def _run():
        with (
            patch.object(lifecycle, "get_device_manager", return_value=dm),
            patch.object(lifecycle, "get_tunnel_runner", return_value=_RunningTunnel()),
            patch.object(
                lifecycle.connection_state.store, "metadata_for",
                return_value={"name": "A", "ios_version": "27.0"},
            ),
        ):
            return await lifecycle.wifi_tunnel_start_and_connect(req)

    return asyncio.run(_run())


def test_start_and_connect_different_ip_is_tunnel_busy():
    """Tunnel already serves A; asking for B's IP must not report A as
    'already_connected'."""
    from api.tunnel import lifecycle

    req = lifecycle.WifiTunnelStartRequest(ip="192.168.2.20", port=49152)
    with pytest.raises(HTTPException) as excinfo:
        _start_and_connect_with_running_tunnel(req)
    assert excinfo.value.status_code == 409
    assert excinfo.value.detail["code"] == "tunnel_busy"


def test_start_and_connect_same_ip_still_already_connected():
    from api.tunnel import lifecycle

    req = lifecycle.WifiTunnelStartRequest(ip="192.168.2.10", port=49152)
    res = _start_and_connect_with_running_tunnel(req)
    assert res["status"] == "already_connected"
    assert res["udid"] == "UDID-A"


def test_tunnel_start_for_other_device_is_tunnel_busy():
    """Direct API call for device B while A's tunnel runs must not hand
    back A's RSD."""
    from api.tunnel import lifecycle

    req = lifecycle.WifiTunnelStartRequest(
        ip="192.168.2.20", port=49152, udid="UDID-B",
    )

    async def _run():
        with patch.object(lifecycle, "get_tunnel_runner", return_value=_RunningTunnel()):
            await lifecycle._do_tunnel_start(req)

    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(_run())
    assert excinfo.value.detail["code"] == "tunnel_busy"


def test_tunnel_runner_records_target_ip(monkeypatch):
    """``_tunnel_busy_error`` keys on ``info['ip']``; the runner must set it."""
    import contextlib

    import pymobiledevice3.remote.tunnel_service as ts
    from core.wifi_tunnel import TunnelRunner

    class _Service:
        remote_identifier = "UDID-A"

        @contextlib.asynccontextmanager
        async def start_tcp_tunnel(self):
            yield type("T", (), {
                "address": "fd00::1", "port": 5555,
                "interface": "utun9", "protocol": "tcp",
            })()

    async def _create(_udid, _ip, _port):
        return _Service()

    monkeypatch.setattr(ts, "create_core_device_tunnel_service_using_remotepairing", _create)

    async def _run():
        runner = TunnelRunner()
        info = await runner.start("auto", "192.168.2.10", 49152, timeout=2.0)
        await runner.stop()
        return info

    info = asyncio.run(_run())
    assert info["ip"] == "192.168.2.10"
    assert info["rsd_address"] == "fd00::1"
