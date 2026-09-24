import { useMemo } from 'react'
import { useSimActions, useSimState } from '../../../contexts/SimContext'
import { useSimDerived } from '../../../contexts/SimDerivedContext'
import {
  useSimSettings,
  JOYSTICK_SENSITIVITY_MIN,
  JOYSTICK_SENSITIVITY_MAX,
} from '../../../contexts/SimSettingsContext'
import { SimMode } from '../../../hooks/useSimulation'
import { useT } from '../../../i18n'
import { haversineM, polylineDistanceM } from '../../../lib/geo'
import { resolveEffectiveKmh } from '../../../lib/sim-derive'
import { KM_THRESHOLD_M, formatCooldownS, formatDistanceM, formatDurationS } from '../../../lib/format'
import { RADIUS_PRESETS, cooldownForDistM } from '../../../lib/constants'
import {
  FLOWER_LIMITS,
  stepFlowerRounds,
  stepFlowerWait,
  type FlowerSettings,
  type FlowerTransfer,
} from '../../../lib/flower'
import Toggle from '../../ui/Toggle'

type Translate = ReturnType<typeof useT>

// ── Shared visual primitives ──────────────────────────────────────────

function AccentHairline() {
  return (
    <div
      className="absolute left-4 right-4 top-0 h-px"
      style={{
        background:
          'linear-gradient(90deg, transparent, var(--color-accent-strong), transparent)',
        opacity: 0.5,
      }}
      aria-hidden="true"
    />
  )
}

function ColDivider() {
  return (
    <span
      className="absolute left-0 top-[18%] bottom-[18%] w-px"
      style={{
        background:
          'linear-gradient(180deg, transparent, var(--color-border) 25%, var(--color-border) 75%, transparent)',
      }}
      aria-hidden="true"
    />
  )
}

function RowDivider() {
  return (
    <div
      className="absolute left-[18px] right-[18px] bottom-0 h-px"
      style={{
        background:
          'linear-gradient(90deg, transparent, var(--color-border) 20%, var(--color-border) 80%, transparent)',
      }}
      aria-hidden="true"
    />
  )
}

// ── Stat cell ─────────────────────────────────────────────────────────

interface StatCellProps {
  label: string
  value: string
  accent?: boolean
  divider?: boolean
}

function StatCell({ label, value, accent = false, divider = false }: StatCellProps) {
  return (
    <div
      className={[
        'flex flex-col gap-2 p-4 hover:bg-white/[0.025] transition-colors',
        divider ? 'relative' : '',
      ].join(' ')}
    >
      {divider && <ColDivider />}
      <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.10em] text-[var(--color-text-3)]">
        <span
          className="w-1 h-1 rounded-full bg-[var(--color-accent)] shadow-[0_0_6px_var(--color-accent)] opacity-70"
          aria-hidden="true"
        />
        {label}
      </span>
      <span
        className={[
          'font-mono text-[24px] font-semibold tabular-nums leading-none tracking-[-0.02em]',
          accent
            ? 'text-[var(--color-accent-strong)]'
            : 'text-[var(--color-text-1)]',
        ].join(' ')}
      >
        {value}
      </span>
    </div>
  )
}

// ── Control cell ──────────────────────────────────────────────────────

interface ControlCellProps {
  label: string
  divider?: boolean
  /** Tighter padding + smaller label for dense settings grids. */
  compact?: boolean
  children: React.ReactNode
}

function ControlCell({ label, divider = false, compact = false, children }: ControlCellProps) {
  return (
    <div
      className={[
        'flex items-center justify-between',
        compact ? 'gap-2 px-3 py-2' : 'gap-3 px-[18px] py-3.5',
        divider ? 'relative' : '',
      ].join(' ')}
    >
      {divider && <ColDivider />}
      <span
        className={[
          'font-medium text-[var(--color-text-2)]',
          compact ? 'text-[12px] truncate min-w-0' : 'text-[13px]',
        ].join(' ')}
      >
        {label}
      </span>
      {children}
    </div>
  )
}

// ── Stepper ──────────────────────────────────────────────────────────

