// Pure derivation of "what the user should see right now" given
// (transport state, device state, time). Lives outside React so it
// can be unit-tested without rendering anything.
//
// The naming mirrors `ConnectionHealthContext`: WsState describes the
// transport, DeviceHealth describes the domain, and the combined
// `ConnectionHealth` is what consumers consume.

export type WsState = 'open' | 'reconnecting' | 'offline'
export type DeviceHealth = 'connected' | 'lost' | 'none' | 'stale'
export type HealthHint = null | 'ws_reconnecting' | 'ws_offline' | 'ws_auth_failed' | 'device_lost'

export interface ConnectionHealth {
  ws: WsState
  device: DeviceHealth
  /** True iff it is safe to send a command right now (WS open AND a
   *  device is actually connected). Intended for disabling action
   *  buttons — consumers can trust a positive value. */
  canOperate: boolean
  /** The most-urgent human-facing condition worth surfacing. `null`
   *  when everything is healthy. */
  hint: HealthHint
}

// How long WS has to be down before the UI escalates from
// "reconnecting" (transient, probably fine) to "offline" (user should
// act). 10s covers most dev-mode HMR reconnects and backend restart;
// longer than that and we want to alarm.
export const OFFLINE_THRESHOLD_MS = 10_000

export interface DeriveInput {
  wsConnected: boolean
  /** The backend rejected the WS auth frame (close code 4001). Only
   *  consulted while WS is down. */
  wsAuthFailed?: boolean
  /** Timestamp (ms) when WS last transitioned open→closed. `null`
   *  when WS is currently open (or has never been down). */
  disconnectedAt: number | null
  /** Current time (ms). Pass `Date.now()` from the call site so the
   *  function stays pure and testable. */
  now: number
  connectedCount: number
  lostCount: number
  /** Override for tests; defaults to `OFFLINE_THRESHOLD_MS`. */
  offlineThresholdMs?: number
}

export function deriveConnectionHealth(input: DeriveInput): ConnectionHealth {
  const { wsConnected, disconnectedAt, now, connectedCount, lostCount } = input
  const threshold = input.offlineThresholdMs ?? OFFLINE_THRESHOLD_MS

  let ws: WsState
  if (wsConnected) {
    ws = 'open'
  } else {
    const offlineMs = disconnectedAt == null ? 0 : Math.max(0, now - disconnectedAt)
    ws = offlineMs >= threshold ? 'offline' : 'reconnecting'
  }

  let device: DeviceHealth
  if (ws !== 'open' && connectedCount > 0) {
    device = 'stale'
  } else if (connectedCount > 0) {
    device = 'connected'
  } else if (lostCount > 0) {
    device = 'lost'
  } else {
    device = 'none'
  }

  const canOperate = ws === 'open' && device === 'connected'

  // Severity order: WS outage dominates (nothing works), then device
  // loss. Consumers showing a single banner can just read `hint`.
  let hint: HealthHint = null
  // An auth rejection won't fix itself by waiting, so it replaces the
  // generic reconnecting/offline copy with an actionable one.
  if (ws !== 'open' && input.wsAuthFailed) hint = 'ws_auth_failed'
  else if (ws === 'offline') hint = 'ws_offline'
  else if (ws === 'reconnecting') hint = 'ws_reconnecting'
  else if (device === 'lost') hint = 'device_lost'

  return { ws, device, canOperate, hint }
}
