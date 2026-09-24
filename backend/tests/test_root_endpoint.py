"""The unauthenticated `/` health check must never leak position data.

`/` is auth-exempt (auth._AUTH_EXEMPT_PATHS) so the Electron shell can
probe the backend before it has the token — which means ANY local
account can read it without X-GPS-Token. It used to embed
``app_state.get_initial_position()`` (the user's last simulated GPS
coordinate); these tests pin the hardened contract: name/version/status
only. The renderer fetches the initial position via the tokened
``GET /api/location/settings/initial-position`` instead.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Make `backend/` importable when pytest runs from the repo root.
_BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from starlette.testclient import TestClient  # noqa: E402

import main  # noqa: E402

_POSITION_FIELDS = ("initial_position", "position", "lat", "lng", "latitude", "longitude")


def test_root_is_reachable_without_token():
    """Health-check contract: 200 without X-GPS-Token (auth-exempt)."""
    client = TestClient(main.app, base_url="http://127.0.0.1:8777")
    resp = client.get("/")
    assert resp.status_code == 200


def test_root_carries_no_position_fields():
    """The unauthenticated payload must be name/version/status only."""
    client = TestClient(main.app, base_url="http://127.0.0.1:8777")
    payload = client.get("/").json()

    # Envelope-wrapped by EnvelopeJSONResponse.
    data = payload["data"]
    assert set(data.keys()) == {"name", "version", "status"}
    for field in _POSITION_FIELDS:
        assert field not in data

    # Belt and braces: the field name must not appear anywhere in the raw body.
    body = client.get("/").text
    assert "initial_position" not in body
