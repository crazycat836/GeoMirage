import { useEffect, useRef, useState } from 'react'
import { Pause, Play } from 'lucide-react'
import { useT } from '../i18n'
import { formatDistanceM } from '../lib/format'
import { useSimActions } from '../contexts/SimContext'
import { useSimDerived } from '../contexts/SimDerivedContext'
import type { RuntimesMap } from '../hooks/useSimulation'

interface EtaBarProps {
  // Live simulation state
  state: string
  progress: number
  remainingDistance: number
  traveledDistance: number
  eta: number
  runtimes?: RuntimesMap
  // Static preview (shown before starting). Not displayed with the
  // new top-center ETA pill — dock panel carries pre-run info now.
  plannedDistanceM?: number
  plannedEtaSeconds?: number
}

// Keep `paused` here — the pause/resume button lives inside this pill,
// so hiding it on pause would trap the user with no visible way to resume.
const ACTIVE_STATES = ['navigating', 'looping', 'multi_stop', 'random_walk', 'flower', 'paused']

// Single source of truth for "is the ETA pill on screen". Mirrors the
// visibility gate below so callers (e.g. App.tsx, which stacks the toast
// underneath the bar) can react without duplicating the runtime logic.
export function isEtaBarLive(state: string, runtimes?: RuntimesMap): boolean {
  const activeCount = runtimes
    ? Object.values(runtimes).filter((r) => ACTIVE_STATES.includes(r.state)).length
    : 0
  return activeCount >= 2 || ACTIVE_STATES.includes(state)
}

