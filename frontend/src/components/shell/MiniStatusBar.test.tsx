// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import MiniStatusBar from './MiniStatusBar'

const h = vi.hoisted(() => ({
  derived: { currentPos: null as { lat: number; lng: number } | null, isRunning: false },
}))

vi.mock('../../i18n', () => {
  const t = (k: string) => k
  return { useT: () => t, useI18n: () => ({ lang: 'en' }) }
})
vi.mock('../../contexts/SimContext', () => ({ useSimState: () => ({ backendPositionSynced: true }) }))
vi.mock('../../contexts/SimDerivedContext', () => ({ useSimDerived: () => h.derived }))
vi.mock('../../contexts/DeviceContext', () => ({ useDeviceContext: () => ({ connectedDevices: [] }) }))
vi.mock('../../contexts/ConnectionHealthContext', () => ({ useConnectionHealth: () => ({ device: 'ok' }) }))
vi.mock('../../hooks/useReverseGeocode', () => ({ useReverseGeocode: () => ({ countryCode: null, country: null }) }))
vi.mock('../../hooks/useWeather', () => ({ useWeather: () => null }))
vi.mock('./WeatherChip', () => ({ default: () => null }))

afterEach(cleanup)

function coordRows(pos: { lat: number; lng: number }) {
  h.derived = { currentPos: pos, isRunning: false }
  const { container } = render(<MiniStatusBar />)
  return Array.from(container.querySelectorAll('.lp-coord-row')).map((row) => ({
    val: row.querySelector('.val')!.textContent,
    unit: row.querySelector('.unit')!.textContent,
  }))
}

describe('MiniStatusBar live position', () => {
  it('shows southern latitudes as °S without a minus sign', () => {
    expect(coordRows({ lat: -33.8688, lng: 151.2093 })).toEqual([
      { val: '33.868800', unit: '°S' },
      { val: '151.209300', unit: '°E' },
    ])
  })

  it('shows western longitudes as °W without a minus sign', () => {
    expect(coordRows({ lat: 40.7128, lng: -74.006 })).toEqual([
      { val: '40.712800', unit: '°N' },
      { val: '74.006000', unit: '°W' },
    ])
  })
})
