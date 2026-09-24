/**
 * WebSocket dispatcher for simulation events.
 *
 * Subscribes to the shared WS stream and routes ~24 backend event types
 * into a SINGLE write path:
 *
 *   - Per-device state (position, route, engine state, progress, ETA,
 *     tunnel health) goes into the `runtimes` map. Frames tagged with a
 *     udid target that device's slot; untagged frames target the primary
 *     slot (the primary device's entry, falling back to the reserved
 *     local slot — see `useSimRuntimes`). The legacy single-device view in
 *     `useSimulation` is DERIVED from the primary runtime, so writing
 *     the runtime is sufficient to update every consumer.
 *   - Session-global state that has no per-device meaning (pause
 *     countdown, waypoint/lap overlays, DDI mount progress, the error
 *     banner, the backend-sync flag) keeps dedicated setters — each of
 *     those datums has exactly one home, so this is still one path per
 *     datum.
 *   - `destination` is USER-INPUT state owned by `useSimulation`; the
 *     dispatcher only CLEARS it (on run completion / idle), mirroring
 *     the same clear applied to the runtime entry.
 *
 * The dispatcher itself owns no state; it accepts a bundle of setters
 * via a ref so the subscribe effect's deps stay `[subscribe]` and the
 * WS stream isn't torn down on every parent re-render. State setters
 * from `useState` are stable identity-wise, so the ref approach is
 * defensive but cheap.
 */

import { useEffect, useRef } from 'react'
import type { DdiMissingSignal, DdiMountingState } from '../useSimulation'
import { asNumber, asObject, asString } from '../../lib/ws-guards'
import type { LatLng } from './types'
import type { DeviceRuntime, RuntimesMap } from './useSimRuntimes'
import type { WsMessage } from '../useWebSocket'
import type {
  DdiMountMissingEvent,
  LapCompleteEvent,
  PauseCountdownEvent,
  PositionUpdateEvent,
  RoutePathEvent,
  StateChangeEvent,
  WaypointProgressEvent,
  WsEventType,
} from '../../generated/api-contract'

// ── Typed WS payloads ──────────────────────────────────────────────────
// Parsers return the codegen'd contract shapes (`Partial<…>` because each
// field is runtime-guarded and may be dropped), so a backend field rename
// surfaces as a TypeScript error here.

function parsePositionUpdate(data: unknown): Partial<PositionUpdateEvent> | null {
  const o = asObject(data)
  if (!o) return null
  return {
    udid: asString(o.udid),
    lat: asNumber(o.lat),
    lng: asNumber(o.lng),
    progress: asNumber(o.progress),
    eta_seconds: asNumber(o.eta_seconds),
    distance_remaining: asNumber(o.distance_remaining),
    distance_traveled: asNumber(o.distance_traveled),
    speed_mps: asNumber(o.speed_mps),
  }
}

function parseRoutePath(data: unknown): Partial<RoutePathEvent> | null {
  const o = asObject(data)
  if (!o) return null
  return {
    udid: asString(o.udid),
    coords: Array.isArray(o.coords) ? o.coords as RoutePathEvent['coords'] : undefined,
  }
}

function parseStateChange(data: unknown): Partial<StateChangeEvent> | null {
  const o = asObject(data)
  if (!o) return null
  return { udid: asString(o.udid), state: asString(o.state) }
}

function parseWaypointProgress(data: unknown): Partial<WaypointProgressEvent> | null {
  const o = asObject(data)
  if (!o) return null
  return {
    udid: asString(o.udid),
    current_index: asNumber(o.current_index),
    next_index: asNumber(o.next_index),
    total: asNumber(o.total),
  }
}

function parseLapComplete(data: unknown): Partial<LapCompleteEvent> | null {
  const o = asObject(data)
  if (!o) return null
  return { lap: asNumber(o.lap), total: asNumber(o.total) }
}

function parsePauseCountdown(data: unknown): Partial<PauseCountdownEvent> | null {
  const o = asObject(data)
  if (!o) return null
  return { duration_seconds: asNumber(o.duration_seconds) }
}

