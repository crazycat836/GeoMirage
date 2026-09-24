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
