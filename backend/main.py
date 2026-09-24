import asyncio
import logging
import os
import secrets
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware

import auth
from services.json_store import StorePersistError
from services.route_service import RouteUnavailableError
from api._envelope import (
    EnvelopeJSONResponse,
    http_exception_handler,
    internal_exception_handler,
    route_unavailable_handler,
    store_persist_error_handler,
    unauthorized_response,
    validation_exception_handler,
)
from config import (
    API_HOST,
    API_PORT,
    DATA_DIR,
    TOKEN_FILE,
    ensure_data_dir,
)
from logging_config import UVICORN_LOG_CONFIG, setup_logging
from services.json_safe import chown_back
from state import AppState
from version import __version__

# Move a data dir left by an earlier product name (~/.gpscontroller, then
# the older ~/.locwarp) to ~/.geomirage. The first one found wins.
_new_data_dir = Path.home() / ".geomirage"
for _old_data_dir in (Path.home() / ".gpscontroller", Path.home() / ".locwarp"):
    if _new_data_dir.exists():
        break
    if not _old_data_dir.exists():
        continue
    try:
        _old_data_dir.rename(_new_data_dir)
    except OSError as exc:
        # cross-device or permission issue — ignore, will create fresh.
        # Log so a permissions bug doesn't silently lose persistent settings.
        logging.getLogger("geomirage").debug(
            "legacy data-dir rename failed (%s -> %s): %s",
            _old_data_dir, _new_data_dir, exc,
        )

# Logging setup (formatters, rotating file handler, uvicorn access filter)
# lives in `logging_config.py` so this entrypoint stays focused on app
# wiring. Returns the canonical "geomirage" logger.
logger = setup_logging(_new_data_dir / "logs")


# The session auth token and policy helpers (API_TOKEN, _is_auth_disabled,
# _DOCS_ENABLED, _AUTH_EXEMPT_PATHS) live in the leaf `auth` module so the
# routers don't reach up into this entrypoint for them. The token below is
# (re)assigned on `auth` during lifespan and read late-bound everywhere.


def _open_and_write_token(token: str) -> None:
    """Single 0600-atomic write attempt for the session token file.

    Using ``Path.write_text`` followed by ``os.chmod`` opens a race window
    where the token sits at the default umask (typically 0o644) and is
    world-readable for the duration of the chmod. ``os.open`` with the
    mode supplied up-front lets the kernel apply 0o600 atomically before
    any data lands. Windows ignores the mode bits and relies on user-
    profile ACLs to keep the file private.
    """
    fd = os.open(
        str(TOKEN_FILE),
        os.O_WRONLY | os.O_CREAT | os.O_TRUNC,
        0o600,
    )
    try:
        os.write(fd, token.encode("utf-8"))
    finally:
        os.close(fd)


def _write_token_file(token: str) -> None:
    """Write the session token to ~/.geomirage/token with mode 0600.

    Recovers from a stale root-owned token: a previous `sudo python3
    start.py` run could leave the file owned by root, so the next
    unprivileged run gets EACCES on open. The directory itself is owned
    by the user, so unlink-and-rewrite succeeds where the in-place
    truncate cannot — without this the user is locked out until they
    delete the file by hand.

    After a successful write, ``chown_back`` hands ownership back to the
    invoking user when running under sudo (same sudo-drop every other
    persisted file gets via ``safe_write_json``), so the renderer can
    read the token and the NEXT non-sudo run can rewrite it.
    """
    try:
        _open_and_write_token(token)
    except PermissionError:
        logger.warning(
            "Token file %s is not writable (stale root-owned file from a "
            "previous sudo run?) — removing and rewriting", TOKEN_FILE,
        )
        TOKEN_FILE.unlink(missing_ok=True)
        _open_and_write_token(token)
    chown_back(TOKEN_FILE)


app_state = AppState()
from context import ctx
ctx.app_state = app_state


# ── Lifespan ─────────────────────────────────────────────

# Grace window for cooperative-exit background loops before they get
# force-cancelled at shutdown.
_SHUTDOWN_GRACE_S = 2.0