function parseDdiMountMissing(data: unknown): Partial<DdiMountMissingEvent> {
  const o = asObject(data) ?? {}
  return {
    reason: asString(o.reason),
    stage: asString(o.stage),
    udid: asString(o.udid),
    hint_key: asString(o.hint_key),
  }
}

function extractUdid(data: unknown): string | undefined {
  const o = asObject(data)
  return o ? asString(o.udid) : undefined
}

// Coerce a tuple/object polyline point into LatLng. Used when a route_path
// payload carries [lat, lng] arrays instead of {lat, lng} objects.
function coordOf(p: unknown): LatLng {
  if (Array.isArray(p)) return { lat: p[0] as number, lng: p[1] as number }
  const po = asObject(p) ?? {}
  return { lat: asNumber(po.lat) ?? 0, lng: asNumber(po.lng) ?? 0 }
}

// ── Public hook ────────────────────────────────────────────────────────

export type WsSubscribe = (fn: (m: WsMessage) => void) => () => void

// SimErrorCode tags an error surface this hook hands to consumers via
// `localizeError`. Currently the only real producer is the `tunnel_lost`
// WS handler below — anchored to the generated `WsEventType` union so a
// backend rename/removal propagates as a TypeScript error here instead
// of a silent miss.
export type SimErrorCode = Extract<WsEventType, 'tunnel_lost'>

export interface SimulationStatus {
  running: boolean
  paused: boolean
  speed: number
  state?: string
  distance_remaining?: number
  distance_traveled?: number
}

/**
 * Bundle of setters the dispatcher writes to. All entries should come
 * from `useState` or stable `useCallback` so identity stays put across
 * renders — the dispatcher captures this object via a ref each render
 * and the WS subscribe effect itself only depends on `subscribe`.
 */
export interface SimWsSetters {
  // Per-device runtime — the single home for device simulation state.
  setRuntimes: React.Dispatch<React.SetStateAction<RuntimesMap>>
  updateRuntime: (udid: string, patch: Partial<DeviceRuntime>) => void
  /** Target for udid-less frames: primary device's entry or the local slot. */
  patchPrimaryRuntime: (patch: Partial<DeviceRuntime>) => void
  // Session-global state with no per-device counterpart.
  setBackendPositionSynced: React.Dispatch<React.SetStateAction<boolean>>
  /** User-input destination; the dispatcher only clears it. */
  setDestination: React.Dispatch<React.SetStateAction<LatLng | null>>
  setPauseEndAt: React.Dispatch<React.SetStateAction<number | null>>
  setWaypointProgress: React.Dispatch<
    React.SetStateAction<{ current: number; next: number; total: number } | null>
  >
  setLapProgress: React.Dispatch<
    React.SetStateAction<{ current: number; total: number | null } | null>
  >
  setDdiMounting: React.Dispatch<React.SetStateAction<DdiMountingState>>
  setDdiMissing: React.Dispatch<React.SetStateAction<DdiMissingSignal | null>>
  setError: React.Dispatch<React.SetStateAction<string | null>>
  localizeError: (code: SimErrorCode) => string
  /** Primary device udid (null when unknown). The session-global run
   *  overlays (pause countdown, lap / waypoint progress) only follow
   *  frames from this device, so a second phone in group mode can't
   *  overwrite or clear them. */
  getPrimaryUdid: () => string | null
}

/**
 * Wire incoming WS messages into the simulation state setters. Returns
 * nothing — the hook only owns the subscribe effect.
 */
