import { useCallback, useEffect, useMemo, useState } from 'react'
import { Repeat, Route, Shuffle, Crosshair, Navigation, Gamepad2, SquareCheckBig, X, Check, ChevronDown, Flower } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ChainPoint } from '../WaypointChain'
import { useSimActions, useSimState } from '../../contexts/SimContext'
import { useSimDerived } from '../../contexts/SimDerivedContext'
import { useSimSettings } from '../../contexts/SimSettingsContext'
import { SimMode, isRouteSubMode } from '../../hooks/useSimulation'
import { useT } from '../../i18n'
import { RADIUS_PRESETS } from '../../lib/constants'
import { resolveEffectiveKmh } from '../../lib/sim-derive'
import { STORAGE_KEYS } from '../../lib/storage-keys'
import { readLS, writeLS } from '../../lib/local-storage'
import GlassIconButton from '../ui/GlassIconButton'
import DockRouteCard from './dock/DockRouteCard'
import WaypointList from './dock/WaypointList'
import JoyPreview from './dock/JoyPreview'
import ModeStatsCard, { CardShell } from './dock/ModeStatsCard'
import SpeedToggle from './dock/SpeedToggle'
import ActionGroup from './dock/ActionGroup'
import RouteSubModeToggle from './dock/RouteSubModeToggle'
import { buildDockContext } from './dock/buildDockContext'

const MODE_ICON: Record<string, LucideIcon> = {
  [SimMode.Teleport]:   Crosshair,
  [SimMode.Navigate]:   Navigation,
  [SimMode.Loop]:       Repeat,
  [SimMode.MultiStop]:  Route,
  [SimMode.RandomWalk]: Shuffle,
  [SimMode.Flower]:     Flower,
  [SimMode.Joystick]:   Gamepad2,
}

// Fixed height of the dock's collapsible body. Keeping it constant (rather
// than flexing) means the panel never jumps height between modes, and lets
// the collapse animate cleanly between two known px values.
const DOCK_BODY_HEIGHT = 280
const DOCK_BODY_GAP = 12
const DOCK_COLLAPSE_MS = 240

// Minimum viewport height below which the dock starts collapsed when the user
// has no saved preference — otherwise the expanded dock (~376px) plus the top
// chrome squeezes the map to a sliver on short windows.
const SHORT_VIEWPORT_PX = 720

// Read the persisted collapse preference. With no saved value, default to
// collapsed on short viewports and expanded otherwise. An explicit user
// choice ('1' / '0') always wins.
function readDockCollapsed(): boolean {
  const v = readLS(STORAGE_KEYS.dockCollapsed)
  if (v === '1') return true
  if (v === '0') return false
  return typeof window !== 'undefined' && window.innerHeight < SHORT_VIEWPORT_PX
}

