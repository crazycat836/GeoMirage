"""Periodic TCP liveness probe for the WiFi tunnel's RSD endpoint.

Catches the case where the iPhone silently leaves the WiFi network (or the
Mac wakes from sleep with a dead tunnel) — neither ``_tunnel_watchdog``
(only fires when the tunnel asyncio task *raises*) nor
``_usbmux_presence_watchdog`` (USB-only) covers this scenario. Without it,
the frontend keeps showing the device as "connected" indefinitely because
``DeviceManager._connections`` is never reconciled.

The probe is poll-driven; the existing watchdog stays event-driven. They
co-exist safely because the cleanup helper they share
(``cleanup_wifi_connections``) is idempotent on an empty UDID list.

Layering: part of the **connection-orchestration group** (see
``tools/check_layers.py``) — a runtime loop that may depend on both
``core/`` and ``services/``. ``main.py``'s lifespan passes ``app_state``
in explicitly at task creation; the lazy ``context.ctx`` fallback exists
only for tests that monkeypatch ``ctx.app_state`` instead of passing one.
"""

import asyncio
import logging

logger = logging.getLogger(__name__)

# Probe cadence and threshold. ~5s × 3 misses = ~15s worst-case detection
# latency, which matches the user-perceptible "the pill is wrong" window
# without burning CPU on a dead-tunnel hot loop.
PROBE_INTERVAL_S = 5.0
PROBE_TIMEOUT_S = 2.0
MISS_THRESHOLD = 3


async def tunnel_liveness_loop(stop: asyncio.Event, app_state=None) -> None:
    """Probe the active WiFi tunnel's RSD endpoint until ``stop`` is set.

    Tears down WiFi connections + the tunnel itself once the endpoint has
    been unreachable for ``MISS_THRESHOLD * PROBE_INTERVAL_S`` seconds.
    Safe to run concurrently with ``_tunnel_watchdog`` — both ultimately
    route through ``cleanup_wifi_connections``, which short-circuits when
    there are no Network devices left to disconnect.

    ``app_state`` is passed in by ``main.py``'s lifespan at task-creation
    time. When omitted it falls back to ``context.ctx`` — that fallback is
    load-bearing for the unit tests, which monkeypatch ``ctx.app_state``
    and start the loop without arguments.
    """
    from services.wifi_tunnel_service import (
        _tcp_probe,
        cleanup_wifi_connections,
        tunnel,
        tunnel_udids,
    )

    if app_state is None:
        from context import ctx
        app_state = ctx.app_state

    miss_count = 0
    logger.info(
        "Tunnel liveness probe started (interval=%.1fs, threshold=%d misses)",
        PROBE_INTERVAL_S, MISS_THRESHOLD,
    )

    try:
        while not stop.is_set():
            # asyncio.wait_for(stop.wait(), timeout) returns when stop fires
            # (we exit the loop) or raises TimeoutError on the interval
            # (we run a probe). Cleaner than `await asyncio.sleep()` because
            # shutdown unblocks immediately instead of finishing the sleep.
            try:
                await asyncio.wait_for(stop.wait(), timeout=PROBE_INTERVAL_S)
                break
            except asyncio.TimeoutError:
                pass

            # Snapshot tunnel state under lock — `info` and `generation` must
            # be read together so the post-probe generation check below
            # compares against the same epoch we probed.
            async with tunnel.lock:
                if not tunnel.is_running() or tunnel.info is None:
                    miss_count = 0
                    continue
                gen = tunnel.generation
                rsd_address = tunnel.info.get("rsd_address")
                rsd_port = tunnel.info.get("rsd_port")
                # Deep transport check while we hold the lock — peeks at
                # pymobiledevice3's internal read tasks. Catches the case
                # where ``ConnectionResetError`` was silently swallowed by
                # the library and the OS tun interface is still up (TCP
                # probes to RSD then deceptively succeed). See
                # TunnelRunner.transport_alive for the rationale.
                transport_ok = (
                    tunnel.transport_alive()
                    if hasattr(tunnel, "transport_alive")
                    else True
                )

            if not rsd_address or not rsd_port:
                miss_count = 0
                continue

            # Skip probing when no device currently consumes the tunnel —
            # there's nothing to falsely advertise as "connected" and the
            # user may still be mid-handshake on a fresh tunnel.
            dm = app_state.device_manager
            if not tunnel_udids(dm):
                miss_count = 0
                continue

            if not transport_ok:
                # Definitive signal: a read task has exited. No need to
                # keep accumulating misses against a silent transport —
                # jump straight to threshold so the generation-guarded
                # cleanup path below fires this iteration. Logging is
                # already done inside transport_alive() at warning level
                # with the specific task name.
                logger.error(
                    "Tunnel transport reports dead — escalating to cleanup "
                    "without waiting for TCP miss threshold (rsd=%s:%d)",
                    rsd_address, rsd_port,
                )
                miss_count = MISS_THRESHOLD
            else:
                alive = await _tcp_probe(rsd_address, rsd_port, timeout=PROBE_TIMEOUT_S)
                if alive:
                    if miss_count > 0:
                        logger.info(
                            "Tunnel probe recovered after %d miss(es) rsd=%s:%d",
                            miss_count, rsd_address, rsd_port,
                        )
                    miss_count = 0
                    continue

                miss_count += 1
                logger.warning(
                    "Tunnel probe failed (%d/%d) rsd=%s:%d",
                    miss_count, MISS_THRESHOLD, rsd_address, rsd_port,
                )
                if miss_count < MISS_THRESHOLD:
                    continue

            # Threshold reached — re-acquire the lock and verify the
            # generation we probed is still current. A user-driven
            # stop()/start() cycle inside the probe window bumps generation;
            # in that case the new tunnel owns its own future and we must
            # not tear it down based on the old tunnel's misses.
            async with tunnel.lock:
                if tunnel.generation != gen:
                    logger.info(
                        "Liveness threshold reached but tunnel generation moved "
                        "(seen=%d, current=%d) — yielding to new tunnel",
                        gen, tunnel.generation,
                    )
                    miss_count = 0
                    continue

            logger.error(
                "Tunnel unreachable for ~%.0fs — declaring dead, cleaning up",
                PROBE_INTERVAL_S * MISS_THRESHOLD,
            )
            try:
                await cleanup_wifi_connections(reason="tunnel_lost_liveness")
            except Exception:
                logger.exception("Liveness cleanup failed")
            try:
                await tunnel.stop()
            except Exception:
                logger.exception("Liveness tunnel.stop failed")
            miss_count = 0
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("Tunnel liveness loop crashed")
        raise
    finally:
        logger.info("Tunnel liveness probe stopped")
