// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'
import LocatePcButton from './LocatePcButton'

vi.mock('../../services/usage', () => ({ useDialogUsage: () => {} }))
vi.mock('../../i18n', () => {
  const t = (k: string) => k
  return { useT: () => t }
})
vi.mock('../../contexts/SimContext', () => ({
  useSimActions: () => ({ handleTeleport: () => {} }),
  useSimState: () => ({ status: { running: false, paused: false } }),
}))
vi.mock('../../contexts/SimDerivedContext', () => ({
  useSimDerived: () => ({ isRunning: false, isPaused: false }),
}))
vi.mock('../../hooks/usePcLocation', () => ({
  usePcLocation: () => ({
    coord: { lat: 25, lng: 121, accuracy: 30, timestamp: Date.now() },
    loading: false,
    error: null,
    request: async () => null,
  }),
}))

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('LocatePcButton popover', () => {
  it('takes focus on open and hands it back to the trigger on Escape', () => {
    render(<LocatePcButton onFlyToCoordinate={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: 'locate.button_label' })
    trigger.focus()
    act(() => { fireEvent.click(trigger) })
    act(() => { vi.advanceTimersByTime(80) })

    const dialog = screen.getByRole('dialog')
    expect(dialog.contains(document.activeElement)).toBe(true)

    act(() => { fireEvent.keyDown(document, { key: 'Escape' }) })

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})