export function useSimWsDispatcher(
  subscribe: WsSubscribe | undefined,
  setters: SimWsSetters,
): void {
  // Keep the latest setters bag in a ref so the subscribe effect doesn't
  // need them in its deps (which would otherwise tear down + rebuild the
  // WS subscription on every parent render).
  const settersRef = useRef(setters)
  useEffect(() => { settersRef.current = setters }, [setters])

  useEffect(() => {
    if (!subscribe) return
    return subscribe((wsMessage) => {
      const s = settersRef.current
      const udid = extractUdid(wsMessage.data)

      // Route a runtime patch to the udid's slot, or to the primary /
      // local slot when the frame carries no udid (the backend tags all
      // engine emissions, so the udid-less path is defensive).
      const patchRuntime = (patch: Partial<DeviceRuntime>) => {
        if (udid) s.updateRuntime(udid, patch)
        else s.patchPrimaryRuntime(patch)
      }
      // Whether this frame may write the session-global run overlays.
      // Untagged frames and an unknown primary keep single-device behavior.
      const primaryUdid = s.getPrimaryUdid()
      const fromPrimary = !udid || !primaryUdid || udid === primaryUdid

      switch (wsMessage.type) {
        case 'position_update': {
          const d = parsePositionUpdate(wsMessage.data)
          if (!d) break
          // Only include a key when the incoming payload carries it,
          // so a tick without `eta_seconds` doesn't wipe the cached value.
          const patch: Partial<DeviceRuntime> = {}
          if (d.lat != null && d.lng != null) {
            patch.currentPos = { lat: d.lat, lng: d.lng }
            // A real device coordinate arrived — the backend engine and
            // the UI pin are in sync (session-global flag).
            s.setBackendPositionSynced(true)
          }
          if (d.progress != null) patch.progress = d.progress
          if (d.eta_seconds != null) patch.eta = d.eta_seconds
          if (d.distance_remaining != null) patch.distanceRemaining = d.distance_remaining
          if (d.distance_traveled != null) patch.distanceTraveled = d.distance_traveled
          if (d.speed_mps != null) patch.currentSpeedKmh = d.speed_mps * 3.6
          if (Object.keys(patch).length > 0) patchRuntime(patch)
          break
        }
        case 'route_path': {
          const d = parseRoutePath(wsMessage.data)
          if (d?.coords) {
            patchRuntime({ routePath: d.coords.map(coordOf) })
          }
          break
        }
        case 'state_change': {
          const st = parseStateChange(wsMessage.data)?.state
          if (!st) break
          if (st === 'idle' || st === 'disconnected') {
            // Run torn down: clear the route, ETA, and destination in the
            // runtime. routePath was always cleared here; eta/destination
            // clearing is the legacy single-device behavior folded into
            // the runtime now that it feeds the UI directly.
            patchRuntime({ state: st, routePath: [], eta: null, destination: null })
            // The user-input destination marker follows the same clear.
            s.setDestination(null)
          } else {
            patchRuntime({ state: st })
          }
          break
        }
        case 'device_connected': {
          // `device_connected` is the authoritative "fresh connection"
          // signal — a hard-reset reconnect cycle does NOT re-emit
          // `tunnel_recovered`, so any stale `tunnelDegraded` left over
          // from before the disconnect must be cleared here. Without
          // this the left chip sticks at "重連中" even after the right
          // card flips to "已連線". udid-gated: an untagged frame has
          // no device to seed.
          if (udid) {
            s.updateRuntime(udid, { tunnelDegraded: false })
            s.setError(null)
          }
          break
        }
        case 'device_disconnected': {
          // Device leaves the connected pool — chip switches to
          // "已斷線" via `device.connectedDevices`. Reset transient
          // tunnel-degraded so the next reconnect doesn't inherit it.
          // The derived single-device status reads running/paused=false
          // from the 'disconnected' state. (User-facing notice is a
          // toast fired by App.tsx off device.lastDisconnect.)
          patchRuntime({ state: 'disconnected', tunnelDegraded: false })
          break
        }
        case 'multi_stop_complete':
        case 'navigation_complete':
        case 'random_walk_complete': {
          // Run finished — collapse the dock back to idle. `state_change`
          // → 'idle' arrives separately and clears running/routePath;
          // this case clears the per-run progress overlays those don't
          // touch. eta/destination clearing matches the legacy
          // single-device behavior, now applied to the runtime since the
          // runtime is the single source feeding the UI.
          patchRuntime({ progress: 1, state: 'idle', eta: null, destination: null })
          if (fromPrimary) {
            s.setPauseEndAt(null)
            s.setWaypointProgress(null)
            s.setLapProgress(null)
            s.setDestination(null)
          }
          break
        }
        case 'waypoint_progress': {
          const d = parseWaypointProgress(wsMessage.data)
          if (d?.current_index != null) {
            patchRuntime({ waypointIndex: d.current_index })
            if (fromPrimary) s.setWaypointProgress({
              current: d.current_index,
              next: d.next_index ?? d.current_index + 1,
              total: d.total ?? 0,
            })
          }
          break
        }
        case 'lap_complete': {
          const d = parseLapComplete(wsMessage.data)
          if (d?.lap != null && fromPrimary) {
            s.setLapProgress({
              current: d.lap,
              total: d.total ?? null,
            })
          }
          break
        }
        case 'ddi_mounting': {
          // `downloading` precedes `mounting` when the image isn't cached;
          // frames without a stage (older backends) mean mounting.
          const stage = asString(asObject(wsMessage.data)?.stage)
          s.setDdiMounting(stage === 'downloading' ? 'downloading' : 'mounting')
          break
        }
        case 'ddi_mounted': {
          s.setDdiMounting(false)
          break
        }
        case 'ddi_mount_failed': {
          // Mount attempt failed outright. Was previously silent (only
          // cleared the overlay); now emits the same missing signal so the
          // persistent DDI-failed banner surfaces a manual-mount hint.
          // The backend sends this right after ddi_mount_missing with the
          // same payload, so carry the structured fields through instead of
          // overwriting a specific reason (e.g. Developer Mode off) with
          // the generic one.
          s.setDdiMounting(false)
          const d = parseDdiMountMissing(wsMessage.data)
          s.setDdiMissing({
            reason: d.reason ?? 'mount_failed',
            stage: d.stage,
            udid: d.udid,
            hintKey: d.hint_key,
            ts: Date.now(),
          })
          break
        }
        case 'ddi_mount_missing': {
          // Auto-mount failed. App surfaces a persistent, dismissible banner
          // (not a transient toast) so the hint isn't overwritten by an
          // unrelated toast.
          s.setDdiMounting(false)
          const d = parseDdiMountMissing(wsMessage.data)
          s.setDdiMissing({
            reason: d.reason ?? 'unknown',
            stage: d.stage,
            udid: d.udid,
            hintKey: d.hint_key,
            ts: Date.now(),
          })
          break
        }
        case 'tunnel_lost': {
          s.setError(s.localizeError('tunnel_lost'))
          break
        }
        case 'tunnel_degraded':
        case 'tunnel_recovered': {
          // Backend emits these around a DVT channel drop / liveness probe
          // miss. The `udid` field (optional in the contract) targets one
          // device when known; otherwise we apply the hint to every runtime
          // so the "reconnecting" chip pulse shows up even in single-device
          // mode where the emit doesn't carry a UDID.
          const degraded = wsMessage.type === 'tunnel_degraded'
          if (udid) {
            s.updateRuntime(udid, { tunnelDegraded: degraded })
          } else {
            s.setRuntimes((prev) => {
              let changed = false
              const next: RuntimesMap = {}
              for (const [k, v] of Object.entries(prev)) {
                if (v.tunnelDegraded !== degraded) {
                  next[k] = { ...v, tunnelDegraded: degraded }
                  changed = true
                } else {
                  next[k] = v
                }
              }
              return changed ? next : prev
            })
          }
          break
        }
        // `device_reconnected` removed — the watchdog now emits
        // `device_connected` after a re-plug, which clears the error
        // via the existing case above.
        case 'pause_countdown': {
          const d = parsePauseCountdown(wsMessage.data)
          const dur = d?.duration_seconds
          if (typeof dur === 'number' && dur > 0 && fromPrimary) {
            s.setPauseEndAt(Date.now() + dur * 1000)
          }
          break
        }
        case 'pause_countdown_end': {
          if (fromPrimary) s.setPauseEndAt(null)
          break
        }
      }
    })
  }, [subscribe])
}
