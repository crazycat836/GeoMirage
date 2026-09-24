"""Single source of truth for the app version.

The frontend `package.json` is the canonical release artifact (per
CLAUDE.md release flow). Backend reads it at import time so the FastAPI
app, `/` endpoint, the start.py banner, and log lines all agree.

In a PyInstaller bundle the `frontend/` tree isn't present — the
packager copies the backend binary into `resources/backend/` of the
Electron distribution. There the version comes from the
`GEOMIRAGE_VERSION` environment variable, which the Electron main
process sets when it spawns the backend. Running the bundled binary by
hand without that variable reports "0.0.0".
"""
from __future__ import annotations

import json
import os
from pathlib import Path


def _read_frontend_version() -> str | None:
    """Walk up from this file to find `frontend/package.json`. Returns
    the `version` string or None if the file can't be read."""
    here = Path(__file__).resolve()
    for ancestor in (here.parent, *here.parents):
        candidate = ancestor / "frontend" / "package.json"
        if candidate.is_file():
            try:
                payload = json.loads(candidate.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                return None
            version = payload.get("version")
            return str(version) if isinstance(version, str) else None
    return None


def _resolve_version() -> str:
    # Dev / sidecar run: read package.json.
    v = _read_frontend_version()
    if v:
        return v
    # Packaged build: Electron injects GEOMIRAGE_VERSION. "0.0.0" keeps
    # logs/endpoints working when the binary is started without it.
    return os.environ.get("GEOMIRAGE_VERSION") or "0.0.0"


__version__ = _resolve_version()
