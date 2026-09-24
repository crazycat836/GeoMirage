"""
GeoMirage DDI mount + location-service factory helpers.

Extracted from ``device_manager.py`` to keep that hub focused on
connection lifecycle. This module owns:

* Personalized Developer Disk Image mounting for iOS 17+ devices
  (the ``auto_mount_personalized`` wrapper, with timeout + cross-device
  serialisation + frontend broadcasts).
* Best-effort classic Developer Disk Image mounting for iOS 16.x.
* The ``DvtProvider`` / ``LegacyLocationService`` factory functions
  that depend on a mounted DDI.

All functions are free functions taking the live connection record and
collaborators (lock, broadcasters) explicitly. ``DeviceManager`` calls
into them; they never reach back. This minimises coupling and keeps the
DDI/DVT failure paths unit-testable in isolation.
"""

from __future__ import annotations

import asyncio
import logging
import plistlib
import threading
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, TypeVar

from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider

from services.location_service import (
    DvtLocationService,
    LegacyLocationService,
)

if TYPE_CHECKING:
    from core.device_manager import _ActiveConnection


logger = logging.getLogger(__name__)


# ``reason`` value the frontend keys on to swap the generic "mount DDI
# manually" hint for the Developer-Mode-specific one (with a reveal button).
REASON_DEVELOPER_MODE_DISABLED = "developer_mode_disabled"
REASON_DOWNLOAD_TIMEOUT = "download_timeout"
REASON_DOWNLOAD_FAILED = "download_failed"
REASON_DEVICE_LOCKED = "device_locked"
REASON_DEVICE_UNREACHABLE = "device_unreachable"
HINT_KEY_DEFAULT = "ddi.missing_hint"
HINT_KEY_DEVELOPER_MODE = "ddi.developer_mode_disabled"
HINT_KEY_DOWNLOAD_TIMEOUT = "ddi.download_timeout"
HINT_KEY_DOWNLOAD_FAILED = "ddi.download_failed"
HINT_KEY_DEVICE_LOCKED = "ddi.device_locked"
HINT_KEY_DEVICE_UNREACHABLE = "ddi.device_unreachable"

# ``ddi_mounting`` stages, so the overlay can say which step is running.
STAGE_DOWNLOADING = "downloading"
STAGE_MOUNTING = "mounting"

# Waiting on the personalized image download (~15 MB from GitHub) before
# telling the user. The download itself keeps running after this.
DDI_DOWNLOAD_TIMEOUT_S = 60.0
# (connect, read) socket timeouts for each download request. The read
# timeout is the longest silence tolerated between chunks, so a slow but
# moving download is never cut off.
DDI_HTTP_TIMEOUT = (10.0, 30.0)
# Image upload + TSS signing + mount on the device, once the image is local.
DDI_MOUNT_TIMEOUT_S = 45.0
# The frontend overlay's safety timeout (App.tsx DDI_SAFETY_TIMEOUT_MS)
# must stay above DDI_DOWNLOAD_TIMEOUT_S + DDI_MOUNT_TIMEOUT_S.

_T = TypeVar("_T")


async def broadcast_ddi_mount_failure(
    udid: str, stage: str, reason: str, hint_key: str = HINT_KEY_DEFAULT,
) -> None:
    """Emit the structured failure pair the frontend expects.

    ``ddi_mount_missing`` drives the user-facing hint banner;
    ``ddi_mount_failed`` is the legacy event name retained for
    downstream consumers. Both carry the same fields so either can be
    handled consistently. ``hint_key`` selects which i18n string the
    banner renders.
    """
    try:
        from services.ws_broadcaster import broadcast
        payload = {
            "udid": udid,
            "stage": stage,
            "reason": reason,
            "hint_key": hint_key,
        }
        await broadcast("ddi_mount_missing", payload)
        await broadcast("ddi_mount_failed", {**payload, "error": reason})
    except Exception:
        logger.debug("ddi broadcast failed", exc_info=True)


