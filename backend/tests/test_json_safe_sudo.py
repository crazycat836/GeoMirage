"""Tests for the sudo-drop (chown_back) behavior in json_safe.

When GeoMirage runs via ``sudo python3 start.py``, ``Path.home()``
still resolves to the invoking user's home (macOS sudo preserves
``$HOME``), so runtime JSON files end up in the user's home directory
but owned by root. ``safe_write_json`` calls ``chown_back`` after every
atomic replace so the invoker can read their own data without
re-escalating.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from unittest.mock import patch

# Ensure backend/ is importable (same pattern as test_bookmarks_migration.py).
_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from services import json_safe  # noqa: E402


def test_chown_called_under_sudo(tmp_path: Path, monkeypatch) -> None:
    """When effectively root + SUDO_UID/GID set, chown both parent (if new) and file."""
    monkeypatch.setattr(os, "geteuid", lambda: 0)
    monkeypatch.setenv("SUDO_UID", "501")
    monkeypatch.setenv("SUDO_GID", "20")

    target = tmp_path / "new_dir" / "data.json"

    with patch.object(os, "chown") as mock_chown:
        ok = json_safe.safe_write_json(target, {"hello": "world"})

    assert ok
    assert target.exists()
    # Two chown calls: parent (newly created) + file.
    assert mock_chown.call_count == 2
    parent_call, file_call = mock_chown.call_args_list
    assert parent_call.args == (target.parent, 501, 20)
    assert file_call.args == (target, 501, 20)


def test_chown_skipped_when_parent_preexists(tmp_path: Path, monkeypatch) -> None:
    """If the parent dir already exists, do not chown it — only the file."""
    monkeypatch.setattr(os, "geteuid", lambda: 0)
    monkeypatch.setenv("SUDO_UID", "501")
    monkeypatch.setenv("SUDO_GID", "20")

    target = tmp_path / "data.json"  # tmp_path already exists

    with patch.object(os, "chown") as mock_chown:
        ok = json_safe.safe_write_json(target, {"hello": "world"})

    assert ok
    assert mock_chown.call_count == 1
    assert mock_chown.call_args.args == (target, 501, 20)


def test_chown_skipped_when_not_root(tmp_path: Path, monkeypatch) -> None:
    """Normal non-sudo run (effective uid != 0) must not touch chown."""
    monkeypatch.setattr(os, "geteuid", lambda: 1000)
    # Clear any leaked sudo vars so the helper really has to rely on geteuid.
    monkeypatch.delenv("SUDO_UID", raising=False)
    monkeypatch.delenv("SUDO_GID", raising=False)

    target = tmp_path / "data.json"

    with patch.object(os, "chown") as mock_chown:
        ok = json_safe.safe_write_json(target, {"hello": "world"})

    assert ok
    assert mock_chown.call_count == 0


def test_chown_skipped_when_sudo_vars_missing(tmp_path: Path, monkeypatch) -> None:
    """Effective root without SUDO_UID/GID (e.g., a direct root login) — no chown."""
    monkeypatch.setattr(os, "geteuid", lambda: 0)
    monkeypatch.delenv("SUDO_UID", raising=False)
    monkeypatch.delenv("SUDO_GID", raising=False)

    target = tmp_path / "data.json"

    with patch.object(os, "chown") as mock_chown:
        ok = json_safe.safe_write_json(target, {"hello": "world"})

    assert ok
    assert mock_chown.call_count == 0


def test_chown_failure_does_not_break_write(tmp_path: Path, monkeypatch) -> None:
    """A chown EPERM (or similar) is warned-and-ignored; the write still succeeds."""
    monkeypatch.setattr(os, "geteuid", lambda: 0)
    monkeypatch.setenv("SUDO_UID", "501")
    monkeypatch.setenv("SUDO_GID", "20")

    target = tmp_path / "data.json"

    with patch.object(os, "chown", side_effect=PermissionError("EPERM")):
        ok = json_safe.safe_write_json(target, {"hello": "world"})

    assert ok
    assert target.exists()
    assert target.read_text(encoding="utf-8").strip().startswith("{")


# ── open_private_append (backend.log / usage JSONL) ──


def test_chown_back_does_not_follow_symlinks(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(os, "geteuid", lambda: 0)
    monkeypatch.setenv("SUDO_UID", "501")
    monkeypatch.setenv("SUDO_GID", "20")
    link = tmp_path / "link"
    link.symlink_to(tmp_path / "elsewhere")

    with patch.object(os, "chown") as mock_chown:
        json_safe.chown_back(link)

    assert mock_chown.call_args.kwargs == {"follow_symlinks": False}


def test_open_private_append_creates_0600(tmp_path: Path) -> None:
    target = tmp_path / "backend.log"
    with json_safe.open_private_append(target) as fh:
        fh.write("line\n")
    assert target.read_text(encoding="utf-8") == "line\n"
    assert (target.stat().st_mode & 0o777) == 0o600


def test_open_private_append_tightens_existing_file(tmp_path: Path) -> None:
    target = tmp_path / "backend.log"
    target.write_text("old\n", encoding="utf-8")
    target.chmod(0o644)
    with json_safe.open_private_append(target) as fh:
        fh.write("new\n")
    assert target.read_text(encoding="utf-8") == "old\nnew\n"
    assert (target.stat().st_mode & 0o777) == 0o600


def test_open_private_append_refuses_symlink(tmp_path: Path) -> None:
    import pytest

    victim = tmp_path / "victim"
    victim.write_text("keep", encoding="utf-8")
    link = tmp_path / "backend.log"
    link.symlink_to(victim)

    with pytest.raises(OSError):
        json_safe.open_private_append(link)
    assert victim.read_text(encoding="utf-8") == "keep"


def test_open_private_append_chowns_fd_under_sudo(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(os, "geteuid", lambda: 0)
    monkeypatch.setenv("SUDO_UID", "501")
    monkeypatch.setenv("SUDO_GID", "20")

    with patch.object(os, "fchown") as mock_fchown:
        json_safe.open_private_append(tmp_path / "usage.jsonl").close()

    assert mock_fchown.call_args.args[1:] == (501, 20)
