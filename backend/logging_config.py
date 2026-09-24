"""Logging setup for the FastAPI backend.

Hoisted out of ``main.py`` so the entrypoint stays focused on app
construction. Owns three concerns:

  - Console + rotating-file handlers with our preferred format
  - Color formatters for ``logging.LogRecord`` and uvicorn's two
    sub-loggers (default + access)
  - An access-log filter that drops OPTIONS preflights and a fixed
    list of noisy GET endpoints the frontend polls every few seconds

Returns the canonical ``geomirage`` logger so callers can use it
immediately. Idempotent within a single process — calling more than
once just re-attaches the same handlers, so unit tests that import
the module repeatedly stay safe.
"""

from __future__ import annotations

import logging
from copy import copy
from logging.handlers import RotatingFileHandler
from pathlib import Path

import uvicorn

from services.json_safe import chown_back, open_private_append


_LOG_PREFIX_FMT = "%(asctime)s %(levelname)s %(name)s:"
_LOG_FMT = f"{_LOG_PREFIX_FMT} %(message)s"
_UVICORN_ACCESS_FMT = (
    f'{_LOG_PREFIX_FMT} %(client_addr)s - "%(request_line)s" %(status_code)s'
)
_LOG_DATEFMT = "%Y-%m-%d %H:%M:%S"
_FILE_MAX_BYTES = 2 * 1024 * 1024  # 2 MB
_FILE_BACKUP_COUNT = 3

# Routine polling endpoints (frontend heartbeats): /api/device/list every
# ~30s, cooldown/last-device-position checks on each WS reconnect, etc.
# These flood the log without telling us anything when they 200. Non-2xx
# responses on these paths still surface elsewhere (the caller handles
# the error) so dropping them here keeps the dev log readable.
_ACCESS_NOISE_PATHS = (
    '"GET /api/device/list ',
    '"GET /api/location/cooldown/status ',
    '"GET /api/location/last-device-position ',
    '"GET /api/location/settings/initial-position ',
    '"GET /api/bookmarks ',
    '"GET /api/bookmarks/places ',
    '"GET /api/bookmarks/tags ',
    '"GET /api/route/saved ',
    '"GET /api/location/status ',
)


class _ColorFormatter(logging.Formatter):
    """Adds ANSI color to the level name for terminal output."""

    _COLORS = {
        logging.DEBUG: "\033[36m",     # cyan
        logging.INFO: "\033[32m",      # green
        logging.WARNING: "\033[33m",   # yellow
        logging.ERROR: "\033[31m",     # red
        logging.CRITICAL: "\033[1;31m",  # bold red
    }
    _RESET = "\033[0m"

    def format(self, record: logging.LogRecord) -> str:
        color = self._COLORS.get(record.levelno, "")
        record.levelname = f"{color}{record.levelname}{self._RESET}"
        return super().format(record)


class _UvicornDefaultFormatter(uvicorn.logging.DefaultFormatter):
    """Like uvicorn's DefaultFormatter but colors `levelname` directly
    (no padding, no trailing colon) so format strings can use
    `%(levelname)s` instead of the padded `%(levelprefix)s`."""

    def formatMessage(self, record: logging.LogRecord) -> str:
        recordcopy = copy(record)
        if self.use_colors:
            recordcopy.levelname = self.color_level_name(
                recordcopy.levelname, recordcopy.levelno
            )
            if "color_message" in recordcopy.__dict__:
                recordcopy.msg = recordcopy.__dict__["color_message"]
                recordcopy.message = recordcopy.getMessage()
        return logging.Formatter.formatMessage(self, recordcopy)


class _UvicornAccessFormatter(uvicorn.logging.AccessFormatter):
    """Like uvicorn's AccessFormatter but colors `levelname` directly
    (no padding) — keeps the parent's client_addr/request_line/status_code
    interpolation."""

    def formatMessage(self, record: logging.LogRecord) -> str:
        recordcopy = copy(record)
        if self.use_colors:
            recordcopy.levelname = self.color_level_name(
                recordcopy.levelname, recordcopy.levelno
            )
        return super().formatMessage(recordcopy)


