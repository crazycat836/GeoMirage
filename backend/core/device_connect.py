"""Per-iOS-version connection establishers for DeviceManager.

iOS 17+ requires a TCP tunnel via CoreDeviceTunnelProxy + RSD; iOS 16.x
uses direct lockdown over usbmux. Both return a populated
``_ActiveConnection``.

Circular-import note: ``_ActiveConnection`` is the dataclass instantiated
here but defined in ``core/device_manager.py``. ``TYPE_CHECKING`` covers
the static type hint; the runtime ``from core.device_manager import
_ActiveConnection`` inside each function defers the actual import until
DeviceManager has finished loading.
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Any

from pymobiledevice3.exceptions import PairingError
from pymobiledevice3.remote.remote_service_discovery import RemoteServiceDiscoveryService
from pymobiledevice3.remote.tunnel_service import CoreDeviceTunnelProxy

if TYPE_CHECKING:
    from core.device_manager import _ActiveConnection

logger = logging.getLogger(__name__)


async def connect_via_tunnel(
    udid: str, lockdown: Any, ios_version: str
) -> "_ActiveConnection":
    """TCP tunnel for iOS 17+ using CoreDeviceTunnelProxy + RSD.

    ``lockdown``: pymobiledevice3 lockdown handle (LockdownClient or
    similar). Typed as Any since pymobiledevice3 doesn't export a stable
    public protocol for it.
    """
    from core.device_manager import _ActiveConnection

    logger.debug("Establishing TCP tunnel for %s (iOS %s)", udid, ios_version)

    # Track each resource as it's acquired so a failure partway through
    # (commonly a flaky iOS 17+ rsd.connect()) can tear down only what was
    # actually opened. Without this, every failed attempt leaks the TUN
    # interface + sockets — the connection record is built only on success,
    # so the caller has no handle and disconnect() can never reach them.
    proxy = None
    tunnel_ctx = None
    tunnel_entered = False
    rsd = None
    try:
        proxy = await CoreDeviceTunnelProxy.create(lockdown)
        tunnel_ctx = proxy.start_tcp_tunnel()
        tunnel_result = await tunnel_ctx.__aenter__()
        tunnel_entered = True

        logger.info("Tunnel established for %s: %s:%s",
                    udid, tunnel_result.address, tunnel_result.port)

        rsd = RemoteServiceDiscoveryService((tunnel_result.address, tunnel_result.port))
        await rsd.connect()
        logger.info("RSD connected for %s", udid)

        return _ActiveConnection(
            udid=udid,
            lockdown=rsd,
            ios_version=ios_version,
            tunnel_proxy=proxy,
            tunnel_context=tunnel_ctx,
            rsd=rsd,
            usbmux_lockdown=lockdown,
        )
    except Exception as exc:
        logger.exception("TCP tunnel failed for %s (iOS %s)", udid, ios_version)
        await _close_partial_tunnel(
            udid, rsd, tunnel_ctx if tunnel_entered else None, proxy,
        )
        if isinstance(exc, PairingError):
            # Locked phone / Trust not tapped: let the API layer map it to
            # its own "unlock + tap Trust" error instead of a generic one.
            raise
        if isinstance(exc, PermissionError):
            hint = "Please run GeoMirage as Administrator."
        else:
            hint = f"{type(exc).__name__}: {exc}"
        raise RuntimeError(
            f"Could not establish device tunnel (iOS {ios_version}). {hint}"
        ) from exc


async def _close_partial_tunnel(udid: str, rsd, tunnel_ctx, proxy) -> None:
    """Best-effort teardown of a half-built tunnel after a failed connect.

    Closes in reverse-open order (RSD → tunnel context → proxy), mirroring
    ``DeviceManager.disconnect()``. Each closer is independent so one
    raising doesn't skip the rest; errors are logged at DEBUG since on this
    path every close is expected to be racy.
    """
    if rsd is not None:
        try:
            await rsd.close()
        except Exception:
            logger.debug("partial-tunnel cleanup: rsd.close() raised for %s", udid, exc_info=True)
    if tunnel_ctx is not None:
        try:
            await tunnel_ctx.__aexit__(None, None, None)
        except Exception:
            logger.debug("partial-tunnel cleanup: tunnel_ctx.__aexit__ raised for %s", udid, exc_info=True)
    if proxy is not None:
        try:
            result = proxy.close()
            if asyncio.iscoroutine(result):
                await result
        except Exception:
            logger.debug("partial-tunnel cleanup: proxy.close() raised for %s", udid, exc_info=True)


def connect_via_legacy(
    udid: str, lockdown: Any, ios_version: str
) -> "_ActiveConnection":
    """Direct usbmux lockdown connection for iOS 16.x devices.

    ``lockdown`` is a pymobiledevice3 lockdown handle (typed Any
    because pymobiledevice3 has no stable public protocol).
    """
    from core.device_manager import _ActiveConnection

    logger.info("Using legacy lockdown connection for %s (iOS %s)", udid, ios_version)
    return _ActiveConnection(
        udid=udid,
        lockdown=lockdown,
        ios_version=ios_version,
        usbmux_lockdown=lockdown,
    )
