"""Session-auth state — a leaf module with no upward imports.

Holds the process-wide API token and the auth-policy helpers shared by the
HTTP middleware (``main``), the WebSocket auth-frame check
(``api.websocket``), and the location/info gate (``api.location.info``).
Living here — below the routers and the app entrypoint — means those layers
no longer reach UP into ``main`` for auth state.

IMPORTANT — late binding: ``API_TOKEN`` is (re)assigned by ``main``'s lifespan
at startup (``auth.API_TOKEN = ...``). Every reader MUST access it as a module
attribute (``auth.API_TOKEN``), NEVER ``from auth import API_TOKEN`` — a value
import would permanently bind the empty-string default and silently disable
token auth.
"""

from __future__ import annotations

import os

# Session auth token. Generated once per backend process by main's lifespan
# and required on every /api/* request via the X-GPS-Token header; the
# WebSocket auth frame validates against the same value. Stays "" when running
# with GEOMIRAGE_DEV_NOAUTH=1 for local dev convenience.
API_TOKEN: str = ""


def _is_auth_disabled() -> bool:
    # GPSCONTROLLER_DEV_NOAUTH is the pre-rename name, still honoured.
    flag = os.environ.get("GEOMIRAGE_DEV_NOAUTH", os.environ.get("GPSCONTROLLER_DEV_NOAUTH"))
    return flag == "1"


# Only expose the interactive docs / OpenAPI schema in dev mode (when the
# session token is disabled). In packaged production runs the docs surface
# would let any local listener enumerate every API path, so it stays off once
# auth is on. Computed at import — the env var doesn't change mid-process.
_DOCS_ENABLED = _is_auth_disabled()


# Paths that don't require the token. Docs + health check stay open so the
# Electron shell can `GET /docs` to decide the backend is up.
_AUTH_EXEMPT_PATHS = frozenset({
    "/",
    "/docs",
    "/openapi.json",
    "/redoc",
    "/docs/oauth2-redirect",
})


# Browser origins the app itself runs under: the packaged Electron renderer
# (file:// / app://.) and the Vite dev server. Shared by CORSMiddleware and
# the dev-mode Origin checks on HTTP and WebSocket requests.
ALLOWED_ORIGINS: tuple[str, ...] = (
    "app://.",
    "file://",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
)

# Host header values the backend answers to. It only binds 127.0.0.1, so
# any other Host means DNS rebinding (a foreign site resolving its own name
# to loopback) and is rejected whether or not token auth is on.
ALLOWED_HOSTS: tuple[str, ...] = ("127.0.0.1", "localhost")


def is_origin_allowed(origin: str | None) -> bool:
    """True when *origin* is absent or one of the app's own origins.

    A missing Origin means a non-browser client (curl, the Electron main
    process); a web page cannot suppress the header, so it can't use that
    to slip through.
    """
    return origin is None or origin in ALLOWED_ORIGINS