async def _broadcast_mounting(udid: str, stage: str) -> None:
    try:
        from services.ws_broadcaster import broadcast
        await broadcast("ddi_mounting", {"udid": udid, "stage": stage})
    except Exception:
        logger.debug("ddi_mounting WS broadcast failed (%s)", stage, exc_info=True)


# ── Personalized image download ──────────────────────────────────
#
# pymobiledevice3's ``fetch_personalized_ddi`` downloads ~15 MB from
# raw.githubusercontent.com with a synchronous ``requests.get`` and no
# timeout. Called on the event loop (as ``auto_mount_personalized`` does)
# it freezes the whole backend for the length of the download: WebSocket
# frames stop, the WiFi tunnel misses its keep-alives and drops, and the
# mount then fails on a dead connection. So the download runs in a
# daemon thread, bounded per request, and the mount only starts once the
# image is on disk.

def _personalized_ddi_cached() -> bool:
    """True when the local cache already holds the image pymobiledevice3
    expects, i.e. ``fetch_personalized_ddi`` will not touch the network."""
    try:
        import pymobiledevice3.services.mobile_image_mounter as mim
        manifest = mim.get_home_folder() / "Xcode_iOS_DDI_Personalized" / "BuildManifest.plist"
        return plistlib.loads(manifest.read_bytes()).get("ProductBuildVersion") == mim.LATEST_DDI_BUILD_ID
    except Exception:
        return False


class _BoundedRequests:
    """Stand-in for the ``requests`` module inside ``developer_disk_image.repo``
    that adds socket timeouts to ``get``. A stalled connection then raises
    instead of pinning the download thread forever."""

    def __init__(self, real: Any) -> None:
        self._real = real

    def get(self, *args: Any, **kwargs: Any) -> Any:
        kwargs.setdefault("timeout", DDI_HTTP_TIMEOUT)
        return self._real.get(*args, **kwargs)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._real, name)


def _fetch_personalized_ddi() -> tuple[Path, Path, Path]:
    import pymobiledevice3.services.mobile_image_mounter as mim
    try:
        import developer_disk_image.repo as ddi_repo
        if not isinstance(ddi_repo.requests, _BoundedRequests):
            ddi_repo.requests = _BoundedRequests(ddi_repo.requests)
    except (ImportError, AttributeError):
        logger.debug("developer_disk_image.repo layout changed; downloading without socket timeouts")
    return mim.fetch_personalized_ddi()


def _run_in_daemon_thread(fn: Callable[[], _T]) -> "asyncio.Future[_T]":
    """Like ``asyncio.to_thread`` but on a daemon thread, so a download
    still in flight never holds up backend shutdown."""
    loop = asyncio.get_running_loop()
    fut: asyncio.Future[_T] = loop.create_future()

    def settle(setter: Callable[[Any], None], value: Any) -> None:
        if not fut.done():
            setter(value)

    def runner() -> None:
        try:
            result = fn()
        except BaseException as exc:  # noqa: BLE001 — handed to the awaiting coroutine
            outcome: tuple[Callable[[Any], None], Any] = (fut.set_exception, exc)
        else:
            outcome = (fut.set_result, result)
        try:
            loop.call_soon_threadsafe(settle, *outcome)
        except RuntimeError:
            pass  # loop already closed (shutdown) — nobody is waiting

    threading.Thread(target=runner, name="ddi-download", daemon=True).start()
    # Mark the exception retrieved when every waiter has timed out and left.
    fut.add_done_callback(lambda f: None if f.cancelled() else f.exception())
    return fut


_download_future: "asyncio.Future[tuple[Path, Path, Path]] | None" = None


def _ensure_download() -> "asyncio.Future[tuple[Path, Path, Path]]":
    """Single-flight download: callers share one in-flight fetch. A
    finished (or failed) fetch is not reused, so the next call re-checks
    the cache and retries."""
    global _download_future
    if _download_future is None or _download_future.done():
        _download_future = _run_in_daemon_thread(_fetch_personalized_ddi)
    return _download_future