interface StepperProps {
  value: string
  onDec?: () => void
  onInc?: () => void
  /** Accessible name for the −/+ buttons (e.g. the control's label). */
  label?: string
  compact?: boolean
}

function Stepper({ value, onDec, onInc, label, compact = false }: StepperProps) {
  const btnCls = [
    compact ? 'w-6 h-6 text-[13px]' : 'w-7 h-7 text-[14px]',
    'rounded-lg grid place-items-center text-[var(--color-text-2)] bg-white/[0.06] hover:bg-[rgba(167,139,250,0.18)] hover:text-[var(--color-text-1)] transition-colors cursor-pointer',
  ].join(' ')
  return (
    <div
      className="inline-flex items-center gap-0.5 h-6 px-0.5 rounded-xl shrink-0"
      style={{ background: 'rgba(255,255,255,0.12)' }}
    >
      <button type="button" className={btnCls} onClick={onDec} aria-label={label ? `${label} −` : undefined}>−</button>
      <span
        className={[
          'font-mono font-semibold text-[var(--color-text-1)] text-center tabular-nums',
          compact ? 'text-[12px] min-w-[34px]' : 'text-[13px] min-w-[28px]',
        ].join(' ')}
      >
        {value}
      </span>
      <button type="button" className={btnCls} onClick={onInc} aria-label={label ? `${label} +` : undefined}>+</button>
    </div>
  )
}

// ── Card shell ────────────────────────────────────────────────────────

export function CardShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="rounded-[14px] border border-[var(--color-border)] overflow-hidden relative"
      style={{
        background: `radial-gradient(120% 100% at 0% 0%, var(--color-accent-dim) 0%, transparent 55%),
                     linear-gradient(180deg, rgba(255,255,255,0.045) 0%, rgba(255,255,255,0.02) 100%)`,
        boxShadow:
          'inset 0 1px 0 rgba(255,255,255,0.06), 0 4px 16px rgba(0,0,0,0.25)',
      }}
    >
      <AccentHairline />
      {children}
    </div>
  )
}

// ── Formatting helpers ────────────────────────────────────────────────

function useActiveSpeedKmh(): number {
  return resolveEffectiveKmh(useSimState())
}

function formatEta(distM: number, speedKmh: number, laps: number | null, t: Translate): string {
  if (distM <= 0 || speedKmh <= 0) return '--'
  if (laps === null) return '∞'
  const hours = (distM * laps) / 1000 / speedKmh
  return formatDurationS(hours * 3600, t)
}

// ── Per-mode card content ─────────────────────────────────────────────

function useTotalWaypointDist(loop: boolean): number {
  const { waypoints } = useSimState()
  return useMemo(() => {
    if (waypoints.length < 2) return 0
    let d = polylineDistanceM(waypoints)
    if (loop) {
      d += haversineM(waypoints[waypoints.length - 1], waypoints[0])
    }
    return d
  }, [waypoints, loop])
}

function useNavDist(): number {
  const { currentPos, destPos } = useSimDerived()
  return useMemo(() => {
    if (!currentPos || !destPos) return 0
    return haversineM(currentPos, destPos)
  }, [currentPos, destPos])
}

// ── Teleport card ─────────────────────────────────────────────────────

function TeleportCard() {
  const t = useT()
  const distM = useNavDist()
  const cdSecs = cooldownForDistM(distM)
  const cdDisplay = distM > 0 ? formatCooldownS(cdSecs, t) : '--'
  const { autoJitter, setAutoJitter } = useSimSettings()
  return (
    <CardShell>
      <div className="grid grid-cols-2 relative">
        <StatCell label={t('dock.distance')} value={formatDistanceM(distM)} />
        <StatCell
          label={t('dock.cooldown')}
          value={cdDisplay}
          accent
          divider
        />
        <RowDivider />
      </div>
      <ControlCell label={t('dock.auto_jitter')}>
        <Toggle checked={autoJitter} onChange={setAutoJitter} ariaLabel={t('dock.auto_jitter')} />
      </ControlCell>
    </CardShell>
  )
}

