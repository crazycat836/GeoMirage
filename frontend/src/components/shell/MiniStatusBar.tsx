import { useCallback, useState } from 'react'
import { Copy, Check, Usb, Wifi, MapPinOff } from 'lucide-react'
import { useSimState } from '../../contexts/SimContext'
import { useSimDerived } from '../../contexts/SimDerivedContext'
import { useDeviceContext } from '../../contexts/DeviceContext'
import { useConnectionHealth } from '../../contexts/ConnectionHealthContext'
import { useI18n, useT } from '../../i18n'
import { useReverseGeocode } from '../../hooks/useReverseGeocode'
import { useWeather } from '../../hooks/useWeather'
import WeatherChip from './WeatherChip'
import { DEVICE_COLORS, DEVICE_LETTERS } from '../../lib/constants'
import type { DeviceInfo } from '../../hooks/useDevice'
import { copyToClipboard } from '../../lib/clipboard'
import { formatCardinalAxis, formatCoord } from '../../lib/format'

export default function MiniStatusBar() {
  const t = useT()
  const { lang } = useI18n()
  const { backendPositionSynced } = useSimState()
  const { currentPos, isRunning } = useSimDerived()
  const device = useDeviceContext()
  const health = useConnectionHealth()
  const { countryCode, country } = useReverseGeocode(currentPos, lang, { paused: isRunning })
  const weather = useWeather(currentPos, { paused: isRunning })

  const isSimulating = backendPositionSynced

  const isDual = device.connectedDevices.length >= 2
  const isStale = health.device === 'stale'

  return (
    <div
      data-fc="status.mini-bar"
      className="fixed top-[76px] left-4 z-[var(--z-ui)] flex flex-col items-start gap-2 max-w-[288px] w-[288px]"
      aria-label={t('shell.status_aria')}
    >
      {isDual ? (
        <DualDevicePills devices={device.connectedDevices.slice(0, 2)} stale={isStale} />
      ) : (
        <LivePosCard
          currentPos={currentPos}
          isSimulating={isSimulating}
          stale={isStale}
          countryCode={countryCode}
          country={country}
          weather={weather}
        />
      )}
    </div>
  )
}

// ─── Device pill ──────────────────────────────────────────────

interface DevicePillProps {
  dev: DeviceInfo | undefined
  letter: typeof DEVICE_LETTERS[number]
  color: string
  coord?: { lat: number; lng: number } | null
  stale?: boolean
  /** True while a `tunnel_degraded` is outstanding for this device — the
   *  DVT channel is reconnecting. Orthogonal to `stale` (which is about
   *  the WS transport between renderer and backend, not the renderer-
   *  to-iPhone tunnel). Both can be true simultaneously; the tooltip
   *  prefers `degraded` because that's the user-actionable state. */
  degraded?: boolean
}

function DevicePill({ dev, letter, color, coord, stale, degraded }: DevicePillProps) {
  const t = useT()
  if (!dev) return null
  const isNetwork = dev.connection_type === 'Network'
  const titleText = degraded
    ? `${dev.name} · ${t('device.chip_state_reconnecting')}`
    : stale
      ? `${dev.name} · ${t('conn.stale_tooltip')}`
      : dev.name
  return (
    <div
      className="glass-pill-medium inline-flex items-center gap-2.5 h-10 pl-2 pr-4 text-[12px] font-medium transition-opacity"
      title={titleText}
      data-stale={stale ? 'true' : undefined}
      data-degraded={degraded ? 'true' : undefined}
      style={stale ? { opacity: 0.55 } : undefined}
    >
      <span
        className="w-6 h-6 rounded-full grid place-items-center text-[11px] font-semibold"
        style={{
          background: color,
          color: 'var(--color-surface-0)',
          boxShadow: 'var(--shadow-avatar-ring-dark)',
        }}
        aria-hidden="true"
      >
        {letter}
      </span>
      <div className="flex flex-col leading-tight min-w-0">
        <span className="text-[12px] font-medium text-[var(--color-text-1)] truncate max-w-[150px]">
          {dev.name}
        </span>
        {coord && (
          <span className="font-mono text-[10px] text-[var(--color-text-3)]">
            {formatCoord(coord, 4)}
          </span>
        )}
      </div>
      <span className="w-px h-4 bg-[var(--color-border-strong)] shrink-0" aria-hidden="true" />
      <span
        className="inline-flex items-center gap-1.5 font-mono text-[10px] shrink-0"
        style={{
          color: degraded ? 'var(--color-device-paused)' : 'var(--color-success-text)',
        }}
      >
        <span
          className="w-1.5 h-1.5 rounded-full"
          style={{
            background: degraded ? 'var(--color-device-paused)' : 'var(--color-success-text)',
            boxShadow: degraded
              ? '0 0 6px var(--color-device-paused)'
              : '0 0 6px var(--color-success-text)',
            animation: degraded ? 'chip-pulse 1.6s ease-in-out infinite' : undefined,
          }}
          aria-hidden="true"
        />
        {degraded
          ? t('device.chip_state_reconnecting')
          : isNetwork
            ? <><Wifi className="w-2.5 h-2.5" />Wi-Fi</>
            : <><Usb className="w-2.5 h-2.5" />USB</>}
      </span>
    </div>
  )
}