async def prefetch_personalized_ddi() -> None:
    """Warm the image cache at startup so connecting never waits on
    GitHub. Only downloads after a pymobiledevice3 upgrade or a cleared
    cache; failures are logged and retried on the next connect."""
    if _personalized_ddi_cached():
        return
    logger.info("Personalized DDI not cached; downloading in background")
    try:
        await asyncio.shield(_ensure_download())
        logger.info("Personalized DDI downloaded")
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.warning("Background DDI download failed; will retry on connect", exc_info=True)


def _classify_mount_error(exc: BaseException, timed_out: bool) -> tuple[str, str]:
    """Map a mount failure to the (reason, hint_key) pair the banner shows."""
    if timed_out:
        return REASON_DEVICE_UNREACHABLE, HINT_KEY_DEVICE_UNREACHABLE
    if "DeviceLocked" in str(exc):
        return REASON_DEVICE_LOCKED, HINT_KEY_DEVICE_LOCKED
    try:
        from pymobiledevice3.exceptions import ConnectionTerminatedError
    except ImportError:  # pragma: no cover - version drift
        ConnectionTerminatedError = OSError  # type: ignore[misc,assignment]
    # On Python 3.11+ an OS socket timeout is a TimeoutError too; since our
    # own timeout was ruled out above, it can only come from the device link.
    if isinstance(exc, (OSError, ConnectionTerminatedError)) or (
        isinstance(exc, RuntimeError) and "closed" in str(exc)
    ):
        return REASON_DEVICE_UNREACHABLE, HINT_KEY_DEVICE_UNREACHABLE
    return f"{type(exc).__name__}: {exc}", HINT_KEY_DEFAULT


