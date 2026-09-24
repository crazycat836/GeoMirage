"""A second backend instance must not clobber the running one's token.

Lifespan startup writes a fresh session token to ``~/.geomirage/token``.
uvicorn runs lifespan startup before binding its port, so a second
instance that could not get 8777 used to replace the token and then
exit, leaving the running backend rejecting the renderer's WebSocket
reconnects. ``main.run`` binds first and only then serves; and
``start.py`` must not report success when the backend already exited.
"""

from __future__ import annotations

import importlib.util
import socket
import subprocess
import sys
from pathlib import Path

import pytest
import uvicorn

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

import main  # noqa: E402


def _listening_socket() -> socket.socket:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sock.listen()
    return sock


def test_run_exits_before_startup_when_port_is_taken(tmp_path: Path, monkeypatch) -> None:
    holder = _listening_socket()
    token_file = tmp_path / "token"
    token_file.write_text("running-backend-token", encoding="utf-8")
    monkeypatch.setattr(main, "TOKEN_FILE", token_file)
    monkeypatch.setattr(main, "API_PORT", holder.getsockname()[1])
    served = []
    monkeypatch.setattr(uvicorn.Server, "run", lambda self, sockets=None: served.append(sockets))

    try:
        with pytest.raises(SystemExit):
            main.run()
    finally:
        holder.close()

    assert served == []
    assert token_file.read_text(encoding="utf-8") == "running-backend-token"


def test_run_serves_on_the_prebound_socket(monkeypatch) -> None:
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    free_port = probe.getsockname()[1]
    probe.close()
    monkeypatch.setattr(main, "API_PORT", free_port)
    served = []
    monkeypatch.setattr(uvicorn.Server, "run", lambda self, sockets=None: served.append(sockets))

    main.run()

    (sockets,) = served
    try:
        assert [s.getsockname()[1] for s in sockets] == [free_port]
    finally:
        for s in sockets:
            s.close()


def _load_start_py():
    spec = importlib.util.spec_from_file_location(
        "geomirage_start", _BACKEND.parent / "start.py",
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_wait_for_port_fails_when_process_already_exited(monkeypatch) -> None:
    start = _load_start_py()
    # Someone else (e.g. a root backend) holds the port.
    monkeypatch.setattr(start, "is_port_open", lambda port: True)
    dead = subprocess.Popen([sys.executable, "-c", "raise SystemExit(1)"])
    dead.wait()

    assert start.wait_for_port(8777, "backend", timeout=5, proc=dead) is False


def test_start_backend_refuses_when_port_stays_taken(monkeypatch) -> None:
    start = _load_start_py()
    monkeypatch.setattr(start, "is_port_open", lambda port: True)
    monkeypatch.setattr(start, "kill_port", lambda port: None)
    monkeypatch.setattr(start.time, "sleep", lambda s: None)
    spawned = []
    monkeypatch.setattr(start.subprocess, "Popen", lambda *a, **kw: spawned.append(a))

    assert start.start_backend() is False
    assert spawned == []
