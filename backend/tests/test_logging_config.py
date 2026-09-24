"""Tests for the backend.log file handler in ``logging_config``.

The backend may run as root while writing into the user's
``~/.geomirage/logs``: the log file must be 0600, must never be opened
through a symlink, and a failure to open it must be reported rather
than silently dropping to console-only logging.
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

import logging_config  # noqa: E402


@pytest.fixture(autouse=True)
def _restore_root_logging():
    root = logging.getLogger()
    saved_handlers, saved_level = root.handlers[:], root.level
    yield
    for h in root.handlers:
        if h not in saved_handlers:
            h.close()
    root.handlers[:] = saved_handlers
    root.setLevel(saved_level)


def _file_handlers():
    return [
        h for h in logging.getLogger().handlers
        if isinstance(h, logging.FileHandler)
    ]


def test_log_file_is_private(tmp_path: Path) -> None:
    logging_config.setup_logging(tmp_path / "logs")
    logging.getLogger("geomirage").info("hello")

    log_file = tmp_path / "logs" / "backend.log"
    assert (log_file.stat().st_mode & 0o777) == 0o600
    assert "hello" in log_file.read_text(encoding="utf-8")


def test_rotated_log_file_is_private(tmp_path: Path) -> None:
    logging_config.setup_logging(tmp_path / "logs")
    (handler,) = _file_handlers()
    handler.doRollover()

    for name in ("backend.log", "backend.log.1"):
        assert ((tmp_path / "logs" / name).stat().st_mode & 0o777) == 0o600


def test_symlinked_log_file_is_not_followed(tmp_path: Path, caplog) -> None:
    victim = tmp_path / "victim"
    victim.write_text("keep", encoding="utf-8")
    log_dir = tmp_path / "logs"
    log_dir.mkdir()
    (log_dir / "backend.log").symlink_to(victim)

    logging_config.setup_logging(log_dir)
    logging.getLogger("geomirage").warning("should not land in victim")

    assert victim.read_text(encoding="utf-8") == "keep"
    assert _file_handlers() == []


def test_httpx_request_urls_are_not_logged(tmp_path: Path) -> None:
    """httpx logs every request URL at INFO, including reverse-geocode
    queries with the exact lat/lon."""
    logging_config.setup_logging(tmp_path / "logs")
    logging.getLogger("httpx").info(
        "HTTP Request: GET https://nominatim.openstreetmap.org/reverse?lat=25.0323&lon=121.5222",
    )
    logging.getLogger("httpcore.http11").info("send_request_headers lat=25.0323")

    text = (tmp_path / "logs" / "backend.log").read_text(encoding="utf-8")
    assert "lat=" not in text


def test_existing_rotated_logs_are_made_private(tmp_path: Path) -> None:
    log_dir = tmp_path / "logs"
    log_dir.mkdir()
    old = log_dir / "backend.log.1"
    old.write_text("old run\n", encoding="utf-8")
    old.chmod(0o644)

    logging_config.setup_logging(log_dir)

    assert (old.stat().st_mode & 0o777) == 0o600