async def _stop_background_task(
    task: asyncio.Task,
    stop_event: asyncio.Event,
    *,
    label: str,
    timeout_s: float = _SHUTDOWN_GRACE_S,
) -> None:
    """Signal a cooperative-exit loop to stop, cancelling it on timeout.

    Shared teardown for the lifespan background loops (liveness probe,
    WiFi keep-alive). Sets *stop_event*, waits up to *timeout_s* for the
    task to unblock, and falls back to cancel if it doesn't.
    """
    stop_event.set()
    try:
        await asyncio.wait_for(task, timeout=timeout_s)
    except asyncio.TimeoutError:
        # Cooperative exit didn't finish in the grace window — force it.
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass
    except asyncio.CancelledError:
        pass
    except Exception:
        # A genuine bug in the loop teardown — don't let it vanish.
        logger.exception("shutdown: %s raised during teardown", label)

@asynccontextmanager
async def lifespan(application: FastAPI):
    from services import connection_state

    # Wire the single WS observer that translates every per-device state
    # transition into the existing WS event contract. Done first so the
    # startup auto-connect below routes through it instead of duplicating
    # the broadcast logic inline.
    connection_state.install_ws_observer()

    # ── Startup ──
    # Create ~/.geomirage before anything tries to write inside it
    # (TOKEN_FILE below, settings/bookmarks/routes via API). Deferred from
    # config.py module load so tests that import config don't hit disk.
    ensure_data_dir()
    # A privileged run that created the directory leaves it root-owned, and
    # the next unprivileged run then can't create the token file inside it.
    chown_back(DATA_DIR)

    if auth._is_auth_disabled():
        auth.API_TOKEN = ""
        # Remove any stale token file so dev-mode frontends can't
        # accidentally pick up a value from a previous packaged run.
        try:
            TOKEN_FILE.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            logger.exception("Failed to remove stale token file")
        logger.warning(
            "Auth DISABLED (GEOMIRAGE_DEV_NOAUTH=1) — API reachable without X-GPS-Token",
        )
    else:
        auth.API_TOKEN = secrets.token_urlsafe(32)
        try:
            _write_token_file(auth.API_TOKEN)
            logger.info("Session token written to %s", TOKEN_FILE)
        except OSError:
            logger.exception("Failed to write token file; renderer will not be able to auth")

    # No startup auto-connect. Launching must never auto-pair or
    # auto-connect a plugged-in device — that popped the "Trust This
    # Computer" prompt on every launch and silently re-paired devices the
    # user had just removed. Devices are enumerated on demand via
    # /api/device/list (which never pairs) and the user connects one
    # explicitly from the UI.
    logger.info("GeoMirage started — connect a device from the UI when ready")

    from services.device_watchdog import usbmux_presence_watchdog
    watchdog_task = asyncio.create_task(usbmux_presence_watchdog(app_state))

    # WiFi tunnel liveness probe — TCP-pings the active tunnel's RSD endpoint
    # and tears down stale Network connections when it stops responding. The
    # existing _tunnel_watchdog only fires when the tunnel asyncio task
    # raises; this probe covers the silent-death case (iPhone leaves WiFi /
    # Mac wakes from sleep with a dead tunnel).
    from core.tunnel_liveness import tunnel_liveness_loop
    liveness_stop = asyncio.Event()
    liveness_task = asyncio.create_task(
        tunnel_liveness_loop(liveness_stop, app_state),
    )

    # WiFi keep-alive — opt-in (Settings toggle). When enabled, periodically
    # re-asserts idle engines' virtual locations so the DVT channel stays warm
    # and the tunnel survives the iPhone screen dimming. No-ops while disabled.
    from core.wifi_keepalive import wifi_keepalive_loop
    keepalive_stop = asyncio.Event()
    keepalive_task = asyncio.create_task(
        wifi_keepalive_loop(keepalive_stop, app_state),
    )

    # Launcher watch — opt-in via GEOMIRAGE_PARENT_PID. The packaged macOS
    # shell starts this process with administrator rights and so cannot
    # signal it on quit; the loop exits the backend once the shell is gone.
    from core.parent_watch import (
        parent_pid_from_env,
        parent_watch_loop,
        request_exit,
    )
    parent_watch_stop = asyncio.Event()
    parent_watch_task = None
    parent_pid = parent_pid_from_env()
    if parent_pid is not None:
        parent_watch_task = asyncio.create_task(
            parent_watch_loop(
                parent_pid,
                parent_watch_stop,
                on_gone=lambda: request_exit(
                    getattr(application.state, "uvicorn_server", None),
                ),
            ),
        )

    # Download the iOS 17+ Developer Disk Image now (only when the cache is
    # missing or outdated, e.g. after a pymobiledevice3 upgrade) so the
    # first connect mounts from disk instead of waiting on GitHub.
    from core.ddi_mount import prefetch_personalized_ddi
    ddi_prefetch_task = asyncio.create_task(prefetch_personalized_ddi())

    yield

    # ── Shutdown ──
    # Signal cooperative-exit loops first, then fall back to cancel if
    # they don't unblock within the grace window.
    await _stop_background_task(liveness_task, liveness_stop, label="liveness loop")
    await _stop_background_task(keepalive_task, keepalive_stop, label="keep-alive loop")
    if parent_watch_task is not None:
        await _stop_background_task(
            parent_watch_task, parent_watch_stop, label="launcher watch loop",
        )

    # The download runs on a daemon thread; cancelling only stops waiting.
    ddi_prefetch_task.cancel()
    await asyncio.gather(ddi_prefetch_task, return_exceptions=True)
    watchdog_task.cancel()
    try:
        await watchdog_task
    except asyncio.CancelledError:
        pass
    except Exception:
        logger.exception("shutdown: watchdog task raised during teardown")

    # Tear down the WiFi tunnel (if running) and its watchdog. The liveness /
    # usbmux loops above don't own these — without this an active RemotePairing
    # tunnel context is abandoned on shutdown, leaking the OS tun interface and
    # logging "Task was destroyed but it is pending". Order mirrors the
    # /wifi/tunnel/stop route: cancel the watchdog BEFORE stopping the tunnel
    # so it can't race the teardown. Both calls are idempotent.
    try:
        from services.wifi_tunnel_service import cancel_watchdog, tunnel as wifi_tunnel
        cancel_watchdog()
        await wifi_tunnel.stop()
    except Exception:
        logger.exception("shutdown: WiFi tunnel teardown failed")

    app_state.save_settings()
    # Stop all simulation engines before we drop transport. Otherwise
    # async tasks racing against `disconnect_all()` can log push failures
    # during shutdown.
    for udid in list(app_state.simulation_engines.keys()):
        try:
            await app_state.terminate_engine(udid)
        except Exception:
            logger.exception("shutdown: terminate_engine failed for %s", udid)
    # Cancel any still-in-flight dual-device auto-sync tasks so they can't
    # outlive the engines they target (terminate_engine already cancels the
    # task for each udid it stops; this drains any leftover).
    await app_state.cancel_sync_tasks()
    await app_state.device_manager.disconnect_all()

    # Release the shared HTTP clients last so any in-flight request from
    # the engine teardown above completes before the pool is torn down.
    try:
        from services.geocoding import close_client as close_geocoding_client
        from services.geocoding_google import close_client as close_google_client
        from services.geocoding_photon import close_client as close_photon_client
        await close_geocoding_client()
        await close_photon_client()
        await close_google_client()
    except Exception:
        logger.exception("shutdown: close_geocoding_client failed")
    try:
        from services.route_service import close_client as close_route_client
        await close_route_client()
    except Exception:
        logger.exception("shutdown: close_route_client failed")
    try:
        from services.route_optimizer import close_client as close_optimizer_client
        await close_optimizer_client()
    except Exception:
        logger.exception("shutdown: close_optimizer_client failed")

    logger.info("GeoMirage shut down")


