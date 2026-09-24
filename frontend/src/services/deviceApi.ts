/** Device discovery / pairing / WiFi-tunnel endpoints (`/api/device/*`). */
import { DEFAULT_TUNNEL_PORT, FAST_FAIL_REQUEST } from '../lib/constants'
import type { DeviceInfo } from '../types/device'
import { request, type StatusResponse } from './http'

export interface WifiTunnelStatus {
  running: boolean
  ip?: string
  port?: number
  rsd_address?: string
  rsd_port?: number
}

/** `fast`: fail within a few seconds when the backend is down or wedged
 *  (manual scan), instead of the default ~25 s retry / 130 s timeout. */
export const listDevices = (opts?: { fast?: boolean }) =>
  request<DeviceInfo[]>('GET', '/api/device/list', undefined, undefined, opts?.fast ? FAST_FAIL_REQUEST : undefined)
export const connectDevice = (udid: string) => request<StatusResponse>('POST', `/api/device/${udid}/connect`)
export const disconnectDevice = (udid: string) => request<StatusResponse>('DELETE', `/api/device/${udid}/connect`)
export const forgetDevice = (udid: string) =>
  request<{
    status: string
    udid: string
    // True when the device-side unpair (lockdownd Unpair over USB) went
    // through. Best-effort — only possible when the device is connected
    // and unlocked.
    device_unpaired?: boolean
    // True when usbmuxd deleted its stored host pair record
    // (DeletePairRecord). This is the authoritative "forget" and works
    // even when the device is on WiFi, unplugged, or locked — so a
    // "forgotten" status with this true is a full success regardless of
    // device_unpaired or the local-file result below.
    usbmux_record_deleted?: boolean
    removed: string[]
    // Populated when at least one pair-record path could not be unlinked
    // (e.g. /var/db/lockdown is OS-protected on macOS). Non-fatal when
    // device_unpaired is true; otherwise the backend returns status
    // "partial" and the UI can warn that the host is still trusted.
    failed?: { path: string; error: string }[]
  }>('DELETE', `/api/device/${udid}/pair`)
export interface WifiConnectResponse {
  status: string
  udid: string
  name: string
  ios_version: string
  connection_type?: string
}
export const wifiTunnelStartAndConnect = (ip: string, port = DEFAULT_TUNNEL_PORT, udid?: string) =>
  request<WifiConnectResponse & WifiTunnelStatus>('POST', '/api/device/wifi/tunnel/start-and-connect', { ip, port, ...(udid ? { udid } : {}) })
export const wifiTunnelStatus = () => request<WifiTunnelStatus>('GET', '/api/device/wifi/tunnel/status')
export const wifiTunnelDiscover = () => request<{ devices: { ip: string; port: number; host: string; name: string }[] }>('GET', '/api/device/wifi/tunnel/discover')
export const wifiTunnelStop = () => request<StatusResponse>('POST', '/api/device/wifi/tunnel/stop')
export const wifiRepair = () => request<{ status: string; udid: string; name: string; ios_version: string; remote_record_regenerated: boolean }>('POST', '/api/device/wifi/repair')
export const retryDdiMount = (udid: string) =>
  request<{ status: string; udid: string }>('POST', `/api/device/${encodeURIComponent(udid)}/ddi/retry`)
export const revealDeveloperMode = (udid: string) =>
  request<{ status: string; udid: string }>(
    'POST',
    `/api/device/${encodeURIComponent(udid)}/amfi/reveal-developer-mode`,
  )
