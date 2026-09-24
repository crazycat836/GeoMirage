"""In-process WiFi tunnel runner.

Backend now runs on Python 3.13 (native TLS-PSK support), so the tunnel
lives inside the backend event loop instead of a separate helper exe.
The tunnel context (`service.start_tcp_tunnel()`) must stay open for the
RSD link to remain usable, so we hold it inside a long-running task and
release it via a stop event.
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable

logger = logging.getLogger("wifi_tunnel")

# pymobiledevice3 hard-codes a 1-second TCP timeout on the RemotePairing
# connect (tunnel_service.TIMEOUT = 1). A WiFi iPhone with a locked screen
# often drops the first SYN while its radio wakes, so one attempt is not a
# verdict. 5 attempts x (1 s timeout + 1.5 s spacing) stays well inside the
# 20 s budget TunnelRunner.start() gives the whole handshake.
CONNECT_ATTEMPTS = 5
CONNECT_RETRY_DELAY_S = 1.5

# Transient transport errors worth retrying. asyncio.TimeoutError is a
# subclass of OSError on Python >= 3.11, listed anyway for clarity.
_RETRYABLE_ERRORS = (asyncio.TimeoutError, OSError, ConnectionError)


async def connect_with_retries(
    connect: Callable[[], Awaitable],
    *,
    attempts: int = CONNECT_ATTEMPTS,
    delay_s: float = CONNECT_RETRY_DELAY_S,
    stop_event: asyncio.Event | None = None,
):
    """Run ``connect()`` retrying transient transport failures.

    Non-transport exceptions (e.g. pymobiledevice3's
    ``ConnectionTerminatedError`` — the device rejected pair-verify) are
    definitive and propagate immediately; retrying them only spams the
    device. A set ``stop_event`` aborts between attempts so a runner
    being stopped doesn't keep dialing.
    """
    last_error: BaseException | None = None
    for attempt in range(1, attempts + 1):
        try:
            return await connect()
        except _RETRYABLE_ERRORS as exc:
            last_error = exc
            logger.info(
                "RemotePairing connect attempt %d/%d failed (%s)",
                attempt, attempts, exc.__class__.__name__,
            )
            if stop_event is not None and stop_event.is_set():
                break
            if attempt < attempts:
                await asyncio.sleep(delay_s)
    assert last_error is not None
    raise last_error


class TunnelRunner:
    """Owns the tunnel asyncio task and its RSD info."""

    def __init__(self) -> None:
        self.info: dict | None = None
        self.task: asyncio.Task | None = None
        self.lock = asyncio.Lock()
        # Monotonic counter bumped on every successful start(). The
        # watchdog snapshots this when it spawns and bails if the
        # current value drifts — survives stop+start cycles (which a
        # bare `task is task` identity check cannot, because `task`
        # transiently goes None between the two).
        self.generation: int = 0
        self._stop: asyncio.Event = asyncio.Event()
        self._ready: asyncio.Event = asyncio.Event()
        self._error: BaseException | None = None
        # Direct reference to pymobiledevice3's RemotePairingTcpTunnel
        # (the ``client`` field of the value yielded by
        # ``service.start_tcp_tunnel()``). Used by ``transport_alive()``
        # to inspect the library's internal read tasks —
        # pymobiledevice3 silently swallows ConnectionResetError in its
        # ``tun_read_task`` (tunnel_service.py:189-190) and
        # ``sock_read_task`` (tunnel_service.py:319-323), leaving the
        # outer ``async with`` still waiting on ``self._stop``. Without
        # peeking at the inner tasks we can't tell a healthy tunnel
        # apart from one whose data path silently died hours ago.
        self._client: object | None = None

    def is_running(self) -> bool:
        return self.task is not None and not self.task.done()

    def transport_alive(self) -> bool:
        """Best-effort check that pymobiledevice3's internal transport
        tasks are still running.

        Returns ``False`` only when we can definitively see an exited
        read task. Defaults to ``True`` on any introspection failure
        (no client captured yet, missing attribute after library
        upgrade, etc.) so a pymobiledevice3 version bump doesn't
        false-positive into tunnel teardown.

        Specifically inspects ``_tun_read_task`` (Mac→iPhone direction,
        :class:`RemotePairingTunnel.tun_read_task`) and
        ``_sock_read_task`` (iPhone→Mac,
        :class:`RemotePairingTcpTunnel.sock_read_task`). Either task
        exiting means data can no longer flow even though ``self.task``
        and the OS tun interface are still up.
        """
        client = self._client
        if client is None:
            # No tunnel established yet (or already torn down).
            # ``is_running()`` already guards "not started" upstream;
            # don't double-fail this case.
            return True
        try:
            tun_task = getattr(client, "_tun_read_task", None)
            sock_task = getattr(client, "_sock_read_task", None)
        except Exception:
            return True
        for label, task in (("tun_read", tun_task), ("sock_read", sock_task)):
            if task is None:
                continue
            try:
                if task.done():
                    logger.warning(
                        "Tunnel transport %s_task has exited — pymobiledevice3 "
                        "swallowed the underlying disconnect",
                        label,
                    )
                    return False
            except Exception:
                # Any introspection error means we can't confirm dead;
                # fall through to "alive" rather than false-positive.
                continue
        return True

    async def _run(self, udid: str, ip: str, port: int) -> None:
        from pymobiledevice3.remote.tunnel_service import (
            create_core_device_tunnel_service_using_remotepairing,
        )
        try:
            logger.info("Connecting to RemotePairing service at %s:%d", ip, port)
            service = await connect_with_retries(
                lambda: create_core_device_tunnel_service_using_remotepairing(
                    udid, ip, port,
                ),
                stop_event=self._stop,
            )
            logger.info("RemotePairing connected (identifier=%s)", service.remote_identifier)

            async with service.start_tcp_tunnel() as tunnel:
                self._client = getattr(tunnel, "client", None)
                self.info = {
                    "rsd_address": tunnel.address,
                    "rsd_port": tunnel.port,
                    "interface": tunnel.interface,
                    "protocol": str(tunnel.protocol),
                    # Which device this tunnel serves, so a start request
                    # for another IP can be refused instead of being
                    # answered with this tunnel's RSD.
                    "ip": ip,
                }
                logger.info(
                    "WiFi tunnel established: %s:%d iface=%s",
                    tunnel.address, tunnel.port, tunnel.interface,
                )
                self._ready.set()
                await self._stop.wait()
                logger.info("Tunnel stop signal received; closing context")
        except BaseException as exc:
            self._error = exc
            self._ready.set()
            raise
        finally:
            self.info = None
            self._client = None

    async def start(self, udid: str, ip: str, port: int, timeout: float = 20.0) -> dict:
        """Start the tunnel and wait until RSD info is ready.

        Raises asyncio.TimeoutError on timeout or the underlying exception
        if the tunnel setup failed before becoming ready.
        """
        self._stop = asyncio.Event()
        self._ready = asyncio.Event()
        self._error = None
        self.info = None
        self.task = asyncio.create_task(self._run(udid, ip, port))
        try:
            await asyncio.wait_for(self._ready.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            self._stop.set()
            try:
                await asyncio.wait_for(self.task, timeout=2.0)
            except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
                pass
            self.task = None
            raise
        if self._error is not None:
            exc = self._error
            self.task = None
            raise exc
        # Successful handshake — advance the generation epoch so the
        # watchdog can detect "the tunnel I was watching has been
        # replaced" without relying on Task identity (which goes None
        # in the gap between stop() and the next start()).
        self.generation += 1
        return dict(self.info or {})

    async def stop(self) -> None:
        if not self.is_running():
            self.task = None
            self.info = None
            return
        self._stop.set()
        try:
            await asyncio.wait_for(self.task, timeout=5.0)
        except asyncio.TimeoutError:
            logger.warning("Tunnel task did not exit in 5s; cancelling")
            self.task.cancel()
            try:
                await self.task
            except (asyncio.CancelledError, Exception):
                pass
        except (asyncio.CancelledError, Exception):
            pass
        self.task = None
        self.info = None