// ── Navigate card ─────────────────────────────────────────────────────

function NavigateCard() {
  const t = useT()
  const distM = useNavDist()
  const speedKmh = useActiveSpeedKmh()
  const eta = formatEta(distM, speedKmh, 1, t)
  return (
    <CardShell>
      <div className="grid grid-cols-2 relative">
        <StatCell label={t('dock.distance')} value={formatDistanceM(distM)} />
        <StatCell
          label={t('dock.est_time')}
          value={eta}
          accent
          divider
        />
      </div>
    </CardShell>
  )
}

// ── Loop card ─────────────────────────────────────────────────────────

function LoopCard() {
  const t = useT()
  const { loopLapCount } = useSimState()
  const { setLoopLapCount } = useSimActions()
  const loopEnabled = loopLapCount !== 1
  const totalDist = useTotalWaypointDist(loopEnabled)
  const speedKmh = useActiveSpeedKmh()
  const eta = formatEta(totalDist, speedKmh, loopLapCount, t)
  const displayCount = loopLapCount === null ? '∞' : String(loopLapCount)

  const handleToggle = (on: boolean) => {
    setLoopLapCount(on ? null : 1)
  }
  const handleDec = () => {
    if (loopLapCount === null) { setLoopLapCount(10) }
    else if (loopLapCount > 2) { setLoopLapCount(loopLapCount - 1) }
  }
  const handleInc = () => {
    if (loopLapCount === null) return
    if (loopLapCount >= 99) { setLoopLapCount(null) }
    else { setLoopLapCount(loopLapCount + 1) }
  }

  return (
    <CardShell>
      <div className="grid grid-cols-2 relative">
        <StatCell label={t('dock.distance')} value={formatDistanceM(totalDist)} />
        <StatCell
          label={t('dock.est_time')}
          value={eta}
          accent
          divider
        />
        <RowDivider />
      </div>
      <div className="grid grid-cols-2">
        <ControlCell label={t('dock.loop')}>
          <Toggle checked={loopEnabled} onChange={handleToggle} ariaLabel={t('dock.loop')} />
        </ControlCell>
        <ControlCell label={t('dock.count')} divider>
          <Stepper value={displayCount} onDec={handleDec} onInc={handleInc} label={t('dock.count')} />
        </ControlCell>
      </div>
    </CardShell>
  )
}

// ── Multi-Stop card ───────────────────────────────────────────────────

function MultiStopCard() {
  const t = useT()
  const { waypoints, pauseMultiStop } = useSimState()
  const { setPauseMultiStop } = useSimActions()
  const totalDist = useTotalWaypointDist(false)
  const speedKmh = useActiveSpeedKmh()
  // Multi-stop is a single pass through the stops (laps = 1), unlike Loop.
  const eta = formatEta(totalDist, speedKmh, 1, t)
  return (
    <CardShell>
      <div className="grid grid-cols-2 relative">
        <StatCell
          label={t('dock.total_distance')}
          value={formatDistanceM(totalDist)}
        />
        <StatCell
          label={t('dock.est_time')}
          value={eta}
          accent
          divider
        />
        <RowDivider />
      </div>
      <div className="grid grid-cols-2">
        {/* Pause toggle is now wired to the real, backend-honoured
            pauseMultiStop setting (was a dead toggle with internal-only
            local state). */}
        <ControlCell label={t('dock.pause_toggle')}>
          <Toggle
            checked={pauseMultiStop.enabled}
            onChange={(on) => setPauseMultiStop({ ...pauseMultiStop, enabled: on })}
            ariaLabel={t('dock.pause_toggle')}
          />
        </ControlCell>
        {/* Stops is a read-out, not a control — the count is driven by the
            waypoints placed on the map. Rendered as a value (was an inert
            Stepper whose +/- did nothing). */}
        <ControlCell label={t('dock.stops')} divider>
          <span className="font-mono text-[13px] font-semibold text-[var(--color-text-1)] tabular-nums min-w-[28px] text-center">
            {waypoints.length}
          </span>
        </ControlCell>
      </div>
    </CardShell>
  )
}

