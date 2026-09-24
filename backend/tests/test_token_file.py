"""Tests for the session-token file write path in ``main``.

A previous ``sudo python3 start.py`` run could leave
``~/.geomirage/token`` owned by root (mode 0600), so the NEXT
unprivileged run gets EACCES when truncating it in place and the
renderer is locked out until the file is deleted by hand.
``_write_token_file`` must therefore:

* write a fresh 0600 temp file and rename it over the entry (the
  directory IS owned by the user, so the rename succeeds where
  open(O_TRUNC) on the stale file cannot),
* never follow a symlink planted at the token path (the backend may be
  running as root), and
* hand ownership back to the invoking user via ``chown_back`` after a
  successful write, so a sudo run can't poison the next non-sudo run.
"""

from __future__ import annotations

import os
import stat
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

# Make `backend/` importable when pytest runs from the repo root.
_BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

import main  # noqa: E402


def test_token_write_plain(tmp_path: Path, monkeypatch) -> None:
    """Happy path: fresh file, 0600, exact token bytes."""
    token_file = tmp_path / "token"
    monkeypatch.setattr(main, "TOKEN_FILE", token_file)

    main._write_token_file("sekret-token")

    assert token_file.read_text(encoding="utf-8") == "sekret-token"
    assert stat.S_IMODE(token_file.stat().st_mode) == 0o600


@pytest.mark.skipif(os.geteuid() == 0, reason="chmod 0 does not block root")
def test_token_write_recovers_from_unwritable_file(tmp_path: Path, monkeypatch) -> None:
    """A stale file we can't open is replaced, not truncated.

    Simulates the root-owned leftover with chmod 0o000: opening it with
    O_WRONLY raises PermissionError exactly like a root-owned 0600 file
    would, while the (user-owned) directory still allows the rename.
    """
    token_file = tmp_path / "token"
    monkeypatch.setattr(main, "TOKEN_FILE", token_file)
    token_file.write_text("stale-root-token", encoding="utf-8")
    token_file.chmod(0o000)

    main._write_token_file("fresh-token")

    assert token_file.read_text(encoding="utf-8") == "fresh-token"
    assert stat.S_IMODE(token_file.stat().st_mode) == 0o600


def test_token_write_propagates_persistent_failure(tmp_path: Path, monkeypatch) -> None:
    """If the rewrite ALSO fails, the error reaches the caller (the
    lifespan logs it) instead of being swallowed."""
    token_file = tmp_path / "token"
    monkeypatch.setattr(main, "TOKEN_FILE", token_file)

    monkeypatch.setattr(
        os, "open",
        lambda *a, **kw: (_ for _ in ()).throw(PermissionError(13, "denied")),
    )
    with pytest.raises(PermissionError):
        main._write_token_file("fresh-token")


def test_token_write_calls_chown_back(tmp_path: Path, monkeypatch) -> None:
    """Successful write hands ownership back to the sudo invoker."""
    token_file = tmp_path / "token"
    monkeypatch.setattr(main, "TOKEN_FILE", token_file)

    with patch.object(main, "chown_back") as mock_chown_back:
        main._write_token_file("sekret-token")

    mock_chown_back.assert_called_once_with(token_file)


def test_token_write_does_not_follow_symlink(tmp_path: Path, monkeypatch) -> None:
    """A symlink at the token path is replaced; its target is untouched."""
    victim = tmp_path / "victim"
    victim.write_text("system file", encoding="utf-8")
    token_file = tmp_path / "token"
    token_file.symlink_to(victim)
    monkeypatch.setattr(main, "TOKEN_FILE", token_file)

    main._write_token_file("fresh-token")

    assert victim.read_text(encoding="utf-8") == "system file"
    assert not token_file.is_symlink()
    assert token_file.read_text(encoding="utf-8") == "fresh-token"
    assert stat.S_IMODE(token_file.stat().st_mode) == 0o600


def test_token_write_leaves_no_temp_file(tmp_path: Path, monkeypatch) -> None:
    token_file = tmp_path / "token"
    monkeypatch.setattr(main, "TOKEN_FILE", token_file)

    main._write_token_file("sekret-token")

    assert sorted(p.name for p in tmp_path.iterdir()) == ["token"]


# ── Data dir safety check for root runs ──


def _as_root(monkeypatch, sudo_uid: int | None) -> None:
    monkeypatch.setattr(os, "geteuid", lambda: 0)
    if sudo_uid is None:
        monkeypatch.delenv("SUDO_UID", raising=False)
    else:
        monkeypatch.setenv("SUDO_UID", str(sudo_uid))


def test_data_dir_symlink_is_refused_as_root(tmp_path: Path, monkeypatch) -> None:
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / ".geomirage"
    link.symlink_to(real)
    _as_root(monkeypatch, os.getuid())

    assert main._unsafe_data_dir_reason(link) == "is a symlink"


def test_data_dir_owned_by_other_user_is_refused_as_root(tmp_path: Path, monkeypatch) -> None:
    _as_root(monkeypatch, os.getuid() + 1)

    assert "owned by uid" in main._unsafe_data_dir_reason(tmp_path)


def test_data_dir_owned_by_invoker_is_accepted_as_root(tmp_path: Path, monkeypatch) -> None:
    _as_root(monkeypatch, os.getuid())

    assert main._unsafe_data_dir_reason(tmp_path) is None
    assert main._unsafe_data_dir_reason(tmp_path / "missing") is None


def test_data_dir_check_is_skipped_when_not_root(tmp_path: Path, monkeypatch) -> None:
    link = tmp_path / ".geomirage"
    link.symlink_to(tmp_path)
    monkeypatch.setattr(os, "geteuid", lambda: 501)

    assert main._unsafe_data_dir_reason(link) is None
