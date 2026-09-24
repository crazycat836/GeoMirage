"""Tests for ``tools/ports.py`` (port clearing used by start.py / stop.py)."""

from __future__ import annotations

import signal
import sys
import types
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools import ports  # noqa: E402

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="POSIX lsof path")


def _install(monkeypatch, lsof_out, exits_on_term=True):
    runs, kills = [], []
    alive = set()

    def fake_run(argv, **kwargs):
        runs.append(argv)
        return types.SimpleNamespace(returncode=0, stdout=lsof_out, stderr="")

    def fake_kill(pid, sig):
        kills.append((pid, sig))
        if sig == 0:
            if pid not in alive:
                raise ProcessLookupError
            return
        if sig == signal.SIGTERM and not exits_on_term:
            alive.add(pid)
        if sig == signal.SIGKILL:
            alive.discard(pid)

    monkeypatch.setattr(ports.subprocess, "run", fake_run)
    monkeypatch.setattr(ports.os, "kill", fake_kill)
    monkeypatch.setattr(ports.time, "sleep", lambda s: None)
    monkeypatch.setattr(ports, "_TERM_GRACE_S", 0.05)
    return runs, kills


def test_lsof_only_selects_listeners(monkeypatch):
    runs, _ = _install(monkeypatch, "")
    ports._kill_port_posix(5173)
    (argv,) = runs
    assert argv[0] == "lsof"
    assert "-sTCP:LISTEN" in argv
    assert "-iTCP:5173" in argv


def test_sends_sigterm_first_and_no_sigkill_when_it_exits(monkeypatch):
    _, kills = _install(monkeypatch, "4242\n")
    ports._kill_port_posix(8777)
    signals = [sig for _, sig in kills if sig != 0]
    assert signals == [signal.SIGTERM]


def test_sigkill_only_after_sigterm_is_ignored(monkeypatch):
    _, kills = _install(monkeypatch, "4242\n", exits_on_term=False)
    ports._kill_port_posix(8777)
    signals = [sig for _, sig in kills if sig != 0]
    assert signals == [signal.SIGTERM, signal.SIGKILL]
