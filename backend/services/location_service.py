"""
GeoMirage Location Service

Provides a unified interface for iOS location simulation across different
iOS versions, wrapping pymobiledevice3's location simulation capabilities.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from enum import StrEnum

import asyncio

from pymobiledevice3.exceptions import (
    ConnectionFailedToUsbmuxdError,
    ConnectionTerminatedError,
    DeveloperDiskImageNotFoundError,
    DeveloperModeIsNotEnabledError,
    MuxException,
    PasscodeRequiredError,
    PasswordRequiredError,
    RSDRequiredError,
    TunneldConnectionError,
)
from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider
from pymobiledevice3.services.dvt.instruments.location_simulation import LocationSimulation
from pymobiledevice3.services.simulate_location import DtSimulateLocation

from config import DVT_RECONNECT_DELAYS

logger = logging.getLogger(__name__)

# Upper bound for a single probe_channel_alive() round-trip. The happy
# path completes in <100ms; a dead channel fails fast (connection
# refused / EOF). The timeout only exists so a wedged DVT handshake
# can't pin the probing task forever.
_DVT_PROBE_TIMEOUT_S = 5.0


class DeviceLostCause(StrEnum):
    """Why a DeviceLostError was raised. The frontend uses this to show a
    cause-specific message instead of the generic 'device lost'. Lower-cased
    snake_case values are used directly as JSON wire format."""

    UNKNOWN = "unknown"
    USB_REMOVED = "usb_removed"
    WIFI_DROPPED = "wifi_dropped"
    PHONE_LOCKED = "phone_locked"
    DDI_NOT_MOUNTED = "ddi_not_mounted"


class DeviceLostError(RuntimeError):
    """Raised when a location service determines the underlying device
    connection is no longer recoverable. The ``cause`` attribute identifies
    the root-cause class so the API layer can surface a precise user-facing
    message; ``UNKNOWN`` is the safe default when classification fails.
    """

    def __init__(
        self,
        message: str = "",
        *,
        cause: DeviceLostCause = DeviceLostCause.UNKNOWN,
    ) -> None:
        super().__init__(message)
        self.cause: DeviceLostCause = cause


def classify_device_lost_cause(exc: BaseException | None) -> DeviceLostCause:
    """Walk *exc* (and its ``__cause__`` chain) and pick the matching
    DeviceLostCause based on pymobiledevice3 exception types. Returns
    ``UNKNOWN`` when no specific class can be identified.
    """
    visited: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in visited:
        visited.add(id(current))
        if isinstance(current, (PasswordRequiredError, PasscodeRequiredError)):
            return DeviceLostCause.PHONE_LOCKED
        if isinstance(current, (DeveloperDiskImageNotFoundError, DeveloperModeIsNotEnabledError)):
            return DeviceLostCause.DDI_NOT_MOUNTED
        if isinstance(current, (RSDRequiredError, TunneldConnectionError)):
            return DeviceLostCause.WIFI_DROPPED
        if isinstance(current, (ConnectionFailedToUsbmuxdError, MuxException)):
            return DeviceLostCause.USB_REMOVED
        current = current.__cause__
    return DeviceLostCause.UNKNOWN


def _raise_device_lost(message: str, exc: BaseException) -> None:
    """Classify *exc*, log at error level with the cause label, and raise
    ``DeviceLostError`` chained from it. Pulls the three reconnect-exhausted
    raise sites onto a single audit-friendly path."""
    cause = classify_device_lost_cause(exc)
    logger.error("%s — device likely lost (%s, cause=%s)", message, exc, cause.value)
    raise DeviceLostError(f"{message}: {exc}", cause=cause) from exc


def unwrap_device_lost(exc: BaseException | None) -> DeviceLostError | None:
    """Walk an exception's ``__cause__`` chain looking for a DeviceLostError.

    DeviceLostError is often re-raised wrapped (e.g. from pymobiledevice3
    timeouts or the simulation engine retry loop). Callers use this to detect
    a lost device after catching a generic Exception so they can run the
    standard cleanup + ``device_disconnected`` broadcast flow instead of
    treating it as a generic 500.
    """
    cause: BaseException | None = exc
    while cause is not None:
        if isinstance(cause, DeviceLostError):
            return cause
        cause = cause.__cause__
    return None


class LocationService(ABC):
    """
    Abstract base for location simulation services.

    Subclasses implement version-specific simulation using either the DVT
    instrumentation channel (iOS 17+) or the legacy DtSimulateLocation
    service (iOS < 17).
    """

    async def aclose(self) -> None:
        """Release transport resources owned by this service.

        Default is a no-op (LegacyLocationService holds no background
        tasks). DvtLocationService overrides this — it is the SSoT for
        the *current* DvtProvider after reconnect swaps, so disconnect
        teardown must close through it rather than a stale reference.
        """
        return None

    @abstractmethod
    async def set(self, lat: float, lng: float) -> None:
        """Simulate the device location to the given coordinates."""

    @abstractmethod
    async def clear(self, *, quick: bool = False) -> None:
        """Stop simulating and restore the real device location.

        When ``quick=True``, a channel-drop during the clear call is
        logged and swallowed instead of triggering the 15s reconnect
        ladder — the caller is signalling that the connection is about
        to be torn down anyway, so trying to revive DVT on a dead
        tunnel is pure overhead. Default ``False`` preserves the
        previous retry-on-drop behaviour for the normal restore path.
        """

    @property
    def active_state(self) -> bool:
        """Whether the service is currently pushing a simulated location.

        Public, read-only view of the internal ``_active`` flag —
        ``/api/location/debug`` surfaces this instead of reaching into
        the private attribute. Subclasses keep their existing
        ``_active`` bookkeeping; the default implementation returns
        ``getattr(self, "_active", False)`` so future implementations
        without that attribute degrade gracefully.
        """
        return bool(getattr(self, "_active", False))

    async def probe_channel_alive(self) -> bool:
        """Best-effort liveness check of the service's command channel.

        Returns ``False`` only when the channel is provably dead so
        callers (e.g. :mod:`services.device_health`) can mark the device
        DEGRADED. The base implementation covers services without a
        cheap probe — legacy :class:`LegacyLocationService` (iOS < 17)
        uses a transport whose failure modes the on-connect probe was
        never designed to catch — and therefore always reports alive,
        matching the previous "can't safely probe → assume healthy"
        behavior.
        """
        return True


class DvtLocationService(LocationService):
    """
    Location simulation for iOS 17+ devices via the DVT LocationSimulation
    instrument.

    Holds a reference to the underlying lockdown/RSD service so it can
    fully recreate the DvtProvider when the channel drops (e.g. screen
    lock over WiFi).

    Parameters
    ----------
    dvt_provider
        An active DvtProvider session connected to the target device.
    lockdown
        The lockdown or RSD service used to create the DvtProvider.
        Needed for reconnection.
    """

    def __init__(
        self,
        dvt_provider: DvtProvider,
        lockdown=None,
        udid: str | None = None,
    ) -> None:
        self._dvt = dvt_provider
        self._lockdown = lockdown
        # Stamped onto tunnel_degraded/tunnel_recovered emits so the
        # renderer can target the matching device chip. Optional — older
        # call sites that don't supply it fall back to "apply hint to
        # every known device", which is still correct in single-device
        # mode and any "one tunnel per device" group setup.
        self._udid = udid
        self._location_sim: LocationSimulation | None = None
        self._active = False
        self._reconnect_lock = asyncio.Lock()

    async def aclose(self) -> None:
        """Close the CURRENT DvtProvider.

        ``_reconnect()`` swaps ``self._dvt`` to a fresh provider, so the
        ``conn.dvt_provider`` reference device_manager captured at connect
        time can go stale. Closing through this method guarantees the live
        DTXConnection's reader tasks get cancelled — otherwise they linger
        until GC and surface as asyncio "Task was destroyed but it is
        pending!" (dtx-reader / DTXChannelReader) noise mid-simulation.
        """
        async with self._reconnect_lock:
            self._location_sim = None
            dvt, self._dvt = self._dvt, None
            if dvt is None:
                return
            try:
                await dvt.__aexit__(None, None, None)
            except Exception as exc:
                logger.warning(
                    "Error closing DvtProvider for %s: %s", self._udid, exc,
                )

    async def _ensure_instrument(self) -> LocationSimulation:
        """Lazily create, connect, and cache the LocationSimulation instrument."""
        if self._location_sim is None:
            self._location_sim = LocationSimulation(self._dvt)
            await self._location_sim.connect()
            logger.debug("DVT LocationSimulation instrument initialised and connected")
        return self._location_sim

    async def _reconnect(self) -> None:
        """Tear down and fully recreate the DVT provider and instrument.

        Retries with a graded backoff totalling ~15s. The early attempts
        (0.5s, 2s elapsed) catch the common 1-2s blip fast; the later
        attempts (5s, 9s, 15s elapsed) cover screen-lock and WiFi-roam
        pauses that pymobiledevice3 can take several seconds to walk back
        from. 15s also matches the tunnel liveness probe window, so a
        truly-dead tunnel is broadcast as device_disconnected at roughly
        the same moment this gives up — the UI is never stuck in a
        "reconnecting" state past the point we've already declared the
        device gone.

        Emits ``tunnel_degraded`` once we commit to the reconnect (after
        the lock) so the renderer can show a "reconnecting…" hint
        instead of leaving the device pill confidently green for 15s.
        ``tunnel_recovered`` fires on any successful recreate; final
        failure falls through to ``_raise_device_lost`` whose
        ``device_disconnected`` broadcast supersedes the degraded state.
        """
        # Local imports: ``connection_state`` / ``ws_broadcaster`` import
        # nothing from this module, but several ``core/`` modules pull
        # ``location_service`` in at load time. Keeping these lazy
        # sidesteps any future re-ordering hazard.
        from services import connection_state
        from services.ws_broadcaster import broadcast

        async def _emit_degraded() -> None:
            if self._udid:
                await connection_state.mark_degraded(
                    self._udid, cause="dvt_channel_dropped",
                )
            else:
                # No UDID known — fall back to the legacy global broadcast
                # so the renderer's "apply to all runtimes" path still
                # triggers. This branch shouldn't fire in production
                # (DeviceManager always supplies a UDID) but keeps the
                # test surface and old callers happy.
                await broadcast(
                    "tunnel_degraded",
                    {"reason": "dvt_channel_dropped", "udid": None},
                )

        async def _emit_recovered() -> None:
            if self._udid:
                await connection_state.mark_recovered(self._udid)
            else:
                await broadcast("tunnel_recovered", {})

        async def _reconnect_once(log_msg: str, *log_args: object) -> None:
            """One DVT recreate attempt — installs the provider on success."""
            new_dvt = DvtProvider(self._lockdown)
            await new_dvt.__aenter__()
            self._dvt = new_dvt
            logger.info(log_msg, *log_args)
            await _emit_recovered()

        async with self._reconnect_lock:
            await _emit_degraded()

            # Close the old DVT provider gracefully
            try:
                await self._dvt.__aexit__(None, None, None)
            except Exception:
                logger.debug("Ignoring error while closing old DvtProvider")

            self._location_sim = None

            if self._lockdown is None:
                raise RuntimeError("Cannot reconnect DVT: no lockdown/RSD reference")

            # Schedule lives in config.DVT_RECONNECT_DELAYS so the rationale
            # (cumulative ≈15s, tight-then-stretched) sits next to the rest
            # of the project's tunables instead of being buried mid-method.
            #
            # Exit early on two consecutive ``TimeoutError``s. A timeout
            # on ``DvtProvider.__aenter__()`` means the TCP layer beneath
            # RSD is unresponsive — the classic symptom of a stale tunnel
            # that pymobiledevice3 silently dropped. Retrying the inner
            # DVT handshake against a dead tunnel just burns the remaining
            # ~13s of sleep before the outer ``exec_with_retry`` hard-reset
            # fires anyway. A ``ConnectionTerminatedError`` (channel-only
            # drop, e.g. brief screen-lock) resets the timeout streak so
            # the legitimate "wobble" case still gets all 5 attempts.
            last_exc: Exception | None = None
            consecutive_timeouts = 0
            bail_early = False
            for attempt, delay in enumerate(DVT_RECONNECT_DELAYS, start=1):
                try:
                    await _reconnect_once(
                        "DVT provider reconnected on attempt %d", attempt,
                    )
                    return
                except TimeoutError as exc:
                    last_exc = exc
                    consecutive_timeouts += 1
                    logger.warning(
                        "DVT reconnect attempt %d/%d timed out (%s); retrying in %.1fs",
                        attempt, len(DVT_RECONNECT_DELAYS), type(exc).__name__, delay,
                    )
                    if consecutive_timeouts >= 2:
                        logger.warning(
                            "DVT reconnect: %d consecutive timeouts — bailing to hard reset",
                            consecutive_timeouts,
                        )
                        bail_early = True
                        break
                    await asyncio.sleep(delay)
                except Exception as exc:
                    last_exc = exc
                    consecutive_timeouts = 0
                    logger.warning(
                        "DVT reconnect attempt %d/%d failed (%s); retrying in %.1fs",
                        attempt, len(DVT_RECONNECT_DELAYS), type(exc).__name__, delay,
                    )
                    await asyncio.sleep(delay)
            # Final try without delay — skipped on consecutive-timeout
            # bailout, since that signal is strong enough to skip
            # straight to the outer hard-reset.
            if not bail_early:
                try:
                    await _reconnect_once("DVT provider reconnected on final attempt")
                    return
                except Exception as exc:
                    last_exc = exc
            assert last_exc is not None  # delays loop ran at least once
            _raise_device_lost("DVT reconnect failed", last_exc)

    async def probe_channel_alive(self) -> bool:
        """Actively verify the DVT instrument channel is still usable.

        Only DvtLocationService (iOS 17+) is vulnerable to the silent
        idle-DVT-channel close this probe exists to catch. Runs
        :meth:`_ensure_instrument` under :attr:`_reconnect_lock` so the
        probe never races a concurrent :meth:`_reconnect`, bounded by
        :data:`_DVT_PROBE_TIMEOUT_S` so a wedged handshake can't pin the
        caller forever.

        Returns ``False`` only when the channel is provably dead
        (connection-terminated / socket-level errors / timeout). An
        unknown exception is logged and reported as alive — spurious
        failures here would flap the device pill for no reason.
        """
        try:
            async def _guarded_ensure() -> None:
                async with self._reconnect_lock:
                    await self._ensure_instrument()
            await asyncio.wait_for(_guarded_ensure(), timeout=_DVT_PROBE_TIMEOUT_S)
            return True
        except (ConnectionTerminatedError, OSError, EOFError, BrokenPipeError,
                ConnectionResetError, TimeoutError, asyncio.TimeoutError) as exc:
            logger.info(
                "DVT channel probe for %s failed (%s); channel presumed dead",
                self._udid, type(exc).__name__,
            )
            return False
        except Exception:
            # Unknown probe error — log but don't report the channel dead.
            logger.debug(
                "DVT channel probe for %s raised", self._udid, exc_info=True,
            )
            return True

    async def set(self, lat: float, lng: float) -> None:
        """Simulate the device location using the DVT instrument channel."""
        try:
            sim = await self._ensure_instrument()
            await sim.set(lat, lng)
            self._active = True
            logger.info("DVT location set to (%.6f, %.6f)", lat, lng)
        except (ConnectionTerminatedError, OSError, EOFError, BrokenPipeError,
                ConnectionResetError, asyncio.TimeoutError) as exc:
            logger.warning("DVT channel dropped (%s: %s); reconnecting and retrying",
                           type(exc).__name__, exc)
            await self._reconnect()
            sim = await self._ensure_instrument()
            await sim.set(lat, lng)
            self._active = True
            logger.info("DVT location set to (%.6f, %.6f) after reconnect", lat, lng)
        except Exception:
            logger.exception("Failed to set DVT simulated location")
            raise

    async def clear(self, *, quick: bool = False) -> None:
        """Clear the simulated location via the DVT instrument channel.

        Always sends clear to the device even when _active is False —
        the device may hold a stale simulated location from a prior
        session or backend restart. ``quick=True`` (used by
        DeviceManager.disconnect) skips the 15s reconnect ladder on a
        channel drop: the tunnel is about to be torn down anyway, so
        trying to revive DVT on a dead transport is wasted time.
        """
        try:
            sim = await self._ensure_instrument()
            await sim.clear()
            self._active = False
            logger.info("DVT simulated location cleared")
        except (ConnectionTerminatedError, OSError, EOFError, BrokenPipeError,
                ConnectionResetError, asyncio.TimeoutError) as exc:
            if quick:
                logger.info(
                    "DVT channel dropped during teardown clear (%s); "
                    "skipping reconnect — caller is about to disconnect",
                    type(exc).__name__,
                )
                self._active = False
                return
            logger.warning("DVT channel dropped during clear (%s: %s); reconnecting",
                           type(exc).__name__, exc)
            await self._reconnect()
            sim = await self._ensure_instrument()
            await sim.clear()
            self._active = False
            logger.info("DVT simulated location cleared after reconnect")
        except Exception:
            logger.exception("Failed to clear DVT simulated location")
            raise


class LegacyLocationService(LocationService):
    """
    Location simulation for iOS < 17 devices via DtSimulateLocation.

    Parameters
    ----------
    lockdown_client
        A lockdown service provider (LockdownClient) for the target device.
    """

    def __init__(self, lockdown_client) -> None:
        self._lockdown = lockdown_client
        self._service: DtSimulateLocation | None = None
        self._active = False

    def _ensure_service(self) -> DtSimulateLocation:
        """Lazily create and cache the DtSimulateLocation service."""
        if self._service is None:
            self._service = DtSimulateLocation(self._lockdown)
            logger.debug("Legacy DtSimulateLocation service initialised")
        return self._service

    async def _maybe_await(self, result) -> None:
        """Support both sync and async DtSimulateLocation methods."""
        if asyncio.iscoroutine(result):
            await result

    async def _reset_service(self) -> None:
        """Drop the cached DtSimulateLocation so the next call reconstructs it."""
        try:
            if self._service is not None and hasattr(self._service, "close"):
                await self._maybe_await(self._service.close())
        except Exception:
            logger.debug("Error closing stale DtSimulateLocation", exc_info=True)
        self._service = None

    async def set(self, lat: float, lng: float) -> None:
        """Simulate the device location using the legacy service."""
        try:
            svc = self._ensure_service()
            await self._maybe_await(svc.set(lat, lng))
            self._active = True
            logger.info("Legacy location set to (%.6f, %.6f)", lat, lng)
        except (OSError, EOFError, BrokenPipeError, ConnectionResetError) as exc:
            logger.warning("Legacy location channel dropped (%s: %s); reconnecting and retrying",
                           type(exc).__name__, exc)
            await self._reset_service()
            try:
                svc = self._ensure_service()
                await self._maybe_await(svc.set(lat, lng))
                self._active = True
                logger.info("Legacy location set to (%.6f, %.6f) after reconnect", lat, lng)
            except Exception as retry_exc:
                _raise_device_lost("Legacy reconnect failed", retry_exc)
        except Exception:
            logger.exception("Failed to set legacy simulated location")
            raise

    async def clear(self, *, quick: bool = False) -> None:
        """Clear the simulated location using the legacy service.

        Always sends clear to the device even when _active is False —
        the device may hold a stale simulated location from a prior
        session or backend restart. ``quick=True`` (used by
        DeviceManager.disconnect) skips the reconnect-and-retry path on
        a channel drop, matching DvtLocationService for parity.

        Raises DeviceLostError on retry-after-reconnect failure (only
        on the normal path), matching the discipline in set().
        """
        try:
            svc = self._ensure_service()
            await self._maybe_await(svc.clear())
            self._active = False
            logger.info("Legacy simulated location cleared")
        except (OSError, EOFError, BrokenPipeError, ConnectionResetError) as exc:
            if quick:
                logger.info(
                    "Legacy clear channel dropped during teardown (%s); "
                    "skipping reconnect — caller is about to disconnect",
                    type(exc).__name__,
                )
                self._active = False
                return
            logger.warning("Legacy clear channel dropped (%s: %s); reconnecting",
                           type(exc).__name__, exc)
            await self._reset_service()
            try:
                svc = self._ensure_service()
                await self._maybe_await(svc.clear())
                self._active = False
            except Exception as retry_exc:
                _raise_device_lost("Legacy clear failed after reconnect", retry_exc)
        except Exception:
            logger.exception("Failed to clear legacy simulated location")
            raise
