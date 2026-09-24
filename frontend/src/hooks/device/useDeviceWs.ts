/**
 * WebSocket dispatcher for device-state events.
 *
 * Subscribes to the shared WS stream and routes the three device-lifecycle
 * events — `device_connected`, `device_disconnected`, `device_reconnected` —
 * into the parent `useDevice` hook's state.
 *
 * Owns no state itself: receives a setters bundle via ref so the subscribe
 * effect's dep list stays `[subscribe]` and the WS stream isn't torn down
 * on every parent re-render. Mirrors the pattern in `sim/useSimWsDispatcher`.
 *
 * The bundled `bumpWsGen` is invoked on every WS-driven state change so
 * the REST flows in `useDevice` (scan / connect / forget) can detect
 * "did a WS event race past me while I was awaiting?" and skip the
 * post-await apply when so.
 */

import { useEffect, useRef } from 'react'
import {
  isInvoluntaryDisconnect,
  parseDeviceConnected,
  parseDeviceDisconnected,
  parseDeviceError,
  parseDeviceSnapshot,
} from './parsers'
import type { DeviceInfo, DeviceLostCause, WsSubscribe } from './parsers'

export interface DeviceLastDisconnect {
  readonly udids: readonly string[]
  readonly cause: DeviceLostCause
  // Wall-clock ms — App.tsx watches this for changes to fire a one-shot
  // toast. Pinned to a fresh `Date.now()` per event so identical
  // back-to-back disconnects (same udids + cause) still re-trigger.
  readonly ts: number
}

export interface DeviceLastError {
  readonly udid: string | null
  readonly stage: string
  readonly error: string
  // Machine-readable tag for errors with a dedicated toast
  // (currently only 'route_unavailable'); undefined for generic crashes.
  readonly code?: string
  // Wall-clock ms — same one-shot-toast trigger discipline as
  // DeviceLastDisconnect.ts.
  readonly ts: number
}

export interface DeviceWsSetters {
  setDevices: React.Dispatch<React.SetStateAction<DeviceInfo[]>>
  setConnectedDevice: React.Dispatch<React.SetStateAction<DeviceInfo | null>>
  setLostUdids: React.Dispatch<React.SetStateAction<Set<string>>>
  setLastDisconnect: React.Dispatch<React.SetStateAction<DeviceLastDisconnect | null>>
  setLastDeviceError: React.Dispatch<React.SetStateAction<DeviceLastError | null>>
  bumpWsGen: () => void
}

