import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Check, Loader2, Plus, Scan, Settings as SettingsIcon, XCircle,
} from 'lucide-react'
import { useDeviceContext } from '../../contexts/DeviceContext'
import { useSimState } from '../../contexts/SimContext'
import { useToastContext } from '../../contexts/ToastContext'
import { useT } from '../../i18n'
import { DeviceAvatar, DeviceInfoColumn, getDeviceMeta, getDeviceRowStatus } from './deviceRowParts'
import type { DeviceRowStatus } from './deviceRowParts'
import type { StringKey } from '../../i18n'

// How long the "Found N" / "Not found" pill stays visible after a scan
// completes, before reverting to the default Scan label.
const SCAN_RESULT_VISIBLE_MS = 2000

const STATUS_LABEL: Record<DeviceRowStatus, StringKey> = {
  unsupported: 'device.status_unsupported',
  reconnecting: 'device.chip_state_reconnecting',
  connected: 'device.chip_state_idle',
  connected_secondary: 'device.status_connected_secondary',
  lost: 'device.chip_state_disconnected',
  not_connected: 'device.status_not_connected',
  ready: 'device.status_ready',
}

// Text colour and dot colour per status. Connected rows (primary or
// secondary) get the green glow; a degraded tunnel uses the same amber as
// the MiniStatusBar pill.
const IDLE_DOT = 'rgba(255,255,255,0.35)'
const STATUS_COLOR: Record<DeviceRowStatus, { text: string; dot: string; glow: boolean }> = {
  unsupported: { text: 'var(--color-error-text)', dot: 'var(--color-danger)', glow: false },
  lost: { text: 'var(--color-error-text)', dot: 'var(--color-danger)', glow: false },
  reconnecting: { text: 'var(--color-device-paused)', dot: 'var(--color-device-paused)', glow: false },
  connected: { text: 'var(--color-success-text)', dot: 'var(--color-success-text)', glow: true },
  connected_secondary: { text: 'var(--color-success-text)', dot: 'var(--color-success-text)', glow: true },
  not_connected: { text: 'var(--color-text-3)', dot: IDLE_DOT, glow: false },
  ready: { text: 'var(--color-text-3)', dot: IDLE_DOT, glow: false },
}

export interface DeviceListViewProps {
  // Called when a row is tapped and connect is initiated. The orchestrator
  // closes the popover so the user immediately sees the connection apply.
  onClose: () => void
  // Switch the orchestrator to the manage subview.
  onManage: () => void
  // Switch the orchestrator to the add subview.
  onAdd: () => void
}

