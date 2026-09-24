"""Isolate the test run from the developer's real ``~/.geomirage``.

``config.DATA_DIR`` and ``main`` resolve the data dir from
``Path.home()`` at import time, and importing ``main`` builds the
bookmark / route stores (which can rewrite or quarantine files), opens
backend.log and migrates legacy data dirs. Point HOME at a throwaway
directory here, before pytest imports any test module, so every run
starts from an empty home regardless of what the machine has.
"""

from __future__ import annotations

import atexit
import os
import shutil
import tempfile

_TEST_HOME = tempfile.mkdtemp(prefix="geomirage-test-home-")
os.environ["HOME"] = _TEST_HOME
atexit.register(shutil.rmtree, _TEST_HOME, ignore_errors=True)

# Check every WS event the backend emits during tests against its model in
# models/ws_events.py (see check_ws_event). Must be set before any backend
# module is imported, since the flag is read at import time.
os.environ["GEOMIRAGE_WS_VALIDATE"] = "1"

import sys  # noqa: E402
from pathlib import Path  # noqa: E402

import pytest  # noqa: E402

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))


@pytest.fixture(autouse=True)
def _ws_payloads_match_models():
    """Fail any test during which the backend emitted a WS event whose
    payload doesn't match its ws_events model."""
    from models import ws_events

    ws_events.VIOLATIONS.clear()
    yield
    found = list(ws_events.VIOLATIONS)
    ws_events.VIOLATIONS.clear()
    if found:
        pytest.fail("WS payload/model mismatch:\n" + "\n".join(found), pytrace=False)

