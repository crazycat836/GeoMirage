import { Footprints, Rabbit, Car } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useSimActions, useSimState } from '../../../contexts/SimContext'
import { useSimDerived } from '../../../contexts/SimDerivedContext'
import { MoveMode } from '../../../hooks/useSimulation'
import { useT, type StringKey } from '../../../i18n'
import {
  SPEED_PRESETS as BASE_SPEED_PRESETS,
  isSpeedPresetActive,
  type SpeedPresetMode,
} from '../../../lib/constants'

interface SpeedPreset {
  mode: MoveMode
  Icon: LucideIcon
  labelKey: StringKey
  value: number
}

// Per-preset UI metadata layered on top of the canonical km/h presets in
// `lib/constants`. Icons map to design's Walk / Run / Drive glyphs; lucide's
// Footprints / Rabbit / Car are the closest analogues.
const PRESET_UI: Record<SpeedPresetMode, { Icon: LucideIcon; labelKey: StringKey }> = {
  walking: { Icon: Footprints, labelKey: 'move.walking' },
  running: { Icon: Rabbit,     labelKey: 'move.running' },
  driving: { Icon: Car,        labelKey: 'move.driving' },
}

const SPEED_PRESETS: readonly SpeedPreset[] = BASE_SPEED_PRESETS.map((p) => ({
  mode: p.mode as MoveMode,
  value: p.kmh,
  ...PRESET_UI[p.mode],
}))

export default function SpeedToggle() {
  const t = useT()
  const {
    handleApplySpeed, setMoveMode, setCustomSpeedKmh, setSpeedMinKmh, setSpeedMaxKmh,
  } = useSimActions()
  const sim = useSimState()
  const { isRunning } = useSimDerived()

  const onPreset = (mode: MoveMode) => {
    setMoveMode(mode)
    setCustomSpeedKmh(null)
    setSpeedMinKmh(null)
    setSpeedMaxKmh(null)
    // While a route is running, the dock toggle is a *live* speed switch:
    // hot-swap the new preset onto the engine immediately. Pass the values
    // explicitly — reading them back off `sim` here would see the pre-update
    // state (the setMoveMode above hasn't re-rendered yet).
    if (isRunning) {
      void handleApplySpeed({
        moveMode: mode,
        customSpeedKmh: null,
        speedMinKmh: null,
        speedMaxKmh: null,
      })
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label={t('panel.speed')}
      className="flex gap-1 p-[3px] rounded-[10px] border border-[var(--color-border)] w-full"
      style={{ background: 'rgba(255,255,255,0.04)' }}
    >
      {SPEED_PRESETS.map(({ mode, Icon, labelKey, value }) => {
        const on = isSpeedPresetActive(mode, sim)
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onPreset(mode)}
            className={[
              'flex-1 inline-flex items-center justify-center gap-[7px]',
              'h-11 px-3.5 rounded-lg',
              'text-[13px] font-medium',
              'transition-all duration-150 cursor-pointer',
              on
                ? 'text-[var(--color-accent-strong)]'
                : 'text-[var(--color-text-2)] hover:text-[var(--color-text-1)] hover:bg-white/[0.04]',
            ].join(' ')}
            style={on ? {
              background: 'var(--color-accent-dim)',
            } : undefined}
          >
            <Icon className="w-3.5 h-3.5" />
            <span>{t(labelKey)}</span>
            <span
              className={[
                'font-mono text-[12px] font-semibold tabular-nums tracking-[-0.02em]',
                on ? 'text-[var(--color-accent-strong)]' : 'text-[var(--color-text-2)]',
              ].join(' ')}
              style={on
                ? { background: 'transparent', padding: '2px 0' }
                : { background: 'rgba(255,255,255,0.06)', padding: '2px 6px', borderRadius: '4px' }
              }
            >
              {value}
              {on && (
                <span className="text-2xs font-medium tracking-[0.08em] uppercase opacity-60 ml-1">
                  km/h
                </span>
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}