// ── Flower card ──────────────────────────────────────────────────────

function formatWait(secs: number): string {
  return secs >= 60 ? `${secs / 60}m` : `${secs}s`
}

function TransferSwitch({ value, onChange }: { value: FlowerTransfer; onChange: (v: FlowerTransfer) => void }) {
  const t = useT()
  const options: ReadonlyArray<{ v: FlowerTransfer; label: string }> = [
    { v: 'walk', label: t('dock.flower_walk') },
    { v: 'teleport', label: t('dock.flower_teleport') },
  ]
  return (
    <div
      role="radiogroup"
      aria-label={t('dock.flower_transfer')}
      className="inline-flex gap-0.5 p-0.5 rounded-lg bg-white/[0.06] shrink-0"
    >
      {options.map(({ v, label }) => {
        const on = value === v
        return (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(v)}
            className={[
              'h-6 px-2 rounded-md text-[12px] font-medium whitespace-nowrap transition-colors cursor-pointer',
              on
                ? 'bg-[var(--color-accent-dim)] text-[var(--color-accent-strong)]'
                : 'text-[var(--color-text-2)] hover:text-[var(--color-text-1)]',
            ].join(' ')}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}

// Settings only — the plan distance / ETA read-out lives in the dock
// header subtitle, because seven controls plus a stat row don't fit the
// dock's fixed body height.
function FlowerCard() {
  const t = useT()
  const { flowerSettings: s, setFlowerSettings } = useSimSettings()
  const L = FLOWER_LIMITS
  const set = (patch: Partial<FlowerSettings>) => setFlowerSettings({ ...s, ...patch })
  const clampStep = (v: number, lim: { min: number; max: number }) =>
    Math.min(lim.max, Math.max(lim.min, v))

  return (
    <CardShell>
      <div className="grid grid-cols-2 relative">
        <ControlCell compact label={t('dock.radius')}>
          <Stepper
            compact
            label={t('dock.radius')}
            value={`${s.radiusM}m`}
            onDec={() => set({ radiusM: clampStep(s.radiusM - L.radiusM.step, L.radiusM) })}
            onInc={() => set({ radiusM: clampStep(s.radiusM + L.radiusM.step, L.radiusM) })}
          />
        </ControlCell>
        <ControlCell compact divider label={t('dock.flower_segments')}>
          <Stepper
            compact
            label={t('dock.flower_segments')}
            value={String(s.segments)}
            onDec={() => set({ segments: clampStep(s.segments - L.segments.step, L.segments) })}
            onInc={() => set({ segments: clampStep(s.segments + L.segments.step, L.segments) })}
          />
        </ControlCell>
        <RowDivider />
      </div>
      <div className="grid grid-cols-2 relative">
        <ControlCell compact label={t('dock.flower_laps')}>
          <Stepper
            compact
            label={t('dock.flower_laps')}
            value={String(s.laps)}
            onDec={() => set({ laps: clampStep(s.laps - L.laps.step, L.laps) })}
            onInc={() => set({ laps: clampStep(s.laps + L.laps.step, L.laps) })}
          />
        </ControlCell>
        <ControlCell compact divider label={t('dock.flower_rounds')}>
          <Stepper
            compact
            label={t('dock.flower_rounds')}
            value={s.rounds === null ? '∞' : String(s.rounds)}
            onDec={() => set({ rounds: stepFlowerRounds(s.rounds, -1) })}
            onInc={() => set({ rounds: stepFlowerRounds(s.rounds, 1) })}
          />
        </ControlCell>
        <RowDivider />
      </div>
      <div className="grid grid-cols-2 relative">
        <ControlCell compact label={t('dock.flower_wait_before')}>
          <Stepper
            compact
            label={t('dock.flower_wait_before')}
            value={formatWait(s.waitBeforeS)}
            onDec={() => set({ waitBeforeS: stepFlowerWait(s.waitBeforeS, -1) })}
            onInc={() => set({ waitBeforeS: stepFlowerWait(s.waitBeforeS, 1) })}
          />
        </ControlCell>
        <ControlCell compact divider label={t('dock.flower_wait_after')}>
          <Stepper
            compact
            label={t('dock.flower_wait_after')}
            value={formatWait(s.waitAfterS)}
            onDec={() => set({ waitAfterS: stepFlowerWait(s.waitAfterS, -1) })}
            onInc={() => set({ waitAfterS: stepFlowerWait(s.waitAfterS, 1) })}
          />
        </ControlCell>
        <RowDivider />
      </div>
      <ControlCell compact label={t('dock.flower_transfer')}>
        <TransferSwitch value={s.transfer} onChange={(transfer) => set({ transfer })} />
      </ControlCell>
    </CardShell>
  )
}

// ── Random Walk card ──────────────────────────────────────────────────

function RandomWalkCard() {
  const t = useT()
  const { randomWalkRadius, setRandomWalkRadius } = useSimSettings()
  // Single radius picker. The old second column labelled "Waypoints" but
  // actually re-printed the radius (a label/value mismatch that read like a
  // bug); random walk has no fixed waypoint count, so it's dropped.
  return (
    <CardShell>
      <div className="flex flex-col gap-2 p-4">
        <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.10em] text-[var(--color-text-3)]">
          <span
            className="w-1 h-1 rounded-full bg-[var(--color-accent)] shadow-[0_0_6px_var(--color-accent)] opacity-70"
            aria-hidden="true"
          />
          {t('dock.radius')}
        </span>
        <div className="flex gap-1 flex-wrap">
          {RADIUS_PRESETS.map((r) => {
            const active = r === randomWalkRadius
            const label =
              r >= KM_THRESHOLD_M ? `${r / KM_THRESHOLD_M}km` : `${r}m`
            return (
              <button
                key={r}
                type="button"
                onClick={() => setRandomWalkRadius(r)}
                aria-pressed={active}
                className={[
                  'h-7 px-2.5 rounded-[7px] font-mono text-[12px] font-medium',
                  'transition-colors duration-120 cursor-pointer',
                  active
                    ? 'text-[var(--color-accent-strong)]'
                    : 'text-[var(--color-text-2)] hover:text-[var(--color-text-1)]',
                ].join(' ')}
                style={
                  active
                    ? {
                        background: 'var(--color-accent-dim)',
                        boxShadow:
                          'var(--shadow-avatar-ring-subtle)',
                      }
                    : undefined
                }
              >
                {label}
              </button>
            )
          })}
        </div>
      </div>
    </CardShell>
  )
}

// ── Joystick card ─────────────────────────────────────────────────────

function JoystickCard() {
  const t = useT()
  const { joystickSensitivity, setJoystickSensitivity } = useSimSettings()
  return (
    <CardShell>
      <div className="grid grid-cols-2 relative">
        <StatCell label={t('dock.speed')} value="0.0 m/s" />
        <StatCell
          label={t('dock.heading')}
          value="—"
          accent
          divider
        />
        <RowDivider />
      </div>
      <ControlCell label={t('dock.sensitivity')}>
        <Stepper
          value={String(joystickSensitivity)}
          onDec={() => setJoystickSensitivity(Math.max(JOYSTICK_SENSITIVITY_MIN, joystickSensitivity - 1))}
          onInc={() => setJoystickSensitivity(Math.min(JOYSTICK_SENSITIVITY_MAX, joystickSensitivity + 1))}
          label={t('dock.sensitivity')}
        />
      </ControlCell>
    </CardShell>
  )
}

// ── Public component ──────────────────────────────────────────────────

export default function ModeStatsCard() {
  const { mode } = useSimState()

  switch (mode) {
    case SimMode.Teleport:
      return <TeleportCard />
    case SimMode.Navigate:
      return <NavigateCard />
    case SimMode.Loop:
      return <LoopCard />
    case SimMode.MultiStop:
      return <MultiStopCard />
    case SimMode.RandomWalk:
      return <RandomWalkCard />
    case SimMode.Flower:
      return <FlowerCard />
    case SimMode.Joystick:
      return <JoystickCard />
  }
}