class _PrivateRotatingFileHandler(RotatingFileHandler):
    """RotatingFileHandler whose file is 0600, refuses to follow a
    symlink, and belongs to the sudo invoker when the backend runs as
    root. Rollover reopens through ``_open`` too, so a new
    ``backend.log`` after rotation gets the same treatment."""

    def _open(self):
        return open_private_append(Path(self.baseFilename))


class _AccessNoiseFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        if '"OPTIONS ' in msg:
            return False
        return not any(p in msg for p in _ACCESS_NOISE_PATHS)


# `"()"` uses absolute module references so they survive main.py being
# launched as `__main__` (a bare `__main__.<class>` won't resolve here).
UVICORN_LOG_CONFIG: dict = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "default": {
            "()": f"{__name__}._UvicornDefaultFormatter",
            "fmt": _LOG_FMT,
            "datefmt": _LOG_DATEFMT,
            "use_colors": True,
        },
        "access": {
            "()": f"{__name__}._UvicornAccessFormatter",
            "fmt": _UVICORN_ACCESS_FMT,
            "datefmt": _LOG_DATEFMT,
            "use_colors": True,
        },
    },
    "handlers": {
        "default": {
            "formatter": "default",
            "class": "logging.StreamHandler",
            "stream": "ext://sys.stderr",
        },
        "access": {
            "formatter": "access",
            "class": "logging.StreamHandler",
            "stream": "ext://sys.stdout",
        },
    },
    "loggers": {
        "uvicorn": {"handlers": ["default"], "level": "INFO", "propagate": False},
        "uvicorn.error": {"level": "INFO"},
        "uvicorn.access": {"handlers": ["access"], "level": "INFO", "propagate": False},
    },
}


_QUIET_HTTP_LOGGERS = ("httpx", "httpcore")


def _restrict_rotated_logs(log_dir: Path) -> None:
    """Tighten ``backend.log.N`` left at 0644 by older versions to 0600
    and, under sudo, hand them back to the invoking user."""
    for path in log_dir.glob("backend.log.*"):
        try:
            if not path.is_symlink():
                path.chmod(0o600)
                chown_back(path)
        except OSError:
            pass


def setup_logging(log_dir: Path) -> logging.Logger:
    """Configure root logging + uvicorn loggers and return the project logger.

    Creates ``log_dir`` if missing. Rotating-file handler caps at
    ``_FILE_MAX_BYTES`` with ``_FILE_BACKUP_COUNT`` backups. The console
    handler always attaches; the file handler attaches best-effort
    (logging stays usable on read-only filesystems / sandboxed runs).
    """
    console_handler = logging.StreamHandler()
    console_handler.setFormatter(_ColorFormatter(_LOG_FMT, datefmt=_LOG_DATEFMT))

    file_error: Exception | None = None
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
        # Under sudo, keep logs/ owned by the user so a later
        # unprivileged run can still create and rotate backend.log.
        chown_back(log_dir)
        file_handler = _PrivateRotatingFileHandler(
            log_dir / "backend.log",
            maxBytes=_FILE_MAX_BYTES,
            backupCount=_FILE_BACKUP_COUNT,
            encoding="utf-8",
        )
        file_handler.setFormatter(logging.Formatter(_LOG_FMT, datefmt=_LOG_DATEFMT))
        file_handler.setLevel(logging.INFO)
        handlers: list[logging.Handler] = [console_handler, file_handler]
    except Exception as exc:
        # e.g. backend.log is a symlink (O_NOFOLLOW → ELOOP) or not writable.
        file_error = exc
        handlers = [console_handler]

    logging.basicConfig(level=logging.INFO, handlers=handlers, force=True)
    logging.getLogger("uvicorn.access").addFilter(_AccessNoiseFilter())
    # httpx logs every request URL at INFO; reverse-geocode and routing
    # URLs carry the exact simulated coordinates, which must not end up
    # in backend.log. Failures still surface at WARNING and above.
    for name in _QUIET_HTTP_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)
    if file_error is None:
        _restrict_rotated_logs(log_dir)

    project_logger = logging.getLogger("geomirage")
    if file_error is not None:
        project_logger.warning(
            "File logging disabled, cannot open %s: %s",
            log_dir / "backend.log", file_error,
        )
    return project_logger
