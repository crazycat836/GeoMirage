"""Safe JSON persistence helpers for ``~/.geomirage`` data files.

Invariants:

* **Corrupt JSON is quarantined, not discarded.** A failed parse moves
  the file to ``<name>.bak-<UTC timestamp>`` and returns ``None`` so
  the caller can re-initialise without overwriting the original bytes
  on the next save.
* **Every write is atomic.** Each call serialises to a per-call unique
  ``NamedTemporaryFile`` sibling, then ``Path.replace``s it over the
  target — concurrent writers get distinct tmp names, so the last
  ``replace`` wins rather than the last mid-write wins.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, TextIO

logger = logging.getLogger(__name__)

# Keep at most this many `.bak-*` siblings per canonical file. Older
# backups are deleted on each quarantine event so repeated corruption
# (or a schema change across versions) can't fill the disk.
_BACKUP_KEEP = 5


def _sudo_target() -> tuple[int, int] | None:
    """Return (uid, gid) to chown back to when running under sudo.

    None when not effectively root, or SUDO_UID/SUDO_GID not set (plain
    root login), so non-sudo deployments are a no-op.
    """
    if os.geteuid() != 0:
        return None
    try:
        return int(os.environ["SUDO_UID"]), int(os.environ["SUDO_GID"])
    except (KeyError, ValueError):
        return None


def chown_back(path: Path) -> None:
    """If running under sudo, chown *path* back to the invoking user.

    Otherwise `sudo python3 start.py` writes runtime files as root into
    the invoker's home directory, and the invoker later can't read them
    without re-escalating. Public so non-JSON writers (e.g. the session
    token file in ``main``) can reuse the same sudo-drop behaviour.
    """
    target = _sudo_target()
    if target is None:
        return
    try:
        # Never follow a symlink: a same-user process could point the
        # entry at a root-owned system file and have root hand it over.
        os.chown(path, *target, follow_symlinks=False)
    except OSError as exc:
        logger.warning("chown %s -> %s failed: %s", path.name, target, exc)


def open_private_append(path: Path) -> TextIO:
    """Open *path* for text append as a private (0600) file.

    For log-style writers (``backend.log``, usage JSONL) that can't use
    the temp-file + replace pattern. ``O_NOFOLLOW`` makes the open fail
    (``OSError``) when *path* is a symlink, so a root backend never
    appends to whatever the link points at. A pre-existing file is
    tightened to 0600 and, under sudo, handed back to the invoking user.
    """
    flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags, 0o600)
    try:
        if hasattr(os, "fchmod"):
            os.fchmod(fd, 0o600)
        target = _sudo_target()
        if target is not None:
            os.fchown(fd, *target)
    except OSError as exc:
        # Permission tightening is best-effort; the append itself works.
        logger.warning("cannot restrict %s: %s", path.name, exc)
    try:
        return os.fdopen(fd, "a", encoding="utf-8")
    except BaseException:
        os.close(fd)
        raise


def safe_load_json(path: Path, *, expect: type | None = None) -> Any | None:
    """Load JSON from *path*.

    Returns the parsed payload, or ``None`` if the file is missing,
    unreadable, or contains invalid JSON. Only ``json.JSONDecodeError``
    (or, when *expect* is given, a top-level value that isn't an
    instance of it, e.g. ``null``) triggers the
    ``<name>.bak-<timestamp>`` quarantine; filesystem-level read
    failures (missing file, permission denied, disk error) pass through
    as ``None`` without moving anything aside.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except OSError as exc:
        logger.error("cannot read %s: %s: %s", path.name, type(exc).__name__, exc)
        return None
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        _backup_corrupt(path, reason=f"{type(exc).__name__}: {exc}")
        return None
    if expect is not None and not isinstance(data, expect):
        _backup_corrupt(
            path, reason=f"expected {expect.__name__}, got {type(data).__name__}",
        )
        return None
    return data


def safe_write_json(path: Path, payload: Any, *, indent: int = 2) -> bool:
    """Write *payload* to *path* atomically.

    Serialises to a per-call unique ``NamedTemporaryFile`` sibling and
    ``Path.replace``s it over the target. Returns ``True`` on success.
    """
    tmp_path: Path | None = None
    try:
        parent_existed = path.parent.exists()
        path.parent.mkdir(parents=True, exist_ok=True)
        if not parent_existed:
            chown_back(path.parent)
        body = json.dumps(payload, ensure_ascii=False, indent=indent)
        fd = tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            prefix=path.name + ".",
            suffix=".tmp",
            dir=path.parent,
            delete=False,
        )
        tmp_path = Path(fd.name)
        try:
            fd.write(body)
            fd.flush()
            os.fsync(fd.fileno())
        finally:
            fd.close()
        tmp_path.replace(path)
        chown_back(path)
        return True
    except Exception as exc:
        logger.error("failed to write %s: %s", path.name, exc)
        if tmp_path is not None:
            try:
                tmp_path.unlink(missing_ok=True)
            except Exception:
                pass
        return False


def _backup_corrupt(path: Path, *, reason: str) -> Path | None:
    """Move a corrupt file aside so a future write doesn't clobber it."""
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = path.with_suffix(f"{path.suffix}.bak-{timestamp}")
    try:
        path.replace(backup)
        logger.warning(
            "quarantined corrupt JSON %s -> %s (%s)",
            path.name, backup.name, reason,
        )
    except Exception as exc:
        logger.error("failed to quarantine corrupt %s (%s): %s", path.name, reason, exc)
        return None

    _prune_backups(path)
    return backup


def _prune_backups(path: Path) -> None:
    """Keep at most ``_BACKUP_KEEP`` ``.bak-*`` siblings of *path*."""
    try:
        siblings = sorted(
            path.parent.glob(f"{path.name}.bak-*"),
            key=lambda p: p.name,
            reverse=True,
        )
    except OSError:
        return
    for stale in siblings[_BACKUP_KEEP:]:
        try:
            stale.unlink()
        except OSError:
            pass