export default function DeviceListView({ onClose, onManage, onAdd }: DeviceListViewProps) {
  const t = useT()
  const device = useDeviceContext()
  const { runtimes } = useSimState()
  const { showToast } = useToastContext()

  const [scanning, setScanning] = useState(false)
  // Device count from the last manual scan, 'error' when it couldn't reach
  // the backend, null when no result pill is showing.
  const [scanResult, setScanResult] = useState<number | 'error' | null>(null)
  const scanTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // UDID currently being connected — drives the per-row spinner and keeps the
  // popover open until connect resolves (was fire-and-forget + instant close,
  // which gave the user no progress / success / failure feedback).
  const [connectingUdid, setConnectingUdid] = useState<string | null>(null)

  useEffect(() => () => { if (scanTimer.current) clearTimeout(scanTimer.current) }, [])

  // Scan once, quietly, whenever the list opens: a phone plugged in since
  // the last poll shows up without pressing Scan (the backend deliberately
  // doesn't broadcast USB plug-ins). Pure observation — /api/device/list
  // never pairs or connects.
  const scanDevices = device.scan
  useEffect(() => {
    scanDevices({ poll: true }).catch(() => { /* logged inside scan */ })
  }, [scanDevices])

  const handleConnect = useCallback(async (udid: string) => {
    if (connectingUdid) return
    setConnectingUdid(udid)
    try {
      await device.connect(udid)
      onClose() // success — close so the applied connection is visible
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : ''
      // Connect pairs the device, which surfaces the on-device Trust prompt;
      // the most common failure is the user not having tapped Trust yet.
      showToast(msg || t('toast.connect_failed_trust'))
    } finally {
      setConnectingUdid(null)
    }
  }, [connectingUdid, device, onClose, showToast, t])

  const handleScan = useCallback(async () => {
    if (scanTimer.current) clearTimeout(scanTimer.current)
    setScanning(true)
    setScanResult(null)
    // Consume the awaited list directly — `device.devices` is updated
    // by a setState the React effect commits on the next render, so
    // reading it from a ref in `finally` would yield a stale count for
    // the freshly-scanned devices.
    let outcome: number | 'error' = 'error'
    try {
      const list = await device.scan()
      outcome = list.length
    } catch {
      // Backend unreachable / not ready — not the same as "no device".
    } finally {
      setScanning(false)
      setScanResult(outcome)
      scanTimer.current = setTimeout(() => setScanResult(null), SCAN_RESULT_VISIBLE_MS)
    }
  }, [device])

  const selectedUdid = device.primaryDevice?.udid
  const activeCount = device.devices.filter((d) => d.is_connected).length

  return (
    <>
      <div className="flex items-center justify-between px-4 pt-3.5 pb-2.5 border-b border-[var(--color-border-subtle)]">
        <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-text-3)]">
          {t('panel.devices')}{' '}
          <span className="font-mono text-[10px] text-[var(--color-text-3)] font-normal tracking-normal">
            ({t('device.scan_found', { n: activeCount })})
          </span>
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleScan}
            disabled={scanning}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-[var(--color-text-2)] hover:bg-white/[0.06] disabled:opacity-50 transition-colors"
            title={t('device.scan_tooltip')}
          >
            {scanning ? (
              <><Loader2 className="w-3 h-3 animate-spin" /> {t('device.scan_scanning')}</>
            ) : scanResult === 'error' ? (
              <><XCircle className="w-3 h-3 text-[var(--color-error-text)]" /> {t('device.scan_backend_not_ready')}</>
            ) : scanResult != null && scanResult > 0 ? (
              <><Check className="w-3 h-3 text-[var(--color-success-text)]" /> {t('device.scan_found', { n: scanResult })}</>
            ) : scanResult === 0 ? (
              <><XCircle className="w-3 h-3 text-[var(--color-error-text)]" /> {t('device.scan_none')}</>
            ) : (
              <><Scan className="w-3 h-3" /> {t('device.scan_tooltip')}</>
            )}
          </button>
          <button
            type="button"
            onClick={onManage}
            disabled={device.devices.length === 0}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-[var(--color-text-2)] hover:bg-white/[0.06] disabled:opacity-40 transition-colors"
          >
            <SettingsIcon className="w-3 h-3" />
            {t('device.popover_manage_label')}
          </button>
        </div>
      </div>

      <div className="p-1.5 max-h-[320px] overflow-y-auto scrollbar-thin">
        {device.devices.length === 0 ? (
          <div className="py-8 px-4 flex flex-col items-center gap-2 text-center text-[12px] text-[var(--color-text-3)]">
            <span>{t('device.no_device')}</span>
            <span>{t('device.no_device_hint')}</span>
            <button
              type="button"
              onClick={handleScan}
              disabled={scanning}
              className="action-btn mt-1 inline-flex items-center gap-1"
            >
              {scanning ? <Loader2 className="w-3 h-3 animate-spin" /> : <Scan className="w-3 h-3" />}
              {t('device.scan_now')}
            </button>
          </div>
        ) : (
          device.devices.map((d, idx) => {
            const meta = getDeviceMeta(d, idx, selectedUdid)
            const { unsupported, isSelected } = meta
            const isConnecting = connectingUdid === d.udid
            const status = getDeviceRowStatus({
              isConnected: d.is_connected,
              unsupported,
              isPrimary: isSelected,
              isLost: device.lostUdids.has(d.udid),
              degraded: !!runtimes[d.udid]?.tunnelDegraded,
              wasConnected: device.everConnectedUdids.has(d.udid),
            })
            const statusColor = STATUS_COLOR[status]
            return (
              <button
                key={d.udid}
                type="button"
                disabled={unsupported || isConnecting}
                onClick={() => {
                  if (unsupported) return
                  // Already connected: nothing to connect. Re-connecting
                  // rebuilt the engine and aborted a running route.
                  if (d.is_connected) { onClose(); return }
                  void handleConnect(d.udid)
                }}
                className={[
                  'grid items-center gap-3 w-full text-left',
                  'px-2.5 py-2.5 rounded-[10px] transition-colors duration-150',
                  isSelected ? 'bg-[var(--color-accent-dim)]' : 'hover:bg-white/[0.04]',
                  unsupported ? 'opacity-50 cursor-not-allowed' : isConnecting ? 'cursor-wait' : 'cursor-pointer',
                ].join(' ')}
                style={{ gridTemplateColumns: '36px 1fr auto' }}
              >
                <DeviceAvatar meta={meta} />
                <DeviceInfoColumn device={d} meta={meta} />
                {isConnecting ? (
                  <span className="inline-flex items-center gap-1.5 font-mono text-[10px] shrink-0 text-[var(--color-text-2)]">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    {t('device.connecting')}
                  </span>
                ) : (
                  <span
                    className="inline-flex items-center gap-1.5 font-mono text-[10px] shrink-0"
                    style={{ color: statusColor.text }}
                    data-status={status}
                  >
                    <span
                      className="w-1.5 h-1.5 rounded-full shrink-0"
                      style={{
                        background: statusColor.dot,
                        boxShadow: statusColor.glow ? `0 0 6px ${statusColor.dot}` : 'none',
                        animation: status === 'reconnecting' ? 'chip-pulse 1.6s ease-in-out infinite' : undefined,
                      }}
                    />
                    {t(STATUS_LABEL[status])}
                  </span>
                )}
              </button>
            )
          })
        )}
      </div>

      <div className="p-2.5 border-t border-[var(--color-border-subtle)]">
        <button
          type="button"
          onClick={onAdd}
          className="w-full inline-flex items-center justify-center gap-1.5 h-[34px] rounded-[9px] text-[12px] font-semibold text-[var(--color-surface-0)] transition-[transform,box-shadow] duration-150 hover:-translate-y-px focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-2"
          style={{ background: 'var(--color-accent)', boxShadow: 'var(--shadow-glow)' }}
        >
          <Plus className="w-3.5 h-3.5" />
          {t('device.popover_add_label')}
        </button>
      </div>
    </>
  )
}
