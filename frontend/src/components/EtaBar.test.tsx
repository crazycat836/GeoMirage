// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import EtaBar from './EtaBar'
import { I18nProvider } from '../i18n'

const derived = { displaySpeed: 5, isPaused: false }
vi.mock('../contexts/SimContext', () => ({
  useSimActions: () => ({ handlePause: vi.fn(), handleResume: vi.fn() }),
}))
vi.mock('../contexts/SimDerivedContext', () => ({
  useSimDerived: () => derived,
}))

afterEach(() => { cleanup(); derived.isPaused = false })

function bar(state: string, progress: number, eta = 125) {
  return (
    <I18nProvider>
      <EtaBar state={state} progress={progress} remainingDistance={800} traveledDistance={200} eta={eta} />
    </I18nProvider>
  )
}

function liveRegions() {
  return Array.from(document.querySelectorAll('[aria-live]'))
}

describe('EtaBar accessibility', () => {
  it('keeps the ticking ETA stats out of any live region', () => {
    const { rerender } = render(bar('navigating', 0.2, 125))
    rerender(bar('navigating', 0.3, 124))
    for (const region of liveRegions()) {
      expect(region.textContent).not.toMatch(/00:02:0[45]/)
      expect(region.textContent).not.toMatch(/km\/h/)
    }
  })

  it('announces start, pause and arrival once each', () => {
    const { rerender } = render(bar('idle', 0))
    const region = () => liveRegions().map((r) => r.textContent).join('|')
    const empty = region()
    rerender(bar('navigating', 0.1))
    const started = region()
    expect(started).not.toBe(empty)
    rerender(bar('navigating', 0.2, 100))
    expect(region()).toBe(started)
    derived.isPaused = true
    rerender(bar('paused', 0.2, 100))
    const paused = region()
    expect(paused).not.toBe(started)
    derived.isPaused = false
    rerender(bar('idle', 1, 0))
    const arrived = region()
    expect(arrived).not.toBe(paused)
    expect(arrived).not.toBe('')
  })

  it('exposes the progress bar value', () => {
    render(bar('navigating', 0.42))
    const pb = screen.getByRole('progressbar')
    expect(pb.getAttribute('aria-valuenow')).toBe('42')
    expect(pb.getAttribute('aria-valuemin')).toBe('0')
    expect(pb.getAttribute('aria-valuemax')).toBe('100')
  })
})
