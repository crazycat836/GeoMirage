// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import ModeStatsCard from './ModeStatsCard'
import { SimMode } from '../../../hooks/useSimulation'
import { I18nProvider } from '../../../i18n'
import { STRINGS } from '../../../i18n/strings'

const simState = {
  mode: SimMode.Loop as SimMode,
  loopLapCount: 3 as number | null,
  waypoints: [],
  customSpeedKmh: null,
  moveMode: 'walking',
  pauseMultiStop: { enabled: false, min: 5, max: 20 },
}

vi.mock('../../../contexts/SimContext', () => ({
  useSimState: () => simState,
  useSimActions: () => ({ setLoopLapCount: vi.fn(), setPauseMultiStop: vi.fn() }),
}))
vi.mock('../../../contexts/SimDerivedContext', () => ({
  useSimDerived: () => ({ currentPos: null, destPos: null }),
}))
vi.mock('../../../contexts/SimSettingsContext', () => ({
  JOYSTICK_SENSITIVITY_MIN: 1,
  JOYSTICK_SENSITIVITY_MAX: 10,
  useSimSettings: () => ({
    autoJitter: false,
    setAutoJitter: vi.fn(),
    joystickSensitivity: 5,
    setJoystickSensitivity: vi.fn(),
  }),
}))

afterEach(cleanup)

function label(key: keyof typeof STRINGS): string {
  const lang = navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  return STRINGS[key][lang]
}

function renderMode(mode: SimMode) {
  simState.mode = mode
  render(<I18nProvider><ModeStatsCard /></I18nProvider>)
}

describe('ModeStatsCard dock controls are named', () => {
  it('Teleport auto-jitter is a named switch', () => {
    renderMode(SimMode.Teleport)
    const sw = screen.getByRole('switch', { name: label('dock.auto_jitter') })
    expect(sw.getAttribute('aria-checked')).toBe('false')
  })

  it('Loop toggle is a named switch and the lap stepper buttons are named', () => {
    renderMode(SimMode.Loop)
    expect(screen.getByRole('switch', { name: label('dock.loop') })).toBeTruthy()
    expect(screen.getByRole('button', { name: `${label('dock.count')} −` })).toBeTruthy()
    expect(screen.getByRole('button', { name: `${label('dock.count')} +` })).toBeTruthy()
  })

  it('Multi-stop pause toggle is a named switch', () => {
    renderMode(SimMode.MultiStop)
    expect(screen.getByRole('switch', { name: label('dock.pause_toggle') })).toBeTruthy()
  })

  it('Joystick sensitivity stepper buttons are named', () => {
    renderMode(SimMode.Joystick)
    expect(screen.getByRole('button', { name: `${label('dock.sensitivity')} +` })).toBeTruthy()
  })
})
