"""Tests for the repo-root ``start.py`` launcher.

The launcher is plain stdlib glue around subprocess calls; these tests
mock ``subprocess`` / ``os`` so no real pip, npm or Vite is run.
"""

from __future__ import annotations

import os
import sys
import types
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

import start  # noqa: E402


class _FakeProc:
    returncode = None

    def poll(self):
        return None


# ── #56: Vite runs as the sudo-invoking user ────────────────────────────


def _fake_pw(uid=501, name="gary", home="/Users/gary"):
    return types.SimpleNamespace(pw_uid=uid, pw_name=name, pw_dir=home)


@pytest.mark.skipif(os.name == "nt", reason="POSIX privilege drop")
def test_frontend_runs_as_sudo_user_when_root(monkeypatch):
    import pwd

    monkeypatch.setattr(start, "_is_effective_root", lambda: True)
    monkeypatch.setenv("SUDO_UID", "501")
    monkeypatch.setenv("SUDO_GID", "20")
    monkeypatch.setenv("HOME", "/var/root")
    monkeypatch.setattr(pwd, "getpwuid", lambda uid: _fake_pw(uid))
    monkeypatch.setattr(os, "getgrouplist", lambda name, gid: [gid, 12, 61])
    monkeypatch.setattr(start, "is_port_open", lambda port: False)
    monkeypatch.setattr(start, "wait_for_port", lambda *a, **k: True)
    monkeypatch.setattr(start, "procs", [])
    monkeypatch.setattr(start, "_remove_root_owned_vite_cache", lambda: None)

    calls = []

    def fake_popen(argv, **kwargs):
        calls.append((argv, kwargs))
        return _FakeProc()

    monkeypatch.setattr(start.subprocess, "Popen", fake_popen)

    assert start.start_frontend() is True
    (_, kwargs), = calls
    assert kwargs["user"] == 501
    assert kwargs["group"] == 20
    assert kwargs["extra_groups"] == [20, 12, 61]
    assert kwargs["env"]["HOME"] == "/Users/gary"
    assert kwargs["env"]["USER"] == "gary"


def test_frontend_keeps_identity_when_not_root(monkeypatch):
    monkeypatch.setattr(start, "_is_effective_root", lambda: False)
    monkeypatch.setenv("SUDO_UID", "501")
    monkeypatch.setenv("SUDO_GID", "20")
    monkeypatch.setattr(start, "is_port_open", lambda port: False)
    monkeypatch.setattr(start, "wait_for_port", lambda *a, **k: True)
    monkeypatch.setattr(start, "procs", [])

    calls = []
    monkeypatch.setattr(
        start.subprocess, "Popen",
        lambda argv, **kw: calls.append(kw) or _FakeProc(),
    )

    start.start_frontend()
    (kwargs,) = calls
    assert "user" not in kwargs and "group" not in kwargs


def test_drop_to_sudo_user_needs_sudo_ids(monkeypatch):
    monkeypatch.setattr(start, "_is_effective_root", lambda: True)
    env = {"HOME": "/var/root"}
    assert start._drop_to_sudo_user(env) == {}
    assert env == {"HOME": "/var/root"}


def test_root_owned_vite_cache_is_removed(monkeypatch, tmp_path):
    (tmp_path / "node_modules" / ".vite").mkdir(parents=True)
    monkeypatch.setattr(start, "FRONTEND", str(tmp_path))
    real_stat = os.stat
    monkeypatch.setattr(
        start.os, "stat",
        lambda p, *a, **k: types.SimpleNamespace(st_uid=0)
        if str(p).endswith(".vite") else real_stat(p, *a, **k),
    )
    removed = []
    monkeypatch.setattr(start.shutil, "rmtree", lambda p, **k: removed.append(p))
    start._remove_root_owned_vite_cache()
    assert removed == [str(tmp_path / "node_modules" / ".vite")]


# ── #97: install steps check pip / npm exit codes ───────────────────────


def _completed(returncode=0, stdout="", stderr=""):
    return types.SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)


def test_backend_dry_run_failure_is_not_ready(monkeypatch, capsys):
    monkeypatch.setattr(start, "_is_effective_root", lambda: False)
    monkeypatch.setattr(
        start.subprocess, "run",
        lambda argv, **kw: _completed(1, "", "error: externally-managed-environment"),
    )
    assert start.install_backend() is False
    out = capsys.readouterr().out
    assert "已就緒" not in out
    assert "externally-managed-environment" in out


def test_backend_install_failure_is_not_done(monkeypatch, capsys):
    monkeypatch.setattr(start, "_is_effective_root", lambda: False)
    results = iter([_completed(0, "Would install fastapi-1.0"), _completed(1)])
    monkeypatch.setattr(start.subprocess, "run", lambda argv, **kw: next(results))
    assert start.install_backend() is False
    assert "完成" not in capsys.readouterr().out


def test_frontend_install_failure_is_not_done(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(start, "FRONTEND", str(tmp_path))  # no node_modules
    monkeypatch.setattr(start, "_is_effective_root", lambda: False)
    monkeypatch.setattr(start.subprocess, "run", lambda argv, **kw: _completed(1))
    assert start.install_frontend() is False
    assert "完成" not in capsys.readouterr().out


def test_wait_for_port_fails_fast_when_process_exits(monkeypatch):
    proc = types.SimpleNamespace(poll=lambda: 1, returncode=1)
    monkeypatch.setattr(start, "is_port_open", lambda port: False)
    monkeypatch.setattr(start.time, "sleep", lambda s: pytest.fail("should not wait"))
    assert start.wait_for_port(1, "後端", proc=proc) is False


# ── #98: reinstall frontend deps when package-lock.json changes ─────────


def _frontend_tree(tmp_path, lock_mtime, hidden_mtime=None):
    nm = tmp_path / "node_modules"
    nm.mkdir()
    lock = tmp_path / "package-lock.json"
    lock.write_text("{}")
    os.utime(lock, (lock_mtime, lock_mtime))
    if hidden_mtime is not None:
        hidden = nm / ".package-lock.json"
        hidden.write_text("{}")
        os.utime(hidden, (hidden_mtime, hidden_mtime))
    return tmp_path


def test_frontend_deps_fresh_when_lock_unchanged(monkeypatch, tmp_path):
    monkeypatch.setattr(start, "FRONTEND", str(_frontend_tree(tmp_path, 1000, 1000)))
    monkeypatch.setattr(start.subprocess, "run", lambda *a, **k: pytest.fail("no install"))
    assert start.install_frontend() is True


def test_frontend_deps_reinstalled_when_lock_newer(monkeypatch, tmp_path):
    monkeypatch.setattr(start, "FRONTEND", str(_frontend_tree(tmp_path, 5000, 1000)))
    monkeypatch.setattr(start, "_is_effective_root", lambda: False)
    calls = []
    monkeypatch.setattr(
        start.subprocess, "run", lambda argv, **kw: calls.append(argv) or _completed(0),
    )
    assert start.install_frontend() is True
    assert calls == [["npm", "install"]]
    # The stamp written after a good install makes the next run a no-op.
    assert start._frontend_deps_stale() is False


def test_frontend_deps_stale_under_root_is_refused(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(start, "FRONTEND", str(_frontend_tree(tmp_path, 5000, 1000)))
    monkeypatch.setattr(start, "_is_effective_root", lambda: True)
    monkeypatch.setattr(start.subprocess, "run", lambda *a, **k: pytest.fail("no install"))
    assert start.install_frontend() is False
    assert "一般使用者" in capsys.readouterr().out
