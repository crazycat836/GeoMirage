// @vitest-environment jsdom
/**
 * Same-name conflict prompt: Esc and backdrop clicks must back out without
 * saving anything, and the typed name must survive so the user can rename.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, act, fireEvent } from '@testing-library/react'

const h = vi.hoisted(() => ({
  handleRouteSave: vi.fn(),
}))

vi.mock('../../i18n', () => {
  const t = (k: string) => k
  return { useT: () => t }
})
vi.mock('../../contexts/ToastContext', () => ({ useToastContext: () => ({ showToast: () => {} }) }))
vi.mock('../../contexts/SimContext', () => ({
  useSimState: () => ({ waypoints: [{ lat: 25, lng: 121 }, { lat: 25.1, lng: 121.1 }], moveMode: 'walking' }),
}))
vi.mock('../../contexts/RouteLibraryContext', () => ({
  useRouteLibrary: () => ({
    handleRouteSave: h.handleRouteSave,
    routeCategories: [{ id: 'default', name: 'Default' }],
  }),
}))

import SaveRouteDialog from './SaveRouteDialog'

beforeEach(() => {
  vi.useFakeTimers()
  h.handleRouteSave.mockReset()
  h.handleRouteSave.mockResolvedValue({ kind: 'conflict', existingId: 'r1', existingCreatedAt: '2026-01-01T00:00:00' })
})
afterEach(() => { cleanup(); vi.useRealTimers() })

async function openConflict() {
  const onClose = vi.fn()
  render(<SaveRouteDialog open onClose={onClose} />)
  const input = screen.getByPlaceholderText('panel.route_name')
  fireEvent.change(input, { target: { value: 'Morning loop' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /generic\.save/ })) })
  expect(screen.getByRole('alertdialog')).toBeTruthy()
  expect(h.handleRouteSave).toHaveBeenCalledTimes(1)
  return onClose
}

describe('SaveRouteDialog same-name conflict', () => {
  it('Esc cancels without saving and keeps the typed name', async () => {
    const onClose = await openConflict()
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(h.handleRouteSave).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    expect((screen.getByPlaceholderText('panel.route_name') as HTMLInputElement).value).toBe('Morning loop')
  })

  it('backdrop click cancels without saving', async () => {
    await openConflict()
    const overlay = screen.getByRole('alertdialog').parentElement as HTMLElement
    await act(async () => { fireEvent.click(overlay) })
    expect(h.handleRouteSave).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('offers Cancel, Save as new and Overwrite, focusing Save as new', async () => {
    await openConflict()
    act(() => { vi.advanceTimersByTime(80) })
    expect(screen.getByRole('button', { name: 'generic.cancel' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'panel.route_overwrite_btn' })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'panel.route_save_new_btn' }))
  })

  it('Save as new saves with the new-policy', async () => {
    await openConflict()
    h.handleRouteSave.mockResolvedValue({ kind: 'created' })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'panel.route_save_new_btn' })) })
    expect(h.handleRouteSave).toHaveBeenLastCalledWith('Morning loop', expect.any(Array), 'walking', { categoryId: 'default', onConflict: 'new' })
  })
})
