"""
GeoMirage Device Manager

Handles iOS device detection, connection lifecycle, tunnel establishment,
and location service creation.  Wraps pymobiledevice3 internals so the
rest of the application never touches low-level device APIs directly.

Supports both USB and WiFi connections.  ``list_devices()`` from usbmuxd
returns devices with ``connection_type`` of ``"USB"`` or ``"Network"``.
WiFi requires the device to be paired and on the same local network.

For iOS 17+, a TCP tunnel via CoreDeviceTunnelProxy is established first,
then a RemoteServiceDiscoveryService (RSD) is created over the tunnel to
access DVT services.  This requires administrator privileges on Windows.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Any

from pymobiledevice3.exceptions import DeviceNotFoundError, PairingError
from pymobiledevice3.lockdown import create_using_usbmux
from pymobiledevice3.remote.remote_service_discovery import RemoteServiceDiscoveryService
from pymobiledevice3.remote.tunnel_service import CoreDeviceTunnelProxy
from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider
from pymobiledevice3.usbmux import list_devices

from core.ddi_mount import (
    create_dvt_location_service,
    create_legacy_location_service,
)
from core.device_connect import connect_via_legacy, connect_via_tunnel
from core.device_utils import (  # noqa: F401  (re-exported for existing importers)
    UnsupportedIosVersionError,
    delete_usbmux_pair_record,
    parse_ios_version,
)
from models.schemas import DeviceInfo
from services.location_service import LocationService


logger = logging.getLogger(__name__)

# Wait after queueing a location clear before tearing the transport down.
# stopLocationSimulation is fire-and-forget in pymobiledevice3, so without
# this window the channel closes before the stop reaches the device.
CLEAR_FLUSH_S = 0.3

# UnsupportedIosVersionError, parse_ios_version and delete_usbmux_pair_record
# now live in core.device_utils and are re-exported via the import at the
# top of this module.


async def _close_quietly(lockdown: object, udid: str) -> None:
    """Close a usbmux lockdown client, logging (not raising) on failure.

    On device-lost teardown the socket is usually already gone, so a
    close error is expected and only worth a DEBUG line.
    """
    try:
        await lockdown.close()
    except Exception:
        logger.debug("Error closing lockdown for %s", udid, exc_info=True)


class DeviceAlreadyConnectedError(RuntimeError):
    """``connect_wifi_tunnel`` reached a device that already has a
    connection record. The new RSD has been closed; the caller decides
    whether to tear the existing connection down (engine first) and
    connect again."""

    def __init__(self, udid: str) -> None:
        super().__init__(f"Device {udid} is already connected")
        self.udid = udid


@dataclass
class _ActiveConnection:
    """Internal bookkeeping for a single connected device."""
    udid: str
    lockdown: object  # LockdownClient or RemoteServiceDiscoveryService
    ios_version: str
    connection_type: str = "USB"  # "USB" or "Network"
    dvt_provider: DvtProvider | None = None
    tunnel_proxy: CoreDeviceTunnelProxy | None = None
    tunnel_context: object = None  # async context manager for the tunnel
    rsd: RemoteServiceDiscoveryService | None = None
    location_service: LocationService | None = None
    usbmux_lockdown: object = None  # Original lockdown client (for legacy fallback on iOS 17+)
    # Cached Developer Mode toggle state. Queried once at connect and
    # invalidated by the AMFI reveal endpoint so `/device/list` doesn't
    # pay a lockdown round-trip per device per poll.
    developer_mode_enabled: bool | None = None
    # True when the connection rides the in-process WiFi TunnelRunner
    # (connect_wifi_tunnel). A usbmux "Network" connection (Finder's
    # Wi-Fi sync) has connection_type "Network" but its own CoreDevice
    # tunnel, so the TunnelRunner's liveness says nothing about it.
    via_tunnel: bool = False


# Public alias so callers outside this module can type-annotate against
# the connection record without depending on the private name. The
# underlying dataclass is intentionally still named with a leading
# underscore — instances are owned and constructed exclusively by
# DeviceManager. External callers obtain one via DeviceManager.get_connection().
ConnectionInfo = _ActiveConnection


class DeviceManager:
    """
    Manages the full lifecycle of iOS device connections.

    Usage::

        dm = DeviceManager()
        devices = await dm.discover_devices()
        await dm.connect(devices[0].udid)
        loc = await dm.get_location_service(devices[0].udid)
        await loc.set(37.7749, -122.4194)
        await dm.disconnect(devices[0].udid)
    """

    # `/api/device/list` is hot-path: the frontend re-fetches on every WS
    # broadcast and multiple clients (Electron + stray browser tabs in dev)
    # multiply the load. A short TTL around usbmux enumeration coalesces
    # concurrent callers into one round-trip. Device metadata doesn't
    # change at sub-second timescales so this is invisible to the UI.
    _DISCOVER_TTL = 0.5

    def __init__(self) -> None:
        self._connections: dict[str, _ActiveConnection] = {}
        self._lock = asyncio.Lock()
        # Serialise DDI downloads/mounts across devices. Without this, two
        # parallel connects on a fresh machine race to write the same DDI
        # cache path and corrupt each other.
        self._ddi_mount_lock = asyncio.Lock()
        self._discover_cache: list[DeviceInfo] | None = None
        self._discover_cache_at: float = 0.0
        self._discover_inflight: asyncio.Task[list[DeviceInfo]] | None = None

    # ------------------------------------------------------------------
    # Discovery
    # ------------------------------------------------------------------

    async def discover_devices(self) -> list[DeviceInfo]:
        """
        Scan for all iOS devices visible over USB and WiFi (usbmuxd).

        usbmuxd returns both USB-connected and WiFi-paired devices on
        the same network.  Each device carries a ``connection_type`` of
        ``"USB"`` or ``"Network"``.

        Returns a list of ``DeviceInfo`` objects with basic identification
        data.  This does **not** establish a persistent connection.

        Results are cached for ``_DISCOVER_TTL`` seconds and concurrent
        callers share a single in-flight enumeration.
        """
        now = time.monotonic()
        if (
            self._discover_cache is not None
            and (now - self._discover_cache_at) < self._DISCOVER_TTL
        ):
            return self._discover_cache

        inflight = self._discover_inflight
        if inflight is not None and not inflight.done():
            # asyncio.shield() keeps the enumeration task running even if
            # *this* caller's await gets cancelled. Without shield, a
            # cancelled caller would also cancel the shared task and the
            # next caller would have to restart enumeration from scratch.
            # If the in-flight task raised, fall through and retry rather
            # than propagating a stale failure.
            try:
                return await asyncio.shield(inflight)
            except Exception:
                logger.debug(
                    "in-flight discover_devices raised; retrying with fresh task",
                    exc_info=True,
                )

        task = asyncio.create_task(self._discover_devices_uncached())
        self._discover_inflight = task
        try:
            try:
                result = await task
            except Exception:
                # Do NOT cache on error — a transient usbmux failure would
                # otherwise hand every caller an empty list for the full
                # TTL and mask the real error. Return [] for this caller;
                # the next one pays for a fresh enumeration immediately.
                return []
            self._discover_cache = result
            self._discover_cache_at = time.monotonic()
            return result
        finally:
            if self._discover_inflight is task:
                self._discover_inflight = None

    async def _discover_devices_uncached(self) -> list[DeviceInfo]:
        # Let usbmux failures propagate — the public ``discover_devices``
        # wrapper catches them so we don't poison the cache with an empty
        # list on transient errors.
        raw_devices = await list_devices()

        # "Nothing plugged in" is genuinely useful at INFO because it tells
        # ops "enumeration ran, there are no devices" — distinct from a
        # silent enumeration failure. The per-device line below stays at
        # DEBUG since it would otherwise repeat on every /api/device/list
        # poll.
        if not raw_devices:
            logger.info("discover_devices: usbmux returned 0 raw entries")
        else:
            logger.debug(
                "discover_devices: usbmux returned %d raw entr%s",
                len(raw_devices), "y" if len(raw_devices) == 1 else "ies",
            )

        # Two-pass build so each DeviceInfo is constructed exactly once
        # with all final values (no post-construction mutation, per the
        # project immutability rule).
        #
        # Pass 1: walk raw entries in usbmux order, collecting per-UDID
        # field bags. When a UDID appears twice (USB + Network), we keep
        # whichever entry resolved as USB — usbmuxd may emit them in
        # either order, so we update the bag's connection_type rather
        # than rely on first-wins.
        bags: dict[str, dict[str, Any]] = {}
        order: list[str] = []
        for raw in raw_devices:
            udid = getattr(raw, "serial", None)
            if not udid:
                continue
            conn_type = getattr(raw, "connection_type", "USB")
            if udid in bags:
                if conn_type == "USB":
                    bags[udid]["raw_conn_type"] = "USB"
                continue
            bags[udid] = {"raw_conn_type": conn_type}
            order.append(udid)

        # Pass 2: per-UDID lockdown round-trip + DeviceInfo construction.
        # Each bag is enriched with everything needed before the single
        # DeviceInfo(...) call at the end of the loop body.
        devices: list[DeviceInfo] = []
        for udid in order:
            bag = bags[udid]
            lockdown = None
            try:
                # autopair=False: listing devices must NEVER trigger a
                # pairing handshake. With autopair=True, every /api/device/list
                # poll re-paired plugged-in devices — popping the "Trust This
                # Computer" prompt on plug-in and (for a locked/unpaired
                # device) flooding the log with PasswordRequiredError. Pairing
                # now happens only on an explicit user Connect (see connect()).
                lockdown = await create_using_usbmux(serial=udid, autopair=False)
                all_values = lockdown.all_values

                # Active-connection wins over usbmux's reported type, since
                # the live transport reflects how the user is actually
                # talking to the device right now.
                active_conn = self._connections.get(udid)
                conn_type = (
                    active_conn.connection_type if active_conn
                    else bag["raw_conn_type"]
                )

                ios_version = all_values.get("ProductVersion", "0.0")
                ios_major = parse_ios_version(ios_version)[0] if ios_version else 0
                is_connected = udid in self._connections

                # Resolve developer-mode state up front so DeviceInfo can
                # be built in one shot. Cache hits are free; cache misses
                # query lockdown and update the active_conn cache (the
                # only mutation here is on the connection record we own,
                # not on the freshly-constructed DeviceInfo).
                developer_mode_enabled: bool | None = None
                if ios_major >= 16:
                    cached = active_conn.developer_mode_enabled if active_conn else None
                    if cached is not None:
                        developer_mode_enabled = cached
                    else:
                        try:
                            flag = bool(await lockdown.get_developer_mode_status())
                            developer_mode_enabled = flag
                            if active_conn is not None:
                                active_conn.developer_mode_enabled = flag
                        except Exception:
                            logger.debug(
                                "get_developer_mode_status failed for %s",
                                udid, exc_info=True,
                            )

                # Derived gate for the frontend AMFI button — all four
                # preconditions in one place.
                can_reveal_developer_mode = (
                    is_connected
                    and (conn_type or "").lower() == "usb"
                    and ios_major >= 16
                    and developer_mode_enabled is False
                )

                info = DeviceInfo(
                    udid=udid,
                    name=all_values.get("DeviceName", "Unknown"),
                    ios_version=ios_version,
                    connection_type=conn_type,
                    is_connected=is_connected,
                    developer_mode_enabled=developer_mode_enabled,
                    can_reveal_developer_mode=can_reveal_developer_mode,
                )
                devices.append(info)
                # DEBUG — see discover_devices() for rationale. This line
                # would otherwise repeat once per device per poll.
                logger.debug(
                    "  device %s '%s' iOS %s via %s (connected=%s)",
                    info.udid, info.name, info.ios_version, conn_type, info.is_connected,
                )
            except PairingError:
                # Present in usbmux but not paired (or paired-but-locked so
                # the cached record can't be validated). We deliberately do
                # NOT auto-pair, so surface it as an offline, not-yet-paired
                # entry — the renderer shows it with a Connect button and the
                # user pairs it explicitly. INFO (no traceback): this is the
                # expected state for any attached-but-untrusted device, and
                # would otherwise flood the log on every poll.
                logger.info(
                    "Device %s present but not paired; listing as offline "
                    "(connect explicitly to pair)", udid,
                )
                devices.append(DeviceInfo(
                    udid=udid,
                    name="",
                    ios_version="",
                    connection_type=bag["raw_conn_type"],
                    is_connected=udid in self._connections,
                ))
            except Exception:
                logger.warning("Failed to query device %s", udid, exc_info=True)
            finally:
                # Listing only needs the lockdown for this one query; left
                # open it lingers until GC on every /device/list poll.
                if lockdown is not None:
                    await _close_quietly(lockdown, udid)

        return devices

    def _invalidate_discover_cache(self) -> None:
        """Call after any mutation to ``_connections`` so the next
        ``discover_devices()`` reflects the new state without waiting
        for TTL expiry."""
        self._discover_cache = None
        self._discover_cache_at = 0.0

    # ------------------------------------------------------------------
    # Connection
    # ------------------------------------------------------------------

    async def connect(self, udid: str) -> None:
        """
        Establish a connection appropriate for the device's iOS version.

        Supports both USB and WiFi (Network) connections via usbmuxd.

        * **iOS 17+** -- TCP tunnel via CoreDeviceTunnelProxy + RSD.
        * **iOS 16.x** -- plain lockdown over usbmux + legacy location service.
        """
        async with self._lock:
            if udid in self._connections:
                logger.info("Device %s is already connected", udid)
                return

        # Detect connection type from usbmux device list.
        connection_type = "USB"
        try:
            raw_devices = await list_devices()
            for raw in raw_devices:
                if raw.serial == udid:
                    connection_type = getattr(raw, "connection_type", "USB")
                    # Prefer USB if device shows up as both
                    if connection_type == "USB":
                        break
        except Exception:
            logger.debug("Could not determine connection type for %s, assuming USB", udid)

        logger.info("Connecting to %s via %s", udid, connection_type)

        # Create a fresh lockdown client to read the iOS version.
        try:
            lockdown = await create_using_usbmux(serial=udid)
        except DeviceNotFoundError:
            # Device is genuinely absent from usbmux (unplugged / WiFi
            # tunnel dead). Log without traceback — the user-facing path
            # already surfaces this as "no_device" and a stack frame
            # from pymobiledevice3 internals adds no diagnostic value.
            logger.warning(
                "Device %s not present in usbmux (connection_type=%s); "
                "user must re-plug or restart the tunnel",
                udid, connection_type,
            )
            raise
        except PairingError:
            # Manual connect of a device that's locked or whose user
            # declined Trust. Concise (no traceback) — the API layer turns
            # this into a clear "unlock + tap Trust, then retry" message and
            # a stack frame from pymobiledevice3 internals adds nothing.
            logger.warning(
                "Pairing required for %s via %s — unlock the device and tap "
                "\"Trust This Computer\", then connect again",
                udid, connection_type,
            )
            raise
        except Exception:
            logger.exception("Cannot create lockdown client for %s via %s", udid, connection_type)
            raise

        ios_version_str: str = lockdown.all_values.get("ProductVersion", "0.0")
        ver = parse_ios_version(ios_version_str)

        # Until a connection record owns the lockdown, close it on any
        # failure so it doesn't linger until GC.
        try:
            if ver < (16, 0):
                logger.warning(
                    "Refusing connect: %s reports iOS %s, below minimum %s",
                    udid, ios_version_str, UnsupportedIosVersionError.MIN_VERSION,
                )
                raise UnsupportedIosVersionError(ios_version_str)

            if ver >= (17, 0):
                conn = await connect_via_tunnel(udid, lockdown, ios_version_str)
            else:
                conn = connect_via_legacy(udid, lockdown, ios_version_str)
        except BaseException:
            await _close_quietly(lockdown, udid)
            raise
        conn.connection_type = connection_type

        # Re-check membership under the lock. The initial dup-gate at the top
        # of connect() released the lock for the whole tunnel build, so a
        # second concurrent connect(udid) — e.g. startup auto-connect racing
        # the usbmux watchdog — can reach here too. First to store wins; the
        # loser tears down its just-built tunnel so it doesn't leak the TUN
        # iface + sockets (the record was never registered, so disconnect()
        # could never reach them).
        async with self._lock:
            duplicate = udid in self._connections
            if not duplicate:
                self._connections[udid] = conn
        if duplicate:
            logger.warning(
                "Device %s connected concurrently; discarding the duplicate tunnel", udid,
            )
            await self._close_connection(udid, conn)
            return
        self._invalidate_discover_cache()

        logger.info("Connected to %s (iOS %s) via %s", udid, ios_version_str, connection_type)

    # Per-iOS connection establishers live in core/device_connect.py so
    # the DeviceManager class stays focused on registry / lifecycle.

    # ------------------------------------------------------------------
    # Disconnection
    # ------------------------------------------------------------------

    async def disconnect(self, udid: str) -> None:
        """Tear down the connection and clean up resources for *udid*.

        Pops the record under the lock, then delegates the ordered close
        steps to :meth:`_close_connection` (shared with the concurrent-
        connect-race teardown path in :meth:`connect`)."""
        async with self._lock:
            conn = self._connections.pop(udid, None)

        if conn is None:
            logger.warning("Disconnect requested for unknown device %s", udid)
            return
        self._invalidate_discover_cache()
        await self._close_connection(udid, conn)
        logger.info("Disconnected device %s", udid)

    async def _close_connection(self, udid: str, conn: "_ActiveConnection") -> None:
        """Run the ordered close steps for a single connection record.

        Operates purely on *conn* and never touches ``self._connections``,
        so it is reused both by :meth:`disconnect` (after popping the
        record) and by :meth:`connect` to tear down a duplicate tunnel that
        lost the concurrent-connect race.

        Each step logs WARN with a single-line summary instead of
        ``logger.exception`` because this path runs both for user-initiated
        disconnects (where failures are genuinely unexpected) *and* for
        device-lost cleanup after a dead tunnel (where
        EOF/ConnectionReset/TimeoutError on every close is the expected
        outcome — the OS sockets are already gone). Dumping five full
        tracebacks per device-lost event produced ~150 lines of noise that
        masked real errors; the single-line summary preserves "which step
        and which exception class" for diagnostics. If a future maintainer
        needs full stacks, raise the logger to DEBUG.
        """
        # Clear any active location simulation first. ``quick=True`` so a
        # dead DVT channel doesn't drag us through a 15s reconnect ladder
        # we're about to invalidate anyway by tearing down the tunnel
        # underneath it.
        if conn.location_service is not None:
            try:
                await conn.location_service.clear(quick=True)
                # stopLocationSimulation is declared `expects_reply=False`
                # in pymobiledevice3, so clear() returns as soon as the DTX
                # message is queued — iOS has not necessarily processed it
                # yet. Without this flush window, the teardown below rips
                # out the DVT channel / RSD / tunnel before the stop
                # reaches the device, so the phone keeps the last simulated
                # coordinate even though our log says "cleared".
                await asyncio.sleep(CLEAR_FLUSH_S)
            except Exception as exc:
                logger.warning("Error clearing location on disconnect for %s: %s", udid, exc)

        await self._close_location_stack(conn, udid)

        # Close RSD.
        if conn.rsd is not None:
            try:
                await conn.rsd.close()
            except Exception as exc:
                logger.warning("Error closing RSD for %s: %s", udid, exc)

        # Close tunnel context.
        if conn.tunnel_context is not None:
            try:
                await conn.tunnel_context.__aexit__(None, None, None)
            except Exception as exc:
                logger.warning("Error closing tunnel for %s: %s", udid, exc)

        # Close tunnel proxy. CoreDeviceTunnelProxy.close() is an async
        # coroutine in current pymobiledevice3; without await it logs a
        # "coroutine was never awaited" RuntimeWarning on shutdown and the
        # underlying socket is cleaned up by GC rather than deterministically.
        if conn.tunnel_proxy is not None:
            try:
                await conn.tunnel_proxy.close()
            except Exception as exc:
                logger.warning("Error closing tunnel proxy for %s: %s", udid, exc)

        # Close the usbmux lockdown last: on iOS 17+ it carried the tunnel
        # handshake, on iOS 16 it is ``conn.lockdown`` itself. WiFi-tunnel
        # connections have none.
        if conn.usbmux_lockdown is not None:
            await _close_quietly(conn.usbmux_lockdown, udid)

    # ------------------------------------------------------------------
    # Location service
    # ------------------------------------------------------------------

    async def get_location_service(self, udid: str) -> LocationService:
        """
        Return a ``LocationService`` instance for the given device.

        The concrete type depends on the iOS version:

        * iOS 17+  ->  ``DvtLocationService`` (uses DVT instrumentation)
        * iOS < 17 ->  ``LegacyLocationService`` (uses DtSimulateLocation)

        The service is cached on the connection so subsequent calls are cheap.
        """
        async with self._lock:
            conn = self._connections.get(udid)

        if conn is None:
            raise RuntimeError(
                f"Device {udid} is not connected. Call connect() first."
            )

        if conn.location_service is not None:
            return conn.location_service

        ver = parse_ios_version(conn.ios_version)
        if ver >= (17, 0):
            loc = await create_dvt_location_service(conn, self._ddi_mount_lock)
        else:
            loc = await create_legacy_location_service(conn)
        conn.location_service = loc
        return loc

    # connect_wifi (the legacy direct-IP WiFi connect helper) was removed
    # in v0.1.49 in favour of connect_wifi_tunnel below, which assumes a
    # pre-established RSD tunnel. The DDI mount and location-service
    # factory helpers used by ``get_location_service`` now live in
    # ``core.ddi_mount`` (extracted in v0.13.x). iOS 16.x devices remain
    # supported (UnsupportedIosVersionError only rejects < 16.0). iOS
    # 17+ continues to use the personalized DDI mount path +
    # DvtLocationService, with LegacyLocationService as a runtime
    # fallback inside ``create_dvt_location_service`` when DVT itself
    # fails.

    # ------------------------------------------------------------------
    # WiFi connection (iOS 17+ tunnel only)
    # ------------------------------------------------------------------

    async def connect_wifi_tunnel(
        self, rsd_address: str, rsd_port: int
    ) -> DeviceInfo:
        """Connect to a device via an existing WiFi tunnel.

        Use this when a WiFi tunnel has already been established (by the
        in-process ``TunnelRunner`` or ``pymobiledevice3 remote start-tunnel``).
        The caller provides the RSD address and port.

        Returns a ``DeviceInfo`` describing the connected device.
        """
        logger.info("Connecting via WiFi tunnel RSD at %s:%d", rsd_address, rsd_port)

        rsd = None
        last_exc: Exception | None = None
        # TUN interface routes may take a few seconds to become reachable
        # after the tunnel process reports ready, so retry with backoff.
        for attempt in range(1, 11):
            rsd = RemoteServiceDiscoveryService((rsd_address, rsd_port))
            try:
                await rsd.connect()
                last_exc = None
                break
            except Exception as exc:
                last_exc = exc
                logger.warning(
                    "RSD connect attempt %d/10 failed (%s): %s",
                    attempt, exc.__class__.__name__, exc,
                )
                try:
                    await rsd.close()
                except (OSError, ConnectionError):
                    logger.debug(
                        "rsd.close() failed after connect attempt %d (likely already closed)",
                        attempt,
                        exc_info=True,
                    )
                await asyncio.sleep(min(0.5 * attempt, 2.0))

        if last_exc is not None:
            logger.error("Failed to connect to RSD at %s:%d after retries", rsd_address, rsd_port)
            raise RuntimeError(
                f"Could not connect to WiFi tunnel RSD ({rsd_address}:{rsd_port}). "
                "Ensure the WiFi tunnel is still active."
            ) from last_exc

        peer = rsd.peer_info or {}
        props = peer.get("Properties", {})
        udid = props.get("UniqueDeviceID", "")
        ios_version_str = props.get("OSVersion", "0.0")
        device_name = props.get("DeviceClass", "iPhone")

        conn = _ActiveConnection(
            udid=udid,
            lockdown=rsd,
            ios_version=ios_version_str,
            connection_type="Network",
            rsd=rsd,
            via_tunnel=True,
        )

        # Check-then-set under the lock, as in connect(): an existing
        # record wins and this RSD is closed. Replacing a live connection
        # needs its engine stopped first, which is the orchestration
        # layer's job, so the caller gets DeviceAlreadyConnectedError.
        async with self._lock:
            duplicate = udid in self._connections
            if not duplicate:
                self._connections[udid] = conn
        if duplicate:
            logger.info(
                "WiFi tunnel reached %s, which is already connected; "
                "closing the new RSD", udid,
            )
            await self._close_connection(udid, conn)
            raise DeviceAlreadyConnectedError(udid)
        self._invalidate_discover_cache()

        logger.info("WiFi tunnel connected to %s (iOS %s)", udid, ios_version_str)

        return DeviceInfo(
            udid=udid,
            name=device_name,
            ios_version=ios_version_str,
            connection_type="Network",
            is_connected=True,
        )

    # ------------------------------------------------------------------
    # Utilities
    # ------------------------------------------------------------------

    @property
    def connected_udids(self) -> list[str]:
        """Return the UDIDs of all currently connected devices."""
        return list(self._connections.keys())

    @property
    def connected_count(self) -> int:
        """Return the number of currently connected devices."""
        return len(self._connections)

    @staticmethod
    async def _close_location_stack(conn: _ActiveConnection, udid: str) -> None:
        """Close the location service and its DvtProvider, and forget both."""
        # Close whatever DvtProvider the location service holds NOW. After
        # a DVT reconnect, conn.dvt_provider points at the OLD provider and
        # the live one would otherwise leak its dtx reader tasks (asyncio
        # "Task was destroyed but it is pending!" at the next GC). Bounded
        # wait: aclose() shares the reconnect lock, and a reconnect ladder
        # in flight can hold it for ~15s we don't want to spend here.
        if conn.location_service is not None:
            try:
                await asyncio.wait_for(conn.location_service.aclose(), timeout=5.0)
            except Exception as exc:
                logger.warning(
                    "Error closing location service for %s: %s", udid, exc,
                )

        # Shut down the DVT provider if it was opened.
        if conn.dvt_provider is not None:
            try:
                await conn.dvt_provider.__aexit__(None, None, None)
            except Exception as exc:
                logger.warning("Error closing DvtProvider for %s: %s", udid, exc)

        conn.location_service = None
        conn.dvt_provider = None

    async def reset_location_service(self, udid: str) -> None:
        """Drop the cached location service so the next
        :meth:`get_location_service` builds a fresh one — and re-runs the
        DDI mount. Used to retry after a failed mount, when the cached
        service may be the legacy fallback picked at failure time."""
        async with self._lock:
            conn = self._connections.get(udid)
        if conn is None:
            raise RuntimeError(f"Device {udid} is not connected.")
        await self._close_location_stack(conn, udid)

    def is_connected(self, udid: str) -> bool:
        """Check whether a device is currently connected."""
        return udid in self._connections

    def get_connection(self, udid: str) -> "ConnectionInfo | None":
        """Return the live connection record for *udid*, or None if absent.

        Public accessor for the API layer, which previously reached into
        ``_connections`` directly. The returned object exposes
        ``lockdown``, ``ios_version``, ``connection_type``,
        ``developer_mode_enabled`` and similar fields callers need for
        cross-cutting concerns like AMFI. Mutations on the returned
        instance are visible to subsequent reads — that is intentional;
        DeviceManager owns the lifecycle but does not deep-copy on read."""
        return self._connections.get(udid)

    def udids_by_connection_type(self, connection_type: str) -> list[str]:
        """Return UDIDs whose connection matches ``connection_type``
        (e.g. ``'Network'`` or ``'USB'``). Preferred over reaching into
        ``_connections`` from the API layer."""
        return [
            udid for udid, conn in self._connections.items()
            if getattr(conn, "connection_type", "") == connection_type
        ]

    def is_via_wifi_tunnel(self, udid: str) -> bool:
        """True when *udid* is connected through the in-process WiFi
        tunnel (as opposed to USB or a usbmux Network connection)."""
        conn = self._connections.get(udid)
        return bool(conn is not None and conn.via_tunnel)

    async def snapshot_usb_udids(self) -> set[str]:
        """Return the set of currently-connected USB UDIDs, snapshotted
        under ``self._lock``.

        Lets the usbmux watchdog get a consistent view without reaching
        into the private ``_lock`` / ``_connections`` — a concurrent
        connect()/disconnect() mutating the dict mid-iteration would
        otherwise raise ``dictionary changed size during iteration`` or
        hand back a half-updated snapshot.
        """
        async with self._lock:
            return {
                udid for udid, conn in self._connections.items()
                if getattr(conn, "connection_type", "USB") == "USB"
            }

    def get_connection_type(self, udid: str) -> str:
        """Return ``'USB'`` or ``'Network'`` for a connected device."""
        conn = self._connections.get(udid)
        return conn.connection_type if conn else "USB"

    async def clear_all_locations(self, *, timeout: float) -> None:
        """Clear the simulated location on every connected device at once.

        Used at shutdown ahead of :meth:`disconnect_all`, so each iPhone
        gets its clear within ``timeout`` + the flush window no matter how
        slowly another device's transport teardown goes. The per-device
        clear inside :meth:`_close_connection` still runs afterwards.
        """
        async with self._lock:
            services = [
                (udid, conn.location_service)
                for udid, conn in self._connections.items()
                if conn.location_service is not None
            ]
        if not services:
            return

        async def _clear_one(udid: str, loc: LocationService) -> None:
            try:
                await asyncio.wait_for(loc.clear(quick=True), timeout=timeout)
            except Exception as exc:
                logger.warning("Error clearing location for %s: %s", udid, exc)

        await asyncio.gather(*(_clear_one(u, loc) for u, loc in services))
        # Same flush window as _close_connection: clear() returns once the
        # stop message is queued, before iOS has processed it.
        await asyncio.sleep(CLEAR_FLUSH_S)

    async def disconnect_all(self) -> None:
        """Disconnect every active device."""
        udids = list(self._connections.keys())
        for udid in udids:
            await self.disconnect(udid)
        logger.info("All devices disconnected")