# ── FastAPI app ───────────────────────────────────────────

app = FastAPI(
    title="GeoMirage",
    version=__version__,
    description="iOS Virtual Location Simulator",
    lifespan=lifespan,
    # Every JSON response is auto-wrapped in {success, data, error, meta}
    # by EnvelopeJSONResponse. File-download endpoints that explicitly
    # return a Response(content=bytes, ...) bypass this so binary payloads
    # remain unwrapped.
    default_response_class=EnvelopeJSONResponse,
    docs_url="/docs" if auth._DOCS_ENABLED else None,
    redoc_url="/redoc" if auth._DOCS_ENABLED else None,
    openapi_url="/openapi.json" if auth._DOCS_ENABLED else None,
)

# Convert HTTPException + 422 RequestValidationError into the same
# error envelope shape so the frontend has a single failure shape to parse.
# The catch-all Exception handler keeps that contract for uncaught errors
# too (full traceback logged server-side; generic envelope on the wire).
app.add_exception_handler(HTTPException, http_exception_handler)
app.add_exception_handler(RequestValidationError, validation_exception_handler)
app.add_exception_handler(RouteUnavailableError, route_unavailable_handler)
app.add_exception_handler(StorePersistError, store_persist_error_handler)
app.add_exception_handler(Exception, internal_exception_handler)

