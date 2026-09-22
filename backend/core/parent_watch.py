"""Launcher-process watch loop.

The packaged macOS app starts the backend with administrator rights (the
iOS 17+ tunnel needs them), so the Electron shell — an ordinary user
process — cannot signal it on quit. The shell instead passes its own pid in
``GEOMIRAGE_PARENT_PID`` and this loop shuts the backend down once that
process is gone, which also covers a crashed or force-quit shell.

Design notes:

  - Opt-in. Without the env var (``start.py``, Windows builds) the loop is
    never started.
  - POSIX only. ``os.kill(pid, 0)`` probes on POSIX but *terminates* the
    target on Windows, so ``parent_pid_from_env`` returns None there.
  - ``PermissionError`` from the probe means the process exists.
  - ``request_exit`` sets uvicorn's ``should_exit`` flag directly, which runs
    the normal lifespan shutdown (tunnel teardown, engine restore). A
    self-sent SIGTERM was observed not to stop the frozen build when it runs
    with administrator rights, so the signal is only the no-server fallback.
  - A root process nobody can signal must not outlive its launcher: a timer
    hard-exits the process if the graceful shutdown stalls.
  - Cooperative stop via an ``asyncio.Event`` mirrors ``tunnel_liveness``.
"""

import asyncio
import logging
import os
import signal
import threading
from collections.abc import Callable, Mapping

logger = logging.getLogger(__name__)

PARENT_PID_ENV = "GEOMIRAGE_PARENT_PID"

_POLL_INTERVAL_S = 1.0
_HARD_EXIT_AFTER_S = 10.0


def parent_pid_from_env(environ: Mapping[str, str] | None = None) -> int | None:
    """Return the launcher pid to watch, or None when watching is off."""
    if os.name == "nt":
        return None
    raw = (os.environ if environ is None else environ).get(PARENT_PID_ENV, "")
    try:
        pid = int(raw)
    except ValueError:
        return None
    return pid if pid > 0 else None


def _terminate_self() -> None:
    os.kill(os.getpid(), signal.SIGTERM)


def request_exit(server=None, *, hard_exit_after_s: float = _HARD_EXIT_AFTER_S) -> None:
    """Shut this process down: gracefully via *server* (a ``uvicorn.Server``)
    when given, else by SIGTERM; forcibly once *hard_exit_after_s* passes."""
    timer = threading.Timer(hard_exit_after_s, os._exit, args=(1,))
    timer.daemon = True
    timer.start()
    if server is not None:
        server.should_exit = True
    else:
        _terminate_self()


def _is_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


async def parent_watch_loop(
    parent_pid: int,
    stop_event: asyncio.Event,
    *,
    on_gone: Callable[[], None] = request_exit,
    interval_s: float = _POLL_INTERVAL_S,
) -> None:
    """Call *on_gone* once *parent_pid* no longer exists, then return."""
    while not stop_event.is_set():
        if not _is_alive(parent_pid):
            logger.warning("Launcher process %s is gone — shutting down", parent_pid)
            on_gone()
            return
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=interval_s)
        except asyncio.TimeoutError:
            pass