// Format ETA as HH:MM:SS to match the redesign/Home treatment
// (mono, accent-coloured, always 2-digit HH prefix even for < 1h).
function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(sec)}`
}

// Top-centre ETA pill — mirrors `.eta` from redesign/Home exactly:
// glass-pill-strong surface, 160×4 progress bar with accent gradient,
// stat columns for ETA / Remaining / Speed, vertical separators,
// and a 32px pause/resume button on the right. Fades in when a
// simulation is actively running.
function EtaBar({
  state,
  progress,
  remainingDistance,
  eta,
  runtimes,
}: EtaBarProps) {
  const t = useT()
  const { handlePause, handleResume } = useSimActions()
  const { displaySpeed, isPaused } = useSimDerived()

  const activeRuntimes = runtimes
    ? Object.values(runtimes).filter((r) => ACTIVE_STATES.includes(r.state))
    : []
  const isGroup = activeRuntimes.length >= 2

  const live = isEtaBarLive(state, runtimes)

  const aggProgress = isGroup
    ? activeRuntimes.reduce((s, r) => s + (r.progress || 0), 0) / activeRuntimes.length
    : progress

  // Screen-reader announcements. The stats below tick every position
  // update (~1 s), so they must not sit in a live region; instead a
  // separate, always-mounted region speaks only on run-state changes:
  // start, pause, and arrival (or stop).
  const phase: 'idle' | 'running' | 'paused' = !live ? 'idle' : isPaused ? 'paused' : 'running'
  const prevPhaseRef = useRef(phase)
  const [announcement, setAnnouncement] = useState('')
  useEffect(() => {
    const prev = prevPhaseRef.current
    prevPhaseRef.current = phase
    if (prev === phase) return
    if (phase === 'running') setAnnouncement(t('eta.sr_running'))
    else if (phase === 'paused') setAnnouncement(t('eta.sr_paused'))
    else setAnnouncement(aggProgress >= 1 ? t('eta.sr_arrived') : t('eta.sr_stopped'))
    // Only phase transitions announce; progress/t are read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  const liveRegion = (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {announcement}
    </div>
  )

  // Design pins the bar on-screen only while something is running;
  // before start the dock panel already carries planned distance/ETA.
  if (!live) return liveRegion

  const aggEta = isGroup
    ? Math.max(...activeRuntimes.map((r) => r.eta || 0))
    : eta
  const aggRemaining = isGroup
    ? Math.max(...activeRuntimes.map((r) => r.distanceRemaining || 0))
    : remainingDistance

  const percent = Math.max(0, Math.min(aggProgress * 100, 100))

  return (
    <>
    {liveRegion}
    <div
      data-fc="map.eta-bar"
      className={[
        // No Tailwind `-translate-x-1/2` here: Tailwind v4 emits it as
        // the CSS `translate:` longhand, which *stacks* with the
        // animation's `transform: translate(-50%, …)` and double-shifts
        // the pill off-canvas. The `eta-bar-enter` keyframe bakes the
        // horizontal translate into every frame (with fill-mode `both`),
        // so it's centred before / during / after the animation.
        // `--z-eta` (390) sits above the self-contained Leaflet map subtree
        // but BELOW the top bar (--z-ui 400), so the search dropdown and the
        // connection banners render over the pill instead of being hidden
        // under it. It stays above `--z-bar` (200) so it doesn't flicker
        // behind tiles mid-zoom.
        // `glass-pill-medium` = 0.82 alpha / blur 20 / shadow-md — the
        // dense-alpha pill variant from redesign/Home `.eta` spec. Shares
        // the dock's 0.82 tone for visual consistency but keeps the
        // lighter blur + shadow appropriate for a pill.
        'glass-pill-medium',
        'fixed top-[76px] left-1/2 z-[var(--z-eta)]',
        'pl-5 pr-4 py-2.5 flex items-center gap-[18px]',
        'eta-bar-enter',
      ].join(' ')}
      style={{ transformOrigin: 'top center' }}
    >
      {/* ETA — accent mono value */}
      <Stat label={t('eta.eta')} value={formatClock(aggEta)} accent />

      {/* Progress bar (160×4) with gradient fill + glow */}
      <div
        className="w-40 h-1 rounded-[2px] bg-white/[0.08] overflow-hidden relative shrink-0"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        aria-label={t('eta.progress_aria')}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-[2px] transition-[width] duration-500 ease-out"
          style={{
            width: `${percent}%`,
            background: 'linear-gradient(90deg, var(--color-accent) 0%, var(--color-accent-strong) 100%)',
            boxShadow: 'var(--shadow-glow)',
          }}
        />
      </div>

      <Stat label={t('eta.remaining')} value={formatDistanceM(aggRemaining)} />

      <Sep />

      <Stat label={t('panel.speed')} value={`${displaySpeed} km/h`} />

      <Sep />

      {/* Pause / Resume — 32px circle matching design `.eta .pause-btn` */}
      <button
        type="button"
        onClick={() => { if (isPaused) handleResume(); else handlePause() }}
        className={[
          'w-8 h-8 rounded-full grid place-items-center',
          'text-[var(--color-text-1)] bg-white/[0.05] hover:bg-white/[0.08]',
          'transition-colors duration-150 cursor-pointer',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]',
        ].join(' ')}
        aria-label={isPaused ? t('generic.resume') : t('generic.pause')}
        title={isPaused ? t('generic.resume') : t('generic.pause')}
      >
        {isPaused
          ? <Play className="w-3 h-3" fill="currentColor" />
          : <Pause className="w-3 h-3" fill="currentColor" />}
      </button>
    </div>
    </>
  )
}

interface StatProps {
  label: string
  value: string
  accent?: boolean
}

function Stat({ label, value, accent }: StatProps) {
  return (
    <div className="flex flex-col gap-0.5 text-left">
      <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-3)] font-semibold leading-none">
        {label}
      </span>
      <span
        className={[
          'font-mono text-[14px] font-medium leading-none tabular-nums',
          accent ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-1)]',
        ].join(' ')}
      >
        {value}
      </span>
    </div>
  )
}

function Sep() {
  return (
    <span
      className="w-px h-[26px] bg-[var(--color-border-strong)] shrink-0"
      aria-hidden="true"
    />
  )
}

export default EtaBar