export default function BottomDock() {
  const t = useT()
  const { handleRemoveWaypoint, handleGenerateRandomWaypoints, handleOptimizeWaypoints, setWaypoints } = useSimActions()
  const { mode, waypoints, customSpeedKmh, speedMinKmh, speedMaxKmh, moveMode } = useSimState()
  const { currentPos, destPos } = useSimDerived()
  const { flowerSettings } = useSimSettings()
  const [showRandomConfig, setShowRandomConfig] = useState(false)
  const [collapsed, setCollapsed] = useState(readDockCollapsed)

  useEffect(() => { setShowRandomConfig(false) }, [mode])

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev
      writeLS(STORAGE_KEYS.dockCollapsed, next ? '1' : '0')
      return next
    })
  }, [])

  // Planning speed for the Flower estimate — same rule the backend moves at.
  const planSpeedKmh = resolveEffectiveKmh({ moveMode, customSpeedKmh, speedMinKmh, speedMaxKmh })
  const ctx = useMemo(
    () => buildDockContext(mode, waypoints, currentPos, destPos, t, {
      settings: flowerSettings,
      speedKmh: planSpeedKmh,
    }),
    [mode, waypoints, currentPos, destPos, t, flowerSettings, planSpeedKmh],
  )

  const speedToggleDisabled = mode === SimMode.Teleport || mode === SimMode.Joystick
  const Icon = MODE_ICON[mode] ?? SquareCheckBig

  const handleRandomGenerate = () => {
    handleGenerateRandomWaypoints()
    setShowRandomConfig(false)
  }

  // Reorder the in-progress stops (index >= 1). The start (index 0, the
  // current position) stays fixed. Stop ids are 'wp-<originalIndex>'.
  const handleReorderStops = useCallback((orderedStopIds: string[]) => {
    setWaypoints((prev) => {
      if (prev.length <= 2) return prev
      const startPt = prev[0]
      const stops: typeof prev = []
      for (const id of orderedStopIds) {
        const i = parseInt(id.replace('wp-', ''), 10)
        if (!Number.isNaN(i) && prev[i]) stops.push(prev[i])
      }
      if (stops.length !== prev.length - 1) return prev
      return [startPt, ...stops]
    })
  }, [setWaypoints])

  return (
    <div
      data-fc="bottom.dock"
      aria-label={t('shell.dock_aria')}
      className={[
        'glass-panel-strong',
        'fixed bottom-[84px] left-1/2 z-[var(--z-ui)]',
        // Reserve room on the right for the floating MapControls column
        // (right-3 margin + ~40px toolbar) so the two panels never overlap
        // at the app's 900px minimum window width.
        'w-[min(920px,calc(100vw-104px))]',
        'flex flex-col',
        'overflow-hidden',
        'anim-fade-slide-up-centered',
      ].join(' ')}
    >
      {/* Panel body — padding matches design: 14px 16px. The header always
          shows; the main row below it collapses to free the map on small
          screens. */}
      <div className="flex flex-col" style={{ padding: '14px 16px' }}>
        {/* Header: icon + title + subtitle + collapse toggle */}
        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-[10px] grid place-items-center shrink-0 border"
            style={{
              background: 'var(--color-accent-dim)',
              color: 'var(--color-accent-strong)',
              borderColor: 'color-mix(in oklab, var(--color-accent) 28%, transparent)',
            }}
          >
            <Icon className="w-[18px] h-[18px]" />
          </div>
          <div className="flex flex-col gap-0.5 min-w-0 flex-1">
            <div className="text-[20px] font-semibold tracking-[-0.02em] text-[var(--color-text-1)] leading-[1.2] truncate">
              {ctx.title}
            </div>
            <div className="text-[12.5px] text-[var(--color-text-3)] leading-[1.5] max-w-[520px] truncate">
              {ctx.subtitle}
            </div>
          </div>
          {isRouteSubMode(mode) && <RouteSubModeToggle />}
          <GlassIconButton
            className="shrink-0"
            label={collapsed ? t('shell.dock_expand') : t('shell.dock_collapse')}
            onClick={toggleCollapsed}
            icon={
              <ChevronDown
                className={[
                  'w-[18px] h-[18px] transition-transform duration-200',
                  collapsed ? 'rotate-180' : '',
                ].join(' ')}
              />
            }
          />
        </div>

        {/* Collapsible main row — height animates between a fixed px and 0
            so the panel never jumps between modes and folds away cleanly.
            `inert` keeps the hidden controls out of the tab order. */}
        <div
          className="overflow-hidden"
          inert={collapsed}
          style={{
            height: collapsed ? 0 : DOCK_BODY_HEIGHT,
            marginTop: collapsed ? 0 : DOCK_BODY_GAP,
            transition: `height ${DOCK_COLLAPSE_MS}ms var(--ease-out-expo), margin-top ${DOCK_COLLAPSE_MS}ms var(--ease-out-expo)`,
          }}
        >
          {/* Always 2-column (left content + right controls). The fixed
              height + min-h-0 row lets the left column scroll internally
              instead of growing the panel. */}
          <div
            className="grid gap-3 items-start"
            style={{ height: DOCK_BODY_HEIGHT, gridTemplateColumns: '1fr 1fr', gridTemplateRows: 'minmax(0, 1fr)' }}
          >
            {/* Left column */}
            <div className="flex flex-col gap-2 min-w-0 min-h-0 h-full">
              <LeftColumn
                mode={mode}
                chainPoints={ctx.chainPoints}
                loop={ctx.loop}
                onRemoveWaypoint={handleRemoveWaypoint}
                onGenerateRandom={() => setShowRandomConfig(true)}
                onOptimize={handleOptimizeWaypoints}
                onReorder={handleReorderStops}
              />
            </div>

            {/* Right column: random config OR stats card + speed + action */}
            <div className="flex flex-col gap-2">
              {showRandomConfig ? (
                <RandomConfigPanel
                  onCancel={() => setShowRandomConfig(false)}
                  onGenerate={handleRandomGenerate}
                />
              ) : (
                <>
                  <ModeStatsCard />
                  {!speedToggleDisabled && <SpeedToggle />}
                  <ActionGroup fullWidth />
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Left column content ──────────────────────────────────────────────

interface LeftColumnProps {
  mode: SimMode
  chainPoints: readonly ChainPoint[]
  loop: boolean
  onRemoveWaypoint: (index: number) => void
  onGenerateRandom: () => void
  onOptimize: () => void
  onReorder: (orderedStopIds: string[]) => void
}

function LeftColumn({ mode, chainPoints, loop, onRemoveWaypoint, onGenerateRandom, onOptimize, onReorder }: LeftColumnProps) {
  switch (mode) {
    case SimMode.Teleport:
    case SimMode.Navigate:
      return <DockRouteCard mode={mode} />
    case SimMode.Loop:
    case SimMode.MultiStop:
    case SimMode.Flower:
      return (
        <WaypointList
          points={chainPoints}
          loop={loop}
          onRemove={(id) => {
            const i = parseInt(id.replace('wp-', ''), 10)
            if (!Number.isNaN(i)) onRemoveWaypoint(i)
          }}
          onRandom={onGenerateRandom}
          onOptimize={onOptimize}
          onReorder={onReorder}
        />
      )
    case SimMode.RandomWalk:
      return <RandomPreview />
    case SimMode.Joystick:
      return <JoyPreview />
    default:
      return null
  }
}

// ── Random config panel (right column swap) ─────────────────────────

function RandomConfigPanel({ onCancel, onGenerate }: { onCancel: () => void; onGenerate: () => void }) {
  const t = useT()
  const { wpGenRadius, setWpGenRadius, wpGenCount, setWpGenCount } = useSimSettings()
  const KM = 1000
  return (
    <>
      <CardShell>
        <div className="grid grid-cols-2 relative">
          {/* Radius */}
          <div className="flex flex-col gap-2 p-4 hover:bg-white/[0.025] transition-colors">
            <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.10em] text-[var(--color-text-3)]">
              <span className="w-1 h-1 rounded-full bg-[var(--color-accent)] shadow-[0_0_6px_var(--color-accent)] opacity-70" aria-hidden="true" />
              {t('dock.radius')}
            </span>
            <div className="flex gap-1 flex-wrap">
              {RADIUS_PRESETS.map((r) => {
                const active = r === wpGenRadius
                const label = r >= KM ? `${r / KM} km` : `${r} m`
                return (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setWpGenRadius(r)}
                    className={[
                      'h-7 px-2.5 rounded-[7px] font-mono text-[12px] font-medium',
                      'transition-colors cursor-pointer',
                      active
                        ? 'text-[var(--color-accent-strong)]'
                        : 'text-[var(--color-text-2)] hover:text-[var(--color-text-1)]',
                    ].join(' ')}
                    style={active ? { background: 'var(--color-accent-dim)' } : undefined}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          </div>
          {/* Waypoint count */}
          <div className="flex flex-col gap-2 p-4 hover:bg-white/[0.025] transition-colors relative">
            <span className="absolute left-0 top-[18%] bottom-[18%] w-px" style={{ background: 'linear-gradient(180deg, transparent, var(--color-border) 25%, var(--color-border) 75%, transparent)' }} aria-hidden="true" />
            <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.10em] text-[var(--color-text-3)]">
              <span className="w-1 h-1 rounded-full bg-[var(--color-accent)] shadow-[0_0_6px_var(--color-accent)] opacity-70" aria-hidden="true" />
              {t('dock.waypoints')}
            </span>
            <div className="inline-flex items-center gap-0.5 h-6 px-0.5 rounded-xl" style={{ background: 'rgba(255,255,255,0.12)' }}>
              <button type="button" onClick={() => setWpGenCount(Math.max(2, wpGenCount - 1))} aria-label={`${t('dock.waypoints')} −`} className="w-7 h-7 rounded-lg grid place-items-center text-[14px] text-[var(--color-text-2)] bg-white/[0.06] hover:bg-[rgba(167,139,250,0.18)] transition-colors cursor-pointer">−</button>
              <span className="font-mono text-[13px] font-semibold text-[var(--color-text-1)] min-w-[28px] text-center tabular-nums">{wpGenCount}</span>
              <button type="button" onClick={() => setWpGenCount(Math.min(20, wpGenCount + 1))} aria-label={`${t('dock.waypoints')} +`} className="w-7 h-7 rounded-lg grid place-items-center text-[14px] text-[var(--color-text-2)] bg-white/[0.06] hover:bg-[rgba(167,139,250,0.18)] transition-colors cursor-pointer">+</button>
            </div>
          </div>
        </div>
      </CardShell>
      {/* Cancel / Generate buttons */}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center justify-center gap-2 h-11 rounded-xl text-[13px] font-medium cursor-pointer transition-colors text-[var(--color-text-2)] hover:text-[var(--color-text-1)]"
          style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--color-border)' }}
        >
          <X className="w-3.5 h-3.5" />
          {t('action.cancel')}
        </button>
        <button
          type="button"
          onClick={onGenerate}
          className="inline-flex items-center justify-center gap-2 h-11 rounded-xl text-[13px] font-semibold cursor-pointer transition-colors text-[var(--color-surface-0)]"
          style={{ background: 'var(--color-accent)', boxShadow: 'var(--shadow-glow)' }}
        >
          <Check className="w-3.5 h-3.5" />
          {t('dock.generate_waypoints')}
        </button>
      </div>
    </>
  )
}

// ── Random walk preview (left column) ────────────────────────────────

function RandomPreview() {
  const t = useT()
  return (
    <div
      className="rounded-xl border border-[var(--color-border)] overflow-hidden"
      style={{ background: 'rgba(255,255,255,0.03)' }}
    >
      <div className="flex items-center justify-between px-3.5 py-2.5">
        <span className="text-[12px] font-medium text-[var(--color-text-2)]">
          {t('dock.wander_zone')}
        </span>
        <span className="inline-flex items-center gap-1.5 text-[10px] font-mono text-[var(--color-text-3)]">
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{ background: 'var(--color-success-text)', boxShadow: '0 0 6px var(--color-success-text)' }}
            aria-hidden="true"
          />
          {t('dock.wandering')}
        </span>
      </div>
      <div className="px-3.5 pb-3">
        <svg viewBox="0 0 200 100" className="w-full h-auto opacity-60" preserveAspectRatio="xMidYMid meet">
          <circle cx="100" cy="50" r="40" fill="none" stroke="var(--color-accent)" strokeWidth="1" strokeDasharray="4 3" opacity="0.3" />
          <path
            d="M100 50 L88 44 L82 56 L94 66 L108 60 L118 50 L112 36 L96 30"
            fill="none" stroke="var(--color-accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.5"
          />
          <circle cx="100" cy="50" r="3" fill="var(--color-accent)" opacity="0.4" />
          <circle cx="96" cy="30" r="3.5" fill="var(--color-accent)" />
        </svg>
      </div>
    </div>
  )
}
