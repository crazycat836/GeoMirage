"""Shared port-clearing helper for the launcher scripts.

``start.py`` and ``stop.py`` both need to kill whatever is listening on
the backend / frontend ports; this module is the single copy of that
logic (the two scripts used to carry independently drifted duplicates).
Plain stdlib only, same as ``terminal_ui``.

Shell-free by design: netstat/lsof run with list-form args and the
output is parsed in Python, so neither the port nor a PID is ever
interpolated into a shell pipeline.
"""

from __future__ import annotations

import os
import signal
import subprocess
import time


def _kill_port_windows(port: int) -> None:
    """Kill listeners on *port* via netstat + taskkill (no cmd.exe pipeline)."""
    result = subprocess.run(
        ["netstat", "-ano"],
        capture_output=True, text=True,
    )
    suffix = f":{port}"
    seen_pids: set[int] = set()
    for line in result.stdout.splitlines():
        # Expected listening row:
        #   "TCP  127.0.0.1:8000  0.0.0.0:0  LISTENING  1234"
        parts = line.split()
        if len(parts) < 5 or "LISTENING" not in parts:
            continue
        if not parts[1].endswith(suffix):
            continue
        try:
            pid = int(parts[-1])
        except ValueError:
            continue
        if pid in seen_pids:
            continue
        seen_pids.add(pid)
        subprocess.run(
            ["taskkill", "/F", "/PID", str(pid)],
            check=False, capture_output=True,
        )


# How long a listener gets to exit after SIGTERM before SIGKILL.
_TERM_GRACE_S = 3.0


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _kill_port_posix(port: int) -> None:
    """SIGTERM (then SIGKILL) the processes LISTENING on TCP *port*.

    ``-sTCP:LISTEN`` matters: a bare ``lsof -i :PORT`` also lists every
    client connected to the port (a browser tab on the Vite dev server,
    the packaged app's renderer on the backend port), and those must
    not be killed.
    """
    result = subprocess.run(
        ["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
        capture_output=True, text=True,
    )
    pids: list[int] = []
    for raw in result.stdout.split():
        try:
            pid = int(raw)
        except ValueError:
            continue
        if pid not in pids:
            pids.append(pid)
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
    deadline = time.monotonic() + _TERM_GRACE_S
    remaining = [pid for pid in pids if _alive(pid)]
    while remaining and time.monotonic() < deadline:
        time.sleep(0.1)
        remaining = [pid for pid in remaining if _alive(pid)]
    for pid in remaining:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass


def kill_port(port: int) -> None:
    """Terminate every process listening on *port* (Windows or POSIX)."""
    if os.name == "nt":
        _kill_port_windows(port)
    else:
        _kill_port_posix(port)
