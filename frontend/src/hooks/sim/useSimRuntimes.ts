/**
 * Per-device simulation runtime state — the SINGLE source of truth for
 * device simulation state.
 *
 * Each connected device gets a slot in the `runtimes` map keyed by udid.
 * Slots are populated by `useSimWsDispatcher` from incoming
 * `position_update` / `state_change` / `route_path` / `waypoint_progress`
 * / `device_connected` events, and patched optimistically by the action
 * handlers in `useSimulation` (teleport, navigate, stop, …).
 *
 * Consumers read the map directly (DeviceChip, EtaBar, MiniStatusBar)
 * or through the derived single-device view in `useSimulation`
 * (`currentPosition`, `status`, `progress`, `eta`, `routePath` are all
 * projections of the primary runtime).
 *
 * ── The local slot ─────────────────────────────────────────────────────
 * Before the first udid-tagged event arrives (cold start, page reload),
 * single-device state still needs a home: the rehydrated last position,
 * the `getStatus()` snapshot, and udid-less WS frames. Those writes land
 * in a reserved `LOCAL_RUNTIME_KEY` slot. The first write for a real
 * udid PROMOTES the local slot — its accumulated state seeds the new
 * udid entry and the sentinel is removed — so the derived primary view
 * stays continuous across the udid becoming known.
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import type { LatLng } from './types'

/** Reserved runtimes key for the pre-udid single-device slot. */
export const LOCAL_RUNTIME_KEY = '__local__'

export interface DeviceRuntime {
  udid: string
  state: string
  currentPos: LatLng | null
  destination: LatLng | null
  routePath: LatLng[]
  progress: number
  /** Seconds remaining, or null when no run is in flight (mirrors the
   *  legacy single-device `eta` nullability so the derived view can
   *  distinguish "no ETA" from "arriving now"). */
  eta: number | null
  distanceRemaining: number
  distanceTraveled: number
  waypointIndex: number | null
  currentSpeedKmh: number
  error: string | null
  lapCount: number
  cooldown: number
  // True between a `tunnel_degraded` and the next `tunnel_recovered` /
  // terminal `device_disconnected`. Orthogonal to `state` — the engine
  // can still be NAVIGATING while the underlying DVT channel is being
  // re-handshaked. DeviceChip overlays the "reconnecting" pulse on top
  // of whatever state is showing.
  tunnelDegraded: boolean
}

export type RuntimesMap = Record<string, DeviceRuntime>

/**
 * Key of the primary runtime — the slot the single-device view reads.
 *
 * `primaryUdid` is DeviceContext's primary device (`connectedDevices[0]`),
 * so the sim view and the device UI agree on which phone is "primary".
 * Entries are never pruned on disconnect (the chip keeps showing
 * "disconnected" and the pin keeps its last position), so insertion
 * order alone would stay stuck on the first phone ever seen.
 *
 * Order: the primary udid's entry → the pre-udid local slot → the first
 * entry (no device connected: keep showing the last-known device).
 */
export function primaryRuntimeKey(
  runtimes: RuntimesMap,
  primaryUdid: string | null | undefined,
): string | null {
  if (primaryUdid && runtimes[primaryUdid]) return primaryUdid
  if (runtimes[LOCAL_RUNTIME_KEY]) return LOCAL_RUNTIME_KEY
  return Object.keys(runtimes)[0] ?? null
}

export function emptyRuntime(udid: string): DeviceRuntime {
  return {
    udid,
    state: 'idle',
    currentPos: null,
    destination: null,
    routePath: [],
    progress: 0,
    eta: null,
    distanceRemaining: 0,
    distanceTraveled: 0,
    waypointIndex: null,
    currentSpeedKmh: 0,
    error: null,
    lapCount: 0,
    cooldown: 0,
    tunnelDegraded: false,
  }
}

/**
 * Patch for the primary runtime. The functional form receives the
 * current entry so callers can express conditional writes (e.g. "set
 * position only if none is cached"); returning an empty object makes
 * the patch a no-op that keeps the previous map reference.
 */
export type PrimaryRuntimePatch =
  | Partial<DeviceRuntime>
  | ((current: DeviceRuntime) => Partial<DeviceRuntime>)

export interface UseSimRuntimesValue {
  runtimes: RuntimesMap
  setRuntimes: React.Dispatch<React.SetStateAction<RuntimesMap>>
  /** Patch a single device's runtime; auto-creates an entry on first
   *  write (promoting the local slot's state when one exists) so callers
   *  don't have to pre-seed the map. */
  updateRuntime: (udid: string, patch: Partial<DeviceRuntime>) => void
  /** Patch the primary runtime (the primary udid's entry, created on
   *  demand; with no primary udid, the first map entry), falling back to
   *  the reserved local slot when no device has been seen yet. Used by
   *  the udid-less WS path and by optimistic single-device actions. */
  patchPrimaryRuntime: (patch: PrimaryRuntimePatch) => void
}

export function useSimRuntimes(primaryUdid: string | null = null): UseSimRuntimesValue {
  const [runtimes, setRuntimes] = useState<RuntimesMap>({})
  // Read at patch time so `patchPrimaryRuntime` keeps a stable identity.
  const primaryUdidRef = useRef(primaryUdid)
  useEffect(() => { primaryUdidRef.current = primaryUdid }, [primaryUdid])

  const updateRuntime = useCallback((udid: string, patch: Partial<DeviceRuntime>) => {
    setRuntimes((prev) => {
      const existing = prev[udid]
      if (existing) return { ...prev, [udid]: { ...existing, ...patch } }
      // First write for this udid: promote the local slot's accumulated
      // state (rehydrated position, getStatus snapshot) into the new
      // entry so the derived primary view doesn't blank out the moment
      // the udid becomes known.
      const local = udid !== LOCAL_RUNTIME_KEY ? prev[LOCAL_RUNTIME_KEY] : undefined
      const base = local ? { ...local, udid } : emptyRuntime(udid)
      const next: RuntimesMap = { ...prev, [udid]: { ...base, ...patch } }
      // `next` is a fresh copy owned by this updater — removing the
      // promoted sentinel from it is not a mutation of shared state.
      if (local) delete next[LOCAL_RUNTIME_KEY]
      return next
    })
  }, [])

  const patchPrimaryRuntime = useCallback((patch: PrimaryRuntimePatch) => {
    setRuntimes((prev) => {
      const primary = primaryUdidRef.current
      const key = primary ?? Object.keys(prev)[0] ?? LOCAL_RUNTIME_KEY
      // First write for a known primary udid: promote the local slot, same
      // as `updateRuntime`, so the rehydrated position carries over.
      const local = !prev[key] && key !== LOCAL_RUNTIME_KEY ? prev[LOCAL_RUNTIME_KEY] : undefined
      const current = prev[key] ?? (local ? { ...local, udid: key } : emptyRuntime(key))
      const resolved = typeof patch === 'function' ? patch(current) : patch
      if (Object.keys(resolved).length === 0) return prev
      const next: RuntimesMap = { ...prev, [key]: { ...current, ...resolved } }
      if (local) delete next[LOCAL_RUNTIME_KEY]
      return next
    })
  }, [])

  return { runtimes, setRuntimes, updateRuntime, patchPrimaryRuntime }
}