function DualDevicePills({ devices, stale }: { devices: DeviceInfo[]; stale?: boolean }) {
  const { runtimes } = useSimState()
  return (
    <>
      {devices.map((dev, i) => (
        <DevicePill
          key={dev.udid}
          dev={dev}
          letter={DEVICE_LETTERS[i]}
          color={DEVICE_COLORS[i]}
          coord={runtimes[dev.udid]?.currentPos ?? null}
          stale={stale}
          degraded={!!runtimes[dev.udid]?.tunnelDegraded}
        />
      ))}
    </>
  )
}

// ─── Unified Live-position card (coords + location footer) ───

interface LivePosCardProps {
  currentPos: { lat: number; lng: number } | null
  isSimulating: boolean
  stale?: boolean
  countryCode?: string | null
  country?: string | null
  weather?: ReturnType<typeof useWeather>
}

function LivePosCard({
  currentPos, isSimulating, stale,
  countryCode, country, weather,
}: LivePosCardProps) {
  const t = useT()
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    if (!currentPos) return
    const txt = formatCoord(currentPos)
    void copyToClipboard(txt).then((ok) => {
      if (!ok) return
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [currentPos])

  const hasPos = currentPos != null
  const simState = isSimulating ? 'running' : 'idle'

  return (
    <div
      data-fc="status.live-pos"
      className="live-pos w-full transition-opacity"
      data-has-pos={hasPos ? 'true' : 'false'}
      data-sim={simState}
      data-stale={stale ? 'true' : undefined}
      style={stale ? { opacity: 0.55 } : undefined}
      title={stale ? t('conn.stale_tooltip') : undefined}
      aria-label={t('status.virtual_position')}
    >
      {/* Eyebrow + coords */}
      <div className="lp-head">
        <span className="lp-eyebrow">
          <span className="dot" aria-hidden="true" />
          <span>{t('status.virtual_position')}</span>
        </span>
        <span className="lp-sim">SIM</span>
        <button
          type="button"
          onClick={handleCopy}
          className="lp-copy cursor-pointer disabled:cursor-not-allowed"
          aria-label={t('status.copy_coord')}
          title={t('status.copy_coord')}
          disabled={!hasPos}
        >
          {copied
            ? <Check className="w-3 h-3" strokeWidth={2.5} />
            : <Copy className="w-3 h-3" strokeWidth={2} />}
        </button>
      </div>

      {hasPos ? (
        <div className="lp-coords">
          {(['lat', 'lng'] as const).map((axis) => {
            const { value, hemisphere } = formatCardinalAxis(currentPos![axis], axis, 6)
            return (
              <div key={axis} className="lp-coord-row">
                <span className="axis">{axis === 'lat' ? 'LAT' : 'LNG'}</span>
                <span className="val tabular-nums">{value}</span>
                <span className="unit">°{hemisphere}</span>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="lp-no-pos">
          <MapPinOff className="shrink-0" strokeWidth={1.5} />
          <div className="hint">
            <strong>{t('status.no_position_title')}</strong>
            <span>{t('status.no_position_hint')}</span>
          </div>
        </div>
      )}

      {/* Location + weather footer */}
      <div className="lp-footer flex items-center gap-2 px-4 py-2.5 border-t border-[var(--color-border-subtle)] text-[11.5px] text-[var(--color-text-2)] relative z-[1]"
        style={{ background: 'linear-gradient(180deg, transparent 0%, rgba(0,0,0,0.15) 100%)' }}
      >
        {hasPos && countryCode ? (
          <>
            <img
              src={`https://flagcdn.com/w40/${countryCode}.png`}
              alt={countryCode.toUpperCase()}
              width={16}
              height={12}
              className="rounded-[2px] shadow-[0_0_0_1px_rgba(255,255,255,0.12),0_2px_4px_rgba(0,0,0,0.3)] shrink-0"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
            />
            {country && (
              <span className="text-[var(--color-text-1)] font-medium tracking-[-0.005em]">{country}</span>
            )}
            {weather && (
              <>
                <span className="w-[3px] h-[3px] rounded-full bg-[var(--color-text-3)] opacity-50 shrink-0" aria-hidden="true" />
                <span className="ml-auto"><WeatherChip snapshot={weather} size={12} /></span>
              </>
            )}
          </>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-[var(--color-text-3)] italic">
            <MapPinOff className="w-3 h-3 shrink-0" strokeWidth={1.5} />
            {t('status.no_location')}
          </span>
        )}
      </div>
    </div>
  )
}
