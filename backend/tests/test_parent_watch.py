"""Tests for the launcher-process watch loop.

The packaged macOS app starts the backend with administrator rights, so the
Electron shell (an ordinary user process) cannot signal it on quit. The
backend instead polls the launcher's pid and shuts itself down once that
process is gone. ``os.kill`` is patched; no real process is signalled.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))


def test_parent_pid_from_env_reads_a_positive_integer():
    from core.parent_watch import parent_pid_from_env

    assert parent_pid_from_env({"GEOMIRAGE_PARENT_PID": "4321"}) == 4321


def test_parent_pid_from_env_ignores_missing_or_bad_values():
    from core.parent_watch import parent_pid_from_env

    assert parent_pid_from_env({}) is None
    assert parent_pid_from_env({"GEOMIRAGE_PARENT_PID": ""}) is None
    assert parent_pid_from_env({"GEOMIRAGE_PARENT_PID": "abc"}) is None
    assert parent_pid_from_env({"GEOMIRAGE_PARENT_PID": "0"}) is None
    assert parent_pid_from_env({"GEOMIRAGE_PARENT_PID": "-5"}) is None


def test_parent_pid_from_env_is_disabled_on_windows():
    # os.kill(pid, 0) on Windows terminates the target instead of probing it.
    from core import parent_watch

    with patch.object(parent_watch.os, "name", "nt"):
        assert parent_watch.parent_pid_from_env({"GEOMIRAGE_PARENT_PID": "4321"}) is None


def test_loop_requests_shutdown_once_the_parent_is_gone():
    asyncio.run(_loop_requests_shutdown_once_the_parent_is_gone())


async def _loop_requests_shutdown_once_the_parent_is_gone():
    from core import parent_watch

    on_gone = MagicMock()
    probes = iter([None, None, ProcessLookupError()])

    def fake_kill(pid, sig):
        assert (pid, sig) == (4321, 0)
        outcome = next(probes)
        if outcome is not None:
            raise outcome

    with patch.object(parent_watch.os, "kill", side_effect=fake_kill):
        await asyncio.wait_for(
            parent_watch.parent_watch_loop(
                4321, asyncio.Event(), on_gone=on_gone, interval_s=0.001,
            ),
            timeout=1.0,
        )

    on_gone.assert_called_once_with()


def test_loop_treats_permission_error_as_alive():
    asyncio.run(_loop_treats_permission_error_as_alive())


async def _loop_treats_permission_error_as_alive():
    from core import parent_watch

    on_gone = MagicMock()
    stop = asyncio.Event()
    calls = 0

    def fake_kill(pid, sig):
        nonlocal calls
        calls += 1
        if calls >= 3:
            stop.set()
        raise PermissionError()

    with patch.object(parent_watch.os, "kill", side_effect=fake_kill):
        await asyncio.wait_for(
            parent_watch.parent_watch_loop(
                4321, stop, on_gone=on_gone, interval_s=0.001,
            ),
            timeout=1.0,
        )

    on_gone.assert_not_called()


def test_loop_exits_quietly_when_stopped():
    asyncio.run(_loop_exits_quietly_when_stopped())


async def _loop_exits_quietly_when_stopped():
    from core import parent_watch

    on_gone = MagicMock()
    stop = asyncio.Event()
    stop.set()

    with patch.object(parent_watch.os, "kill") as kill:
        await asyncio.wait_for(
            parent_watch.parent_watch_loop(
                4321, stop, on_gone=on_gone, interval_s=0.001,
            ),
            timeout=1.0,
        )

    kill.assert_not_called()
    on_gone.assert_not_called()


def test_request_exit_flags_the_uvicorn_server_instead_of_signalling():
    from types import SimpleNamespace

    from core import parent_watch

    server = SimpleNamespace(should_exit=False)
    with patch.object(parent_watch.threading, "Timer") as timer, \
            patch.object(parent_watch.os, "kill") as kill:
        parent_watch.request_exit(server)

    assert server.should_exit is True
    kill.assert_not_called()
    timer.return_value.start.assert_called_once_with()


def test_request_exit_without_a_server_signals_this_process():
    from core import parent_watch

    with patch.object(parent_watch.threading, "Timer"), \
            patch.object(parent_watch.os, "kill") as kill:
        parent_watch.request_exit(None)

    kill.assert_called_once_with(parent_watch.os.getpid(), parent_watch.signal.SIGTERM)


def test_request_exit_arms_a_hard_exit_in_case_shutdown_stalls():
    from core import parent_watch

    with patch.object(parent_watch.threading, "Timer") as timer, \
            patch.object(parent_watch.os, "kill"):
        parent_watch.request_exit(None, hard_exit_after_s=7.5)

    (delay, fn), kwargs = timer.call_args
    assert delay == 7.5
    assert fn is parent_watch.os._exit
    assert timer.return_value.daemon is True
