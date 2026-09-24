"""Single source of truth for per-device connection state.

Background
----------
Before this module existed, ``device_connected`` / ``device_disconnected``
WS broadcasts were emitted from at least six different sites: the user-
driven ``api/device.py`` routes, the USB watchdog, the auto-connect path
in ``main.py``, ``api/location/_helpers.py:_force_reconnect``,
``api/location/_helpers.py:handle_device_lost``, and the WiFi tunnel
liveness cleanup. Each site reassembled the same payload by hand. The
"hard-reset succeeds but renderer chip stays at 重連中" bug was a direct
consequence — ``_force_reconnect`` forgot to broadcast and there was no
single observable point to catch the omission.

Design
------
This module owns three concerns:

  1. **State** — a per-UDID :class:`DeviceState` (``disconnected``,
     ``connected``, ``degraded``). Stored on :class:`ConnectionStateStore`.
  2. **Transitions** — :func:`connect_device`, :func:`disconnect_device`,
     :func:`mark_degraded`, :func:`mark_recovered`. These wrap
     :meth:`DeviceManager.connect` / :meth:`DeviceManager.disconnect` so
     the transport call and the state mutation happen together.
  3. **Broadcast** — a single subscriber installed at startup
     (:func:`install_ws_observer`) translates each transition into the
     appropriate WS event (``device_connected``, ``device_disconnected``,
     ``tunnel_degraded``, ``tunnel_recovered``). Callers never broadcast
     directly anymore.

Layering
--------
Lives in ``services/`` so both ``api/`` routers and ``core/`` /
``services/`` background loops can import it without violating the
``api/ -> core/ -> services/`` layer rule enforced by
``tools/check_layers.py``. It takes a :class:`DeviceManager` reference
as a parameter instead of importing it, which keeps the dependency
direction clean.

Testing
-------
Tests can install their own subscriber to assert on transitions without
mocking the broadcaster. :func:`reset_for_tests` clears state and
subscribers (preserving no installed-by-default observers).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Awaitable, Callable

from services.disconnect_dedup import emit_device_disconnected
from services.ws_broadcaster import broadcast

logger = logging.getLogger(__name__)


class DeviceState(str, Enum):
    """High-level per-device connection state.

    The intermediate ``CONNECTING`` state from the original design was
    dropped — ``DeviceManager.connect`` is atomic from the caller's POV
    (raises on failure, succeeds with a fully-built transport), so the
    only useful states are these three.
    """

    DISCONNECTED = "disconnected"
    CONNECTED = "connected"
    # Transport is alive but the DVT instrument channel is being
    # re-handshaked. Emitted by DvtLocationService._reconnect via
    # mark_degraded() so the renderer can show a "reconnecting…" hint
    # without flipping the device to fully disconnected.
    DEGRADED = "degraded"


@dataclass(frozen=True)
class StateTransition:
    """Immutable record of a single state change.

    Passed to every subscriber. ``cause`` is a short stable string used
    for diagnostics and renderer-side filtering; ``metadata`` carries
    payload fields for the WS broadcast (name, ios_version,
    connection_type) and is preserved across DEGRADED ↔ CONNECTED
    flips so a ``tunnel_recovered`` doesn't have to re-fetch them.
    """

    udid: str
    from_state: DeviceState
    to_state: DeviceState
    cause: str
    metadata: dict[str, Any] = field(default_factory=dict)


Subscriber = Callable[[StateTransition], Awaitable[None]]


class ConnectionStateStore:
    """Pure state holder. No I/O, no DeviceManager dependency.

    Mutated only from the asyncio event loop (every call site is async),
    so we don't need an explicit lock. The store is exposed as a module-
    level singleton :data:`store`; tests reset it via
    :func:`reset_for_tests`.
    """

    def __init__(self) -> None:
        self._state: dict[str, DeviceState] = {}
        self._metadata: dict[str, dict[str, Any]] = {}
        self._subscribers: list[Subscriber] = []

    def get(self, udid: str) -> DeviceState:
        return self._state.get(udid, DeviceState.DISCONNECTED)

    def snapshot(self) -> dict[str, DeviceState]:
        """Return a copy of the current state map. Useful for diagnostics
        and for the WS observer to re-emit on a fresh client connection."""
        return dict(self._state)

    def metadata_for(self, udid: str) -> dict[str, Any]:
        """Return cached metadata for *udid* (name, ios_version,
        connection_type). Empty dict when unknown. Preserved across
        DEGRADED transitions so ``tunnel_recovered`` carries the same
        identifying info as the original ``device_connected``."""
        return dict(self._metadata.get(udid, {}))

    def subscribe(self, callback: Subscriber) -> None:
        """Register a callback for every transition. Duplicate
        registrations are silently de-duplicated so callers can install
        idempotently on every app start."""
        if callback not in self._subscribers:
            self._subscribers.append(callback)

    async def transition(
        self,
        udid: str,
        new_state: DeviceState,
        *,
        cause: str,
        metadata: dict[str, Any] | None = None,
    ) -> bool:
        """Move *udid* into *new_state*. Returns True if state actually
        changed (subscribers were notified), False otherwise.

        Subscriber exceptions are logged but never propagate — a broken
        observer must not block the state transition or other subscribers.
        """
        old = self._state.get(udid, DeviceState.DISCONNECTED)
        if old == new_state:
            # Same state is normally a no-op. The one exception is a
            # metadata change worth re-broadcasting — specifically a
            # connection_type flip (USB → Network) on a device that stays
            # CONNECTED while a WiFi tunnel takes over. Without this, the
            # SSoT (and the /api/device/list merge that replays it) stays
            # pinned to the stale "USB" payload and the renderer keeps
            # showing a USB pill for a device that's actually on WiFi.
            #
            # A re-disconnect, or an absent/byte-identical metadata payload,
            # remains a true no-op — this keeps the usbmux watchdog's
            # per-second re-assert from spamming subscribers.
            if new_state == DeviceState.DISCONNECTED or metadata is None:
                return False
            if dict(metadata) == self._metadata.get(udid):
                return False
            # else: metadata changed — fall through to update + notify.

        self._state[udid] = new_state
        if new_state == DeviceState.DISCONNECTED:
            # Drop the metadata cache on disconnect so a stale name
            # doesn't bleed into the next connection cycle.
            self._metadata.pop(udid, None)
            md_for_event = metadata or {}
        else:
            if metadata is not None:
                self._metadata[udid] = dict(metadata)
            md_for_event = self.metadata_for(udid)

        event = StateTransition(
            udid=udid,
            from_state=old,
            to_state=new_state,
            cause=cause,
            metadata=md_for_event,
        )
        for sub in list(self._subscribers):
            try:
                await sub(event)
            except Exception:
                logger.exception(
                    "connection_state subscriber raised on %s → %s for %s",
                    old.value, new_state.value, udid,
                )
        return True


# Module-level singleton. Parallels the ``ws_broadcaster._connections``
# pattern — callers import the singleton, tests reset it.
store = ConnectionStateStore()


# ─── High-level orchestration ─────────────────────────────────────────
#
# All call sites that used to do ``dm.connect`` + manual broadcast now
# go through these helpers. The combination ensures the transport call
# and the WS event are never out of sync.

async def _collect_metadata(dm, udid: str) -> dict[str, Any]:
    """Best-effort fetch of device metadata for the WS payload.

    A discover_devices failure here is non-fatal — we'd rather emit a
    ``device_connected`` with empty name fields than skip the broadcast
    entirely (the renderer's chip pulse depends on receiving the event).
    """
    try:
        devs = await dm.discover_devices()
    except Exception:
        logger.debug("connection_state: discover_devices failed", exc_info=True)
        return {}
    info = next((d for d in devs if d.udid == udid), None)
    if info is None:
        return {}
    return {
        "name": getattr(info, "name", "") or "",
        "ios_version": getattr(info, "ios_version", "") or "",
        "connection_type": getattr(info, "connection_type", "USB") or "USB",
    }


async def connect_device(dm, udid: str, *, cause: str) -> None:
    """Connect *udid* through *dm* and announce the state change.

    Raises whatever ``dm.connect`` raises (e.g. ``DeviceNotFoundError``,
    ``UnsupportedIosVersionError``). When that happens the state stays
    DISCONNECTED and no event fires, matching the previous behavior of
    "broadcast only on success".

    ``cause`` is a short string ("user", "auto_usb", "startup",
    "hard_reset", …) used for diagnostics — it does NOT change the
    broadcast event type, only the ``reason`` payload field.
    """
    await dm.connect(udid)
    metadata = await _collect_metadata(dm, udid)
    await store.transition(
        udid,
        DeviceState.CONNECTED,
        cause=cause,
        metadata=metadata,
    )


async def announce_connected(
    udid: str,
    *,
    name: str,
    ios_version: str,
    connection_type: str,
    cause: str,
) -> None:
    """Record an already-established connection in the SSoT + broadcast it.

    Unlike :func:`connect_device`, the transport is already up — the WiFi
    tunnel path calls ``dm.connect_wifi_tunnel`` itself — so this only
    drives the state store. It still emits ``device_connected`` even when
    the device was already CONNECTED over a *different* transport
    (USB → Network): :meth:`ConnectionStateStore.transition` re-notifies
    on a connection_type change, so the renderer repaints the pill and the
    ``/api/device/list`` merge stops replaying stale USB metadata.
    """
    await store.transition(
        udid,
        DeviceState.CONNECTED,
        cause=cause,
        metadata={
            "name": name,
            "ios_version": ios_version,
            "connection_type": connection_type,
        },
    )


async def reannounce_connected(
    dm,
    udid: str,
    *,
    cause: str,
    disconnect_cause: str,
    metadata: dict[str, Any] | None = None,
) -> None:
    """Re-announce *udid* as CONNECTED after its transport was swapped
    out from under it (today: USB → WiFi-tunnel fallback).

    The old transport is truly gone, so this drives the store through
    DISCONNECTED first and then back to CONNECTED with freshly collected
    metadata. A straight CONNECTED→CONNECTED would be a no-op
    (:meth:`ConnectionStateStore.transition` returns False) and the
    renderer would never repaint the pill for the new transport.

    ``disconnect_cause`` labels the intermediate DISCONNECTED hop (it
    reaches the ``device_disconnected`` WS payload); ``cause`` labels the
    final CONNECTED announce. This is the public face of the transition
    pair — callers must not drive :data:`store` (or
    :func:`_collect_metadata`) directly.

    Pass ``metadata`` when the caller already holds it. After a USB →
    WiFi swap the device has left usbmux, so :func:`_collect_metadata`
    would find nothing and the announce would carry empty defaults.
    """
    if metadata is None:
        metadata = await _collect_metadata(dm, udid)
    await store.transition(
        udid, DeviceState.DISCONNECTED, cause=disconnect_cause,
    )
    await store.transition(
        udid, DeviceState.CONNECTED, cause=cause, metadata=metadata,
    )


async def disconnect_device(dm, udid: str, *, cause: str) -> None:
    """Disconnect *udid* through *dm* and announce the state change.

    Unlike :func:`connect_device`, this swallows transport errors —
    ``dm.disconnect`` runs both on user-initiated disconnects and on
    device-lost cleanup where every close step is expected to fail
    (the OS sockets are already gone). The state transition fires
    regardless so the renderer always sees the device leave.
    """
    try:
        await dm.disconnect(udid)
    except Exception:
        logger.exception(
            "connection_state: dm.disconnect raised for %s "
            "(continuing transition anyway)", udid,
        )
    await store.transition(udid, DeviceState.DISCONNECTED, cause=cause)


async def mark_degraded(udid: str, *, cause: str) -> None:
    """Flag *udid* as having a degraded transport (DVT channel reconnecting).

    Only transitions when the device is currently CONNECTED — a degrade
    on an already-disconnected device is a no-op (the disconnect already
    superseded it). Idempotent: calling twice in a row is silently
    swallowed by :meth:`ConnectionStateStore.transition`.
    """
    if store.get(udid) == DeviceState.CONNECTED:
        await store.transition(udid, DeviceState.DEGRADED, cause=cause)


async def mark_recovered(udid: str) -> None:
    """Clear the DEGRADED flag for *udid*, returning to CONNECTED.

    No-op if not currently DEGRADED (e.g. the device was disconnected
    between mark_degraded and mark_recovered).
    """
    if store.get(udid) == DeviceState.DEGRADED:
        await store.transition(
            udid,
            DeviceState.CONNECTED,
            cause="recovered",
            metadata=store.metadata_for(udid),
        )


# ─── Connect rollback ────────────────────────────────────────────────
#
# The connect endpoints transition the store to CONNECTED (and broadcast
# ``device_connected``) *before* the simulation engine exists. These
# helpers guarantee an engine-creation failure never leaves the store
# advertising a connected device with no engine behind it. Modeled on
# the WiFi-tunnel USB-fallback rollback, which got this right first.

async def rollback_failed_connect(
    dm,
    app_state,
    udid: str,
    *,
    cause: str,
    stage: str,
    error: str,
) -> None:
    """Undo a half-completed connect for *udid*: terminate any partially
    built engine, disconnect the transport (transitioning the store back
    to DISCONNECTED, which broadcasts ``device_disconnected``), then
    broadcast ``device_error`` so the renderer can surface the failure.

    Each step runs independently — a failure in one never skips the
    others, matching the teardown discipline of the tunnel helpers.

    ``stage`` and ``error`` feed the ``device_error`` payload; ``cause``
    is the diagnostic string for the DISCONNECTED transition.
    """
    try:
        await app_state.terminate_engine(udid)
    except Exception:
        logger.exception("connect rollback: terminate_engine failed for %s", udid)
    try:
        await disconnect_device(dm, udid, cause=cause)
    except Exception:
        logger.exception("connect rollback: disconnect failed for %s", udid)
    try:
        await broadcast("device_error", {
            "udid": udid,
            "stage": stage,
            "error": error,
        })
    except Exception:
        logger.exception("connect rollback: device_error broadcast failed for %s", udid)


async def create_engine_with_rollback(
    dm,
    app_state,
    udid: str,
    *,
    cause: str,
    stage: str,
    error: str,
) -> None:
    """Build the simulation engine for an already-CONNECTED *udid*.

    On failure, runs :func:`rollback_failed_connect` and re-raises the
    original exception unchanged so every route's existing except-clause
    (and its :class:`ErrorCode` mapping) keeps firing exactly as before.
    """
    try:
        await app_state.create_engine_for_device(udid)
    except Exception:
        logger.exception(
            "Engine creation failed for %s; rolling back connect", udid,
        )
        await rollback_failed_connect(
            dm, app_state, udid, cause=cause, stage=stage, error=error,
        )
        raise


# ─── WS observer ─────────────────────────────────────────────────────
#
# Single translator from state transitions → existing WS event contract.
# Installed once at app startup via install_ws_observer(); callers never
# call broadcast() for these events anymore.

async def _ws_observer(event: StateTransition) -> None:
    """Translate a state transition into the matching WS event."""
    to_state = event.to_state
    from_state = event.from_state
    udid = event.udid

    if to_state == DeviceState.CONNECTED and from_state == DeviceState.DEGRADED:
        # DEGRADED → CONNECTED is a tunnel recovery, not a fresh device.
        await broadcast("tunnel_recovered", {"udid": udid})
        return

    if to_state == DeviceState.CONNECTED:
        # DISCONNECTED → CONNECTED is a fresh device showing up. Mirror
        # the payload the previous manual broadcast sites assembled so
        # the renderer dispatcher doesn't need any contract changes.
        md = event.metadata
        await broadcast("device_connected", {
            "udid": udid,
            "name": md.get("name", ""),
            "ios_version": md.get("ios_version", ""),
            "connection_type": md.get("connection_type", "USB"),
        })
        return

    if to_state == DeviceState.DEGRADED:
        # CONNECTED → DEGRADED. ``reason`` is the diagnostic ``cause``.
        await broadcast("tunnel_degraded", {
            "udid": udid,
            "reason": event.cause,
        })
        return

    if to_state == DeviceState.DISCONNECTED:
        # Anything → DISCONNECTED. Routed through dedup so two emit
        # sites that notice the same loss within ~2s don't double-toast.
        #
        # ``cause`` is duplicated alongside ``reason`` because the
        # renderer's toast picker (App.tsx) keys off ``payload.cause``
        # — a missing ``cause`` previously fell back to the
        # ``unknown`` toast even when a perfectly good DeviceLostCause
        # was available. Surfacing the same value under both keys keeps
        # the dedup key shape ``(udids, cause)`` working AND restores
        # the cause-specific toast routing.
        await emit_device_disconnected({
            "udid": udid,
            "udids": [udid],
            "reason": event.cause,
            "cause": event.cause,
        })
        return


def install_ws_observer() -> None:
    """Wire the broadcast translator into the singleton store.

    Idempotent — :meth:`ConnectionStateStore.subscribe` de-duplicates,
    so calling this once per app start (or twice if a hot-reload runs
    the lifespan setup twice in dev) is safe.
    """
    store.subscribe(_ws_observer)


# ─── Test helpers ────────────────────────────────────────────────────

def reset_for_tests() -> None:
    """Clear state, metadata, and subscribers. Tests that exercise
    transitions need this so prior test residue doesn't leak in."""
    store._state.clear()
    store._metadata.clear()
    store._subscribers.clear()