async def ensure_personalized_ddi_mounted(
    conn: "_ActiveConnection", mount_lock: asyncio.Lock
) -> None:
    """For iOS 17+ devices, make sure the Personalized Developer Disk Image
    is mounted. Without the DDI, the DVT service hub won't advertise and
    DvtProvider will fail with "No such service: com.apple.instruments.dtservicehub".

    If already mounted, this is a no-op. Otherwise it makes sure the image
    is downloaded (off the event loop, see ``_ensure_download``) and then
    mounts it. The per-device signing (TSS) is handled by pymobiledevice3.
    Each failure is reported with its own ``reason`` / ``hint_key`` so the
    UI can say what actually went wrong.
    """
    try:
        import pymobiledevice3.services.mobile_image_mounter as mim
        from pymobiledevice3.exceptions import DeveloperModeIsNotEnabledError
        from pymobiledevice3.services.mobile_image_mounter import (
            MobileImageMounterService,
            AlreadyMountedError,
        )
    except ImportError as exc:
        logger.warning(
            "pymobiledevice3.mobile_image_mounter not importable (%s: %s); "
            "skipping DDI mount",
            type(exc).__name__, exc,
        )
        return

    # 1. Check whether a Personalized image is already mounted.
    try:
        mounter = MobileImageMounterService(lockdown=conn.lockdown)
        try:
            await mounter.connect()
            if await mounter.is_image_mounted("Personalized"):
                logger.debug("Personalized DDI already mounted on %s", conn.udid)
                return
        finally:
            try:
                await mounter.close()
            except Exception:
                logger.debug("mounter.close() failed (personalized status path)", exc_info=True)
    except Exception:
        logger.warning("Could not query image mount status; will attempt to mount anyway", exc_info=True)

    # 2. Not mounted. Get the image on disk first — only the network step,
    # in a thread, so the loop (and the WiFi tunnel) stay alive — then
    # mount it on the loop, where the lockdown connection's futures live.
    cached = _personalized_ddi_cached()
    logger.info(
        "Personalized DDI not mounted on %s; %s",
        conn.udid, "mounting from cache" if cached else "downloading image first (~15MB)",
    )
    await _broadcast_mounting(conn.udid, STAGE_MOUNTING if cached else STAGE_DOWNLOADING)

    download_timeout = asyncio.timeout(DDI_DOWNLOAD_TIMEOUT_S)
    try:
        async with download_timeout:
            # shield: a timed-out waiter must not cancel the shared download,
            # which keeps going so the next attempt finds the image cached.
            image, build_manifest, trustcache = await asyncio.shield(_ensure_download())
    except Exception as exc:
        if isinstance(exc, TimeoutError) and download_timeout.expired():
            logger.error(
                "DDI download not finished after %.0fs for %s; continuing in background",
                DDI_DOWNLOAD_TIMEOUT_S, conn.udid,
            )
            await broadcast_ddi_mount_failure(
                conn.udid, "download", REASON_DOWNLOAD_TIMEOUT, hint_key=HINT_KEY_DOWNLOAD_TIMEOUT,
            )
            raise RuntimeError(
                "DDI download timed out — check network access to raw.githubusercontent.com"
            ) from exc
        logger.error("DDI download failed for %s", conn.udid, exc_info=True)
        await broadcast_ddi_mount_failure(
            conn.udid, "download", REASON_DOWNLOAD_FAILED, hint_key=HINT_KEY_DOWNLOAD_FAILED,
        )
        raise

    if not cached:
        await _broadcast_mounting(conn.udid, STAGE_MOUNTING)
    mount_timeout = asyncio.timeout(DDI_MOUNT_TIMEOUT_S)
    mount_succeeded = False
    try:
        # Serialise across devices: two mounts on one Mac race the TSS
        # ticket request and the image upload.
        async with mount_lock:
            async with mount_timeout:
                await mim.PersonalizedImageMounter(lockdown=conn.lockdown).mount(
                    image, build_manifest, trustcache,
                )
        logger.info("Personalized DDI mounted successfully for %s", conn.udid)
        mount_succeeded = True
    except AlreadyMountedError:
        logger.info("DDI was mounted concurrently for %s", conn.udid)
        mount_succeeded = True
    except DeveloperModeIsNotEnabledError:
        # Personalized DDI cannot mount while Developer Mode is off (a
        # major iOS upgrade resets it). Mounting via Xcode / 3uTools
        # will not help here, so send a dedicated hint instead of the
        # generic "mount manually" one.
        logger.error(
            "Developer Mode is disabled on %s; cannot mount personalized DDI",
            conn.udid,
        )
        conn.developer_mode_enabled = False
        await broadcast_ddi_mount_failure(
            conn.udid, "personalized",
            REASON_DEVELOPER_MODE_DISABLED,
            hint_key=HINT_KEY_DEVELOPER_MODE,
        )
        raise
    except Exception as exc:
        timed_out = isinstance(exc, TimeoutError) and mount_timeout.expired()
        reason, hint_key = _classify_mount_error(exc, timed_out)
        logger.error("Personalized DDI mount failed for %s (%s)", conn.udid, reason, exc_info=True)
        await broadcast_ddi_mount_failure(conn.udid, "personalized", reason, hint_key=hint_key)
        if timed_out:
            raise RuntimeError(
                f"DDI mount timed out after {DDI_MOUNT_TIMEOUT_S:.0f}s — iPhone stopped responding"
            ) from exc
        raise
    finally:
        if mount_succeeded:
            try:
                from services.ws_broadcaster import broadcast
                await broadcast("ddi_mounted", {"udid": conn.udid})
            except Exception:
                logger.debug("ddi_mounted WS broadcast failed (personalized)", exc_info=True)