export function useDeviceWs(
  subscribe: WsSubscribe | undefined,
  setters: DeviceWsSetters,
): void {
  // Keep the latest setters bag in a ref so the subscribe effect doesn't
  // need them in its deps — mirrors useSimWsDispatcher.
  const settersRef = useRef(setters)
  useEffect(() => { settersRef.current = setters }, [setters])

  // React to real-time device state broadcasts via the subscribe callback.
  // See useWebSocket.ts for the rationale vs the old useState pattern.
  //
  // We update `devices` from the broadcast payload directly rather than
  // re-fetching /api/device/list. Every event that reaches this handler
  // already carries the udid + (for connect) name / ios_version /
  // connection_type, which is enough to keep the list in sync. An
  // earlier revision re-fetched after every event; in dev with multiple
  // WS clients that produced dozens of /api/device/list requests per
  // second. If a field we don't receive here is needed (e.g.
  // developer_mode_enabled), fetch it lazily at the point of use.
  useEffect(() => {
    if (!subscribe) return
    return subscribe((msg) => {
      const s = settersRef.current
      if (msg.type === 'device_disconnected') {
        s.bumpWsGen()
        // Group mode: only mark the specific udid disconnected when provided;
        // fall back to clearing all for legacy single-device disconnect events.
        const payload = parseDeviceDisconnected(msg.data)
        const udids: readonly string[] = payload.udids ?? (payload.udid ? [payload.udid] : [])
        // Deliberate disconnects (user, forget, hard reset, USB→WiFi
        // fallback) don't warrant a "lost" pill or toast.
        const involuntary = isInvoluntaryDisconnect(payload.reason)
        if (involuntary) {
          // Surface the cause one level up so App.tsx can pick a
          // root-cause-specific toast. Independent of `lostUdids` (which
          // is a Set of udids for pill rendering); same trigger, different
          // shape.
          s.setLastDisconnect({
            udids,
            cause: payload.cause ?? 'unknown',
            ts: Date.now(),
          })
        }
        if (udids.length === 0) {
          s.setConnectedDevice(null)
          s.setDevices((prev) => {
            if (involuntary) {
              const prevConnected = prev.filter((d) => d.is_connected).map((d) => d.udid)
              if (prevConnected.length > 0) {
                s.setLostUdids((ls) => { const n = new Set(ls); prevConnected.forEach((u) => n.add(u)); return n })
              }
            }
            return prev.map((d) => ({ ...d, is_connected: false }))
          })
        } else {
          s.setDevices((prev) => prev.map((d) => udids.includes(d.udid) ? { ...d, is_connected: false } : d))
          s.setConnectedDevice((prev) => (prev && udids.includes(prev.udid)) ? null : prev)
          if (involuntary) {
            s.setLostUdids((ls) => { const n = new Set(ls); udids.forEach((u) => n.add(u)); return n })
          }
        }
      } else if (msg.type === 'device_connected') {
        const payload = parseDeviceConnected(msg.data)
        if (!payload) return
        s.bumpWsGen()
        const incoming: DeviceInfo = {
          udid: payload.udid,
          name: payload.name ?? '',
          ios_version: payload.ios_version ?? '',
          connection_type: payload.connection_type ?? 'USB',
          is_connected: true,
        }
        // `merged` holds the post-update entry for this udid; we thread
        // the same reference into both `devices` and `connectedDevice`
        // so consumers can't observe a split where one has
        // `developer_mode_*` fields and the other doesn't.
        let merged: DeviceInfo = incoming
        s.setDevices((prev) => {
          const idx = prev.findIndex((d) => d.udid === payload.udid)
          if (idx === -1) {
            merged = incoming
            return [...prev, incoming]
          }
          const existing = prev[idx]
          // Short-circuit: if every visible field already matches, keep
          // the existing reference so downstream useMemo / render trees
          // don't invalidate on a no-op re-broadcast.
          if (
            existing.is_connected &&
            existing.name === incoming.name &&
            existing.ios_version === incoming.ios_version &&
            existing.connection_type === incoming.connection_type
          ) {
            merged = existing
            return prev
          }
          // Preserve developer_mode_* fields we may already have cached
          // from an earlier scan — they aren't in the broadcast payload.
          merged = { ...existing, ...incoming }
          const next = prev.slice()
          next[idx] = merged
          return next
        })
        s.setConnectedDevice((prev) => prev ?? merged)
        s.setLostUdids((ls) => { if (!ls.has(payload.udid)) return ls; const n = new Set(ls); n.delete(payload.udid); return n })
      } else if (msg.type === 'device_snapshot') {
        // Authoritative ground-truth from the server (sent on every WS
        // connect via _send_initial_state). Replaces the local list so
        // any phantom "connected" entries left over from before a
        // reconnect — e.g. a WiFi tunnel that died while we were offline
        // — are cleared in one shot. Treats the snapshot as a delta-zero:
        // anything not in `devices` is_connected=false.
        const payload = parseDeviceSnapshot(msg.data)
        if (!payload) return
        s.bumpWsGen()
        const incoming = new Map<string, DeviceInfo>()
        for (const e of payload.devices) {
          incoming.set(e.udid, {
            udid: e.udid,
            name: e.name ?? '',
            ios_version: e.ios_version ?? '',
            connection_type: e.connection_type ?? 'USB',
            is_connected: true,
          })
        }
        s.setDevices((prev) => {
          // Preserve existing developer_mode_* fields where the udid
          // overlaps — the snapshot deliberately doesn't carry them
          // (broadcast payload stays small).
          const next: DeviceInfo[] = []
          const seen = new Set<string>()
          for (const d of prev) {
            const fresh = incoming.get(d.udid)
            if (fresh) {
              next.push({ ...d, ...fresh })
              seen.add(d.udid)
            } else {
              // Not in snapshot → mark disconnected, keep entry so the
              // "previously connected" pill can show until a fresh scan.
              next.push({ ...d, is_connected: false })
            }
          }
          for (const [udid, fresh] of incoming) {
            if (!seen.has(udid)) next.push(fresh)
          }
          return next
        })
        s.setConnectedDevice((prev) => {
          if (prev && incoming.has(prev.udid)) {
            return { ...prev, ...incoming.get(prev.udid)! }
          }
          // Promote any snapshot entry to primary if we had no prior pick.
          if (!prev) {
            const first = payload.devices[0]
            return first
              ? {
                  udid: first.udid,
                  name: first.name ?? '',
                  ios_version: first.ios_version ?? '',
                  connection_type: first.connection_type ?? 'USB',
                  is_connected: true,
                }
              : null
          }
          // Prior connectedDevice no longer in snapshot — drop it.
          return null
        })
        // Snapshot proves these udids are actively connected — so they
        // can't be "lost". Clear them from the lost set in one pass.
        if (incoming.size > 0) {
          s.setLostUdids((ls) => {
            if (ls.size === 0) return ls
            let changed = false
            const next = new Set(ls)
            for (const udid of incoming.keys()) {
              if (next.delete(udid)) changed = true
            }
            return changed ? next : ls
          })
        }
      } else if (msg.type === 'device_error') {
        // Backend-side engine/transport setup failure (e.g. the USB-fallback
        // engine-creation path in api/tunnel/lifecycle.py). Surface it as a
        // one-shot signal App.tsx turns into a toast — mirrors
        // setLastDisconnect. Without a handler this event is fanned out to
        // every subscriber and silently ignored, so the user gets no
        // feedback that the device never came up.
        const payload = parseDeviceError(msg.data)
        if (payload) {
          s.setLastDeviceError({
            udid: payload.udid ?? null,
            stage: payload.stage ?? 'unknown',
            error: payload.error ?? '',
            code: payload.code,
            ts: Date.now(),
          })
        }
      }
      // `device_reconnected` was a legacy event — the usbmux watchdog
      // now emits `device_connected` after a re-plug. Handler removed
      // to match the WS event registry (backend/models/ws_events.py).
    })
  }, [subscribe])
}
