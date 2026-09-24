"""The test run must never touch the developer's real ~/.geomirage.

``import main`` builds AppState (bookmarks / routes stores, which may
migrate or quarantine files), sets up backend.log, and migrates legacy
data dirs, all under ``Path.home()``. ``conftest.py`` points HOME at a
throwaway directory before any backend module is imported.
"""

from __future__ import annotations

import os
import pwd
import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

import config  # noqa: E402
import main  # noqa: E402


def test_data_dir_is_not_the_real_home() -> None:
    real_home = Path(pwd.getpwuid(os.getuid()).pw_dir).resolve()
    for path in (config.DATA_DIR, main._new_data_dir):
        assert not path.resolve().is_relative_to(real_home), path
