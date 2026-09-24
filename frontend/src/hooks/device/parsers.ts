/**
 * Pure parsers + types for the device hooks.
 *
 * Zero React, zero state. The backend emits a small stable subset of
 * udid-tagged WS events; these guards narrow the `unknown`-typed
 * `WsMessage.data` once at the entry point so the rest of the
 * subscriber reads payloads as plain TypeScript.
 *
 * Reason for not using `as any` here: silent payload drift (e.g.
 * backend renaming `udid` → `device_id`) was previously invisible to
 * TS — these guards make such drift surface at the parse boundary.
 */

import type { WsMessage } from '../useWebSocket'
import type { DeviceInfo } from '../../types/device'
import { asObject, asString, asStringArray } from '../../lib/ws-guards'

// DeviceInfo lives in types/device.ts (neutral module shared with the
// services layer); re-exported here so existing consumer imports keep working.
export type { DeviceInfo } from '../../types/device'

export type WsSubscribe = (fn: (m: WsMessage) => void) => () => void

export interface DeviceConnectedPayload {
  udid: string
  name?: string
  ios_version?: string
  connection_type?: string
}

export type DeviceLostCause =
  | 'unknown'
  | 'usb_removed'
  | 'wifi_dropped'
  | 'phone_locked'
  | 'ddi_not_mounted'

const DEVICE_LOST_CAUSES: readonly DeviceLostCause[] = [
  'unknown', 'usb_removed', 'wifi_dropped', 'phone_locked', 'ddi_not_mounted',
]

function asDeviceLostCause(v: unknown): DeviceLostCause | undefined {
  return typeof v === 'string' && (DEVICE_LOST_CAUSES as readonly string[]).includes(v)
    ? v as DeviceLostCause
    : undefined
}

export interface DeviceDisconnectedPayload {
  udid?: string
  udids?: readonly string[]
  // The backend sends its transition cause under both `reason` and
  // `cause` (connection_state._ws_observer). Deliberate values are
  // listed in VOLUNTARY_DISCONNECT_REASONS; everything else is a loss.
  reason?: string
  // Narrowed to the causes that have a dedicated toast; any other value
  // (including the deliberate ones) parses to undefined.
  cause?: DeviceLostCause
}

/**
 * Disconnect reasons the app or user caused on purpose: the explicit
 * disconnect button, "forget device", an engine hard reset (reconnects
 * right away) and the USB→WiFi fallback hop. None of these get a
 * "device lost" toast or the red disconnected pill.
 */
const VOLUNTARY_DISCONNECT_REASONS: ReadonlySet<string> = new Set([
  'user',
  'forget',
  'hard_reset',
  'usb_removed_pre_wifi_fallback',
])

export function isInvoluntaryDisconnect(reason: string | undefined): boolean {
  return reason == null || !VOLUNTARY_DISCONNECT_REASONS.has(reason)
}

export interface DeviceSnapshotEntry {
  udid: string
  name?: string
  ios_version?: string
  connection_type?: string
}

export interface DeviceSnapshotPayload {
  devices: readonly DeviceSnapshotEntry[]
}

export function parseDeviceConnected(data: unknown): DeviceConnectedPayload | null {
  const obj = asObject(data)
  if (!obj) return null
  const udid = asString(obj.udid)
  if (!udid) return null
  return {
    udid,
    name: asString(obj.name),
    ios_version: asString(obj.ios_version),
    connection_type: asString(obj.connection_type),
  }
}

export function parseDeviceDisconnected(data: unknown): DeviceDisconnectedPayload {
  const obj = asObject(data) ?? {}
  return {
    udid: asString(obj.udid),
    udids: asStringArray(obj.udids),
    reason: asString(obj.reason),
    cause: asDeviceLostCause(obj.cause),
  }
}

export interface DeviceErrorPayload {
  udid?: string
  stage?: string
  error?: string
  code?: string
}

export function parseDeviceError(data: unknown): DeviceErrorPayload | null {
  const obj = asObject(data)
  if (!obj) return null
  return {
    udid: asString(obj.udid),
    stage: asString(obj.stage),
    error: asString(obj.error),
    code: asString(obj.code),
  }
}

export function parseDeviceSnapshot(data: unknown): DeviceSnapshotPayload | null {
  const obj = asObject(data)
  if (!obj) return null
  const raw = obj.devices
  if (!Array.isArray(raw)) return null
  const devices: DeviceSnapshotEntry[] = []
  for (const entry of raw) {
    const e = asObject(entry)
    if (!e) continue
    const udid = asString(e.udid)
    if (!udid) continue
    devices.push({
      udid,
      name: asString(e.name),
      ios_version: asString(e.ios_version),
      connection_type: asString(e.connection_type),
    })
  }
  return { devices }
}

export function deviceListEqual(a: readonly DeviceInfo[], b: readonly DeviceInfo[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (
      x.udid !== y.udid ||
      x.name !== y.name ||
      x.ios_version !== y.ios_version ||
      x.connection_type !== y.connection_type ||
      x.is_connected !== y.is_connected ||
      x.developer_mode_enabled !== y.developer_mode_enabled ||
      x.can_reveal_developer_mode !== y.can_reveal_developer_mode
    ) return false
  }
  return true
}
