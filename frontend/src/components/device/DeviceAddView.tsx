import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, PlugZap, Search, Usb, Wifi } from 'lucide-react'
import { useDeviceContext } from '../../contexts/DeviceContext'
import { useToastContext } from '../../contexts/ToastContext'
import { useT } from '../../i18n'
import { wifiTunnelDiscover } from '../../services/api'
import { ICON_SIZE } from '../../lib/icons'
import { STORAGE_KEYS } from '../../lib/storage-keys'
import { readLS, writeLS } from '../../lib/local-storage'
import { DEFAULT_TUNNEL_PORT } from '../../lib/constants'
import { discoveredDisplayName, findUsbDeviceName } from '../../lib/usbDeviceMatch'

interface DiscoverResult {
  ip: string
  port: number
  name: string
  host?: string
}

export interface DeviceAddViewProps {
  // Called when a Wi-Fi tunnel successfully connects, so the orchestrator
  // can return to the list view (which will now show the new device).
  onConnected: () => void
}

export default function DeviceAddView({ onConnected }: DeviceAddViewProps) {
  const t = useT()
  const device = useDeviceContext()
  const { showToast } = useToastContext()

  const [tunnelIp, setTunnelIp] = useState(() => readLS(STORAGE_KEYS.tunnelIp) || '')
  const [tunnelPort, setTunnelPort] = useState(
    () => readLS(STORAGE_KEYS.tunnelPort) || String(DEFAULT_TUNNEL_PORT),
  )
  const [tunnelConnecting, setTunnelConnecting] = useState(false)
  const [tunnelError, setTunnelError] = useState<string | null>(null)
  const [discovering, setDiscovering] = useState(false)
  // Scan result list — every hit is shown with name + IP so the user can
  // see what was found; a single hit additionally auto-fills the form.
  const [discoverResults, setDiscoverResults] = useState<DiscoverResult[]>([])
  // The popover unmounts this view on outside click / Esc, and the tunnel
  // POST can run for up to two minutes. A failure that lands after unmount
  // has nowhere to render inline, so it falls back to a toast.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const handleDiscover = useCallback(async () => {
    setDiscovering(true)
    setTunnelError(null)
    setDiscoverResults([])
    try {
      const res = await wifiTunnelDiscover()
      const list = res?.devices ?? []
      if (list.length === 0) {
        setTunnelError(t('wifi.device_not_detected'))
        return
      }
      setDiscoverResults(
        list.map((d) => ({ ip: d.ip, port: d.port, name: d.name || d.ip, host: d.host })),
      )
      if (list.length === 1) {
        setTunnelIp(list[0].ip)
        setTunnelPort(String(list[0].port))
      }
    } catch (err: unknown) {
      setTunnelError(err instanceof Error ? err.message : t('wifi.detect_failed'))
    } finally {
      setDiscovering(false)
    }
  }, [t])

  const pickDiscoverResult = useCallback((r: DiscoverResult) => {
    setTunnelIp(r.ip)
    setTunnelPort(String(r.port))
  }, [])

  // The Wi-Fi tunnel reuses the host↔device pairing record that USB
  // establishes, so surface which device is currently on USB — that's the
  // one whose pairing the tunnel will piggyback on. Empty when no USB
  // device is connected (first-time setup still needs a USB trust).
  const usbDevices = useMemo(
    () => device.devices.filter((d) => d.connection_type === 'USB' && d.is_connected),
    [device.devices],
  )
  const usbDeviceNames = useMemo(() => usbDevices.map((d) => d.name), [usbDevices])

  const handleTunnelConnect = useCallback(async () => {
    if (!tunnelIp.trim()) return
    setTunnelConnecting(true)
    setTunnelError(null)
    try {
      const result = await device.startWifiTunnel(tunnelIp.trim(), parseInt(tunnelPort) || DEFAULT_TUNNEL_PORT)
      // Remember the port that actually worked, not the one typed in, so a
      // port the backend had to rediscover doesn't go stale again.
      const workingPort = String(result.port ?? (tunnelPort || DEFAULT_TUNNEL_PORT))
      writeLS(STORAGE_KEYS.tunnelIp, tunnelIp.trim())
      writeLS(STORAGE_KEYS.tunnelPort, workingPort)
      setTunnelPort(workingPort)
      showToast(
        result.alreadyConnected
          ? t('device.tunnel_already_connected')
          : t('device.tunnel_connected'),
      )
      onConnected()
    } catch (err: unknown) {
      if (!mountedRef.current) {
        const detail = err instanceof Error && err.message ? `: ${err.message}` : ''
        showToast(t('device.tunnel_failed') + detail, 6000)
        return
      }
      setTunnelError(err instanceof Error ? err.message : t('device.tunnel_failed'))
    } finally {
      if (mountedRef.current) setTunnelConnecting(false)
    }
  }, [tunnelIp, tunnelPort, device, showToast, t, onConnected])

  return (
    <div className="px-3.5 pt-3.5 pb-3 flex flex-col gap-4 max-h-[420px] overflow-y-auto scrollbar-thin">
      {/* USB section — guidance only; the actual scan button lives
          in the list view header, where the result (refreshed list)
          is visible. No need to duplicate the action here. */}
      <section className="flex flex-col gap-2">
        <div className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[var(--color-text-1)]">
          <Usb width={14} height={14} />
          {t('device.add_via_usb')}
        </div>
        <p className="text-[11px] text-[var(--color-text-3)] leading-[1.5]">
          {t('device.add_via_usb_hint')}
        </p>
      </section>

      {/* OR divider */}
      <div className="flex items-center gap-2">
        <div className="flex-1 h-px bg-[var(--color-border-subtle)]" />
        <span className="text-[10.5px] text-[var(--color-text-3)]">{t('device.add_or')}</span>
        <div className="flex-1 h-px bg-[var(--color-border-subtle)]" />
      </div>

      {/* Wi-Fi Tunnel section */}
      <section className="flex flex-col gap-2">
        <div className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[var(--color-text-1)]">
          <Wifi width={14} height={14} />
          {t('device.add_via_wifi')}
        </div>
        <p className="text-[11px] text-[var(--color-text-3)] leading-[1.5]">
          {t('device.add_via_wifi_hint')}
        </p>

        {/* Which device the tunnel will pair through (its USB pairing record). */}
        {usbDevices.length > 0 ? (
          <div className="flex flex-col gap-1 p-2 rounded-lg border border-[var(--color-accent)]/30 bg-[var(--color-accent-dim)]">
            <span className="inline-flex items-center gap-1.5 text-[10.5px] font-semibold text-[var(--color-accent-strong)]">
              <Usb width={12} height={12} />
              {t('wifi.usb_paired_device')}
            </span>
            {usbDevices.map((d) => (
              <div key={d.udid} className="flex items-center gap-2 text-[11px]">
                <span className="text-[var(--color-text-1)] truncate">{d.name}</span>
                <span className="font-mono text-[10px] text-[var(--color-text-3)] truncate">
                  {d.udid.slice(0, 8)}…
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[10.5px] text-[var(--color-text-3)] leading-[1.5] p-2 rounded-lg border border-[var(--color-border-subtle)] bg-white/[0.02]">
            {t('wifi.usb_paired_none')}
          </p>
        )}

        <button
          type="button"
          onClick={handleDiscover}
          disabled={discovering}
          className="action-btn w-full justify-center text-[11px]"
        >
          <Search width={11} height={11} className={discovering ? 'animate-spin' : ''} />
          {discovering ? t('wifi.detect_scanning') : t('wifi.detect')}
        </button>

        {discoverResults.length > 0 && (
          <div className="text-[11px] p-2 rounded-lg border border-[var(--color-accent)]/30 bg-[var(--color-accent-dim)]">
            <div className="font-semibold mb-1 text-[var(--color-accent-strong)]">
              {t('wifi.tunnel_detect_found', { n: discoverResults.length })}
            </div>
            <div className="flex flex-col gap-1">
              {discoverResults.map((r) => {
                // The mDNS instance name is often an opaque pairing ID, so
                // prefer the matched USB device's real name, then the most
                // readable broadcast candidate.
                const matchedUsbName = findUsbDeviceName(r, usbDeviceNames)
                const isUsbConnected = matchedUsbName !== null
                const displayName = matchedUsbName ?? discoveredDisplayName(r)
                return (
                  <div
                    key={`${r.ip}:${r.port}`}
                    className={[
                      'flex items-center gap-2 py-1 px-1.5 -mx-0.5 rounded-md',
                      isUsbConnected
                        ? 'border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10'
                        : 'border-t border-white/5 first:border-t-0',
                    ].join(' ')}
                  >
                    <div className="flex-1 min-w-0 flex items-center gap-2">
                      <span
                        className={
                          isUsbConnected
                            ? 'truncate font-medium text-[var(--color-text-1)]'
                            : 'truncate text-[var(--color-text-2)]'
                        }
                      >
                        {displayName}
                      </span>
                      <span className="font-mono text-[10px] text-[var(--color-text-3)] shrink-0">
                        {r.ip}
                      </span>
                      {isUsbConnected && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9.5px] font-semibold shrink-0 text-[var(--color-accent-strong)] bg-[var(--color-accent-dim)] border border-[var(--color-accent)]/40">
                          <Usb width={10} height={10} />
                          {t('wifi.scan_usb_badge')}
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => pickDiscoverResult(r)}
                      className="action-btn primary text-[10px] px-2 py-0.5"
                    >
                      {t('wifi.tunnel_use_this')}
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <div className="flex flex-col gap-1.5 mt-1">
          <label className="flex items-center gap-2 text-[11px]">
            <span className="w-10 text-[var(--color-text-3)]">{t('wifi.ip')}</span>
            <input
              type="text"
              placeholder={t('wifi.ip_placeholder')}
              value={tunnelIp}
              onChange={(e) => setTunnelIp(e.target.value)}
              disabled={tunnelConnecting}
              className="seg-input flex-1 text-xs font-mono"
            />
          </label>
          <label className="flex items-center gap-2 text-[11px]">
            <span className="w-10 text-[var(--color-text-3)]">{t('wifi.port')}</span>
            <input
              type="text"
              placeholder="49152"
              value={tunnelPort}
              onChange={(e) => setTunnelPort(e.target.value)}
              disabled={tunnelConnecting}
              className="seg-input flex-1 text-xs font-mono"
            />
          </label>
        </div>

        <button
          type="button"
          onClick={handleTunnelConnect}
          disabled={tunnelConnecting || !tunnelIp.trim()}
          className="seg-cta seg-cta-sm seg-cta-accent mt-1"
        >
          {tunnelConnecting ? (
            <><Loader2 width={ICON_SIZE.sm} height={ICON_SIZE.sm} className="animate-spin" /> {t('wifi.tunnel_establishing')}</>
          ) : (
            <><PlugZap width={ICON_SIZE.sm} height={ICON_SIZE.sm} /> {t('wifi.tunnel_start')}</>
          )}
        </button>

        {tunnelError && (
          <p className="text-[11px] text-[var(--color-error-text)] p-2 rounded-lg bg-[var(--color-danger-dim)] border border-[rgba(255,71,87,0.3)]">
            {tunnelError}
          </p>
        )}

        <p className="text-[10px] text-[var(--color-text-3)] opacity-70">
          {t('wifi.tunnel_admin_hint')}
        </p>
      </section>
    </div>
  )
}