async def ensure_classic_ddi_mounted(conn: "_ActiveConnection") -> None:
    """Best-effort Developer Disk Image mount for iOS 16.x devices."""
    try:
        import pymobiledevice3.services.mobile_image_mounter as mim
    except ImportError as exc:
        logger.warning(
            "pymobiledevice3.mobile_image_mounter not importable (%s: %s); "
            "skipping classic DDI mount",
            type(exc).__name__, exc,
        )
        return

    mounter_cls = getattr(mim, "MobileImageMounterService", None)
    if mounter_cls is not None:
        try:
            mounter = mounter_cls(lockdown=conn.lockdown)
            try:
                await mounter.connect()
                if await mounter.is_image_mounted("Developer"):
                    logger.debug("Classic DDI already mounted on %s", conn.udid)
                    return
            finally:
                try:
                    await mounter.close()
                except Exception:
                    logger.debug("mounter.close() failed (classic status path)", exc_info=True)
        except Exception:
            logger.warning("Could not query classic DDI mount state", exc_info=True)

    mount_fn = None
    for name in ("auto_mount_developer", "auto_mount", "auto_mount_disk_image"):
        candidate = getattr(mim, name, None)
        if callable(candidate):
            mount_fn = candidate
            break
    if mount_fn is None:
        logger.warning("No classic DDI auto-mount helper found; continuing without mount")
        return

    logger.info("Classic DDI not mounted on %s; attempting auto-mount", conn.udid)
    try:
        from services.ws_broadcaster import broadcast
        await broadcast("ddi_mounting", {"udid": conn.udid})
    except Exception:
        logger.debug("ddi_mounting WS broadcast failed (classic)", exc_info=True)

    mounted = False
    failure_reason: str | None = None
    try:
        await asyncio.wait_for(mount_fn(conn.lockdown), timeout=120.0)
        mounted = True
        logger.info("Classic DDI mounted successfully for %s", conn.udid)
    except Exception as exc:
        failure_reason = f"{type(exc).__name__}: {exc}"
        logger.warning("Classic DDI auto-mount failed for %s", conn.udid, exc_info=True)
    finally:
        if mounted:
            try:
                from services.ws_broadcaster import broadcast
                await broadcast("ddi_mounted", {"udid": conn.udid})
            except Exception:
                logger.debug("ddi_mounted WS broadcast failed (classic)", exc_info=True)
        else:
            await broadcast_ddi_mount_failure(
                conn.udid, "classic",
                failure_reason or "Classic DDI mount failed",
            )


async def create_dvt_location_service(
    conn: "_ActiveConnection", mount_lock: asyncio.Lock
) -> DvtLocationService:
    """Spin up a DVT provider and hand it to ``DvtLocationService``.

    If DVT fails because the Developer Disk Image is not mounted,
    we try to mount it automatically and retry once.
    """
    # Try to mount DDI proactively (fast no-op when already mounted).
    try:
        await ensure_personalized_ddi_mounted(conn, mount_lock)
    except Exception:
        logger.warning("DDI auto-mount failed; DVT may still fail", exc_info=True)

    try:
        dvt = DvtProvider(conn.lockdown)
        await dvt.__aenter__()
        conn.dvt_provider = dvt
        logger.debug("DVT provider opened for %s", conn.udid)
        return DvtLocationService(dvt, lockdown=conn.lockdown, udid=conn.udid)
    except Exception as dvt_exc:
        logger.warning(
            "DVT location service failed for %s (%s). Falling back to "
            "legacy DtSimulateLocation over lockdown.",
            conn.udid, dvt_exc,
        )
        # iOS 17+ still exposes com.apple.dt.simulatelocation on some
        # devices (reported working on iOS 26 by multiple users), so
        # try the legacy service before giving up entirely.
        try:
            # Prefer the original usbmux/TCP lockdown for DtSimulateLocation;
            # fall back to whatever we have stored if not available.
            legacy_lockdown = conn.usbmux_lockdown or conn.lockdown
            legacy = LegacyLocationService(legacy_lockdown, udid=conn.udid)
            logger.info("Using LegacyLocationService fallback for %s", conn.udid)
            return legacy
        except Exception:
            logger.exception(
                "Both DVT and legacy location services failed for %s", conn.udid
            )
            raise dvt_exc


async def create_legacy_location_service(
    conn: "_ActiveConnection",
) -> LegacyLocationService:
    """Build the legacy location service for iOS 16.x devices."""
    try:
        await ensure_classic_ddi_mounted(conn)
    except Exception:
        logger.warning("Classic DDI auto-mount failed; legacy location may still fail", exc_info=True)
    logger.info("Using LegacyLocationService for %s", conn.udid)
    return LegacyLocationService(conn.lockdown, udid=conn.udid)