class _TokenAuthMiddleware(BaseHTTPMiddleware):
    """Gate every request by an `X-GPS-Token` header.

    Exempts a small set of health / docs paths so the Electron shell can
    probe the backend before it has read the token file. When
    GEOMIRAGE_DEV_NOAUTH=1 is set, or a WebSocket upgrade is being
    negotiated (auth is then enforced via the first WS frame — see
    api/websocket.py), the middleware short-circuits and lets the request
    through.
    """

    async def dispatch(self, request: Request, call_next):
        if auth._is_auth_disabled():
            return await call_next(request)
        path = request.url.path
        if path in auth._AUTH_EXEMPT_PATHS:
            return await call_next(request)
        # WebSocket connects arrive as ASGI "websocket" scope; HTTP
        # middleware still sees them on the way up. Let ws paths through
        # so the router-level WebSocket handler can require the auth
        # frame itself.
        if request.scope.get("type") == "websocket":
            return await call_next(request)
        supplied = request.headers.get("x-gps-token", "")
        if not auth.API_TOKEN or not secrets.compare_digest(supplied, auth.API_TOKEN):
            return unauthorized_response()
        return await call_next(request)


# Order matters: Starlette wraps later-added middleware around earlier ones,
# so the LAST `add_middleware` call becomes the OUTERMOST layer. We want
# CORSMiddleware on the outside so:
#   1. Browser preflight (OPTIONS) — which never carries X-GPS-Token by
#      spec — is answered by CORS directly and never hits the auth gate.
#   2. Auth-rejected 401s still get the Access-Control-Allow-Origin header
#      tacked on for the browser to surface a real error instead of a
#      generic CORS failure.
# Electron packaging is same-origin (file:// / app://.) and skips preflight
# entirely, so this ordering matters only for the Vite dev server.
app.add_middleware(_TokenAuthMiddleware)

app.add_middleware(
    CORSMiddleware,
    # Loopback-only API; legitimate callers are the Electron renderer
    # (app://. / file://) and the Vite dev server. A wildcard let any
    # browser tab on the user's machine issue requests through the
    # user-agent, which the bearer-token middleware can't catch on
    # pre-flight. Lock this down explicitly.
    allow_origins=[
        "app://.",
        "file://",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=False,
    allow_methods=["*"],
    # Only the headers the renderer actually sends. The bearer token rides
    # in X-GPS-Token; JSON bodies need Content-Type; X-Google-Key carries the
    # user's optional Google Places key for /api/geocode/search. A wildcard
    # would let any same-origin browser tab probe arbitrary headers, so we
    # list each explicitly. Without X-Google-Key here the keyed search fails
    # the cross-origin preflight in Vite dev (renderer:5173 → backend:8777).
    allow_headers=["X-GPS-Token", "Content-Type", "X-Google-Key"],
)

# Register routers
from api.device import router as device_router
from api.tunnel import router as wifi_tunnel_router
from api.location import router as location_router
from api.route import router as route_router
from api.geocode import router as geocode_router
from api.bookmarks import router as bookmarks_router
from api.websocket import router as ws_router
from api.system import router as system_router
from api.usage import router as usage_router

app.include_router(device_router)
app.include_router(wifi_tunnel_router)
app.include_router(location_router)
app.include_router(route_router)
app.include_router(geocode_router)
app.include_router(system_router)
app.include_router(usage_router)
app.include_router(bookmarks_router)
app.include_router(ws_router)


@app.get("/")
async def root():
    """Unauthenticated health check (auth-exempt — see auth._AUTH_EXEMPT_PATHS).

    Must never carry position data: any local account can read this
    endpoint without the X-GPS-Token, and the user's last simulated GPS
    coordinate would leak. The renderer fetches the initial position via
    the tokened GET /api/location/settings/initial-position instead.
    """
    return {
        "name": "GeoMirage",
        "version": __version__,
        "status": "running",
    }



if __name__ == "__main__":
    # Pass the app object, not the "main:app" import string: in the
    # PyInstaller build this file runs as the entry script and is not
    # importable as a module, so the string form fails at startup with
    # 'Could not import module "main"'. Reload is off, so nothing needs
    # the string form.
    #
    # Server is built by hand (rather than uvicorn.run) so the launcher
    # watch can reach ``should_exit`` — see core/parent_watch.py.
    server = uvicorn.Server(uvicorn.Config(
        app,
        host=API_HOST,
        port=API_PORT,
        reload=False,
        log_config=UVICORN_LOG_CONFIG,
    ))
    app.state.uvicorn_server = server
    server.run()
