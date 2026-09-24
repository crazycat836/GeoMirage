// @vitest-environment jsdom
// Shared by RoutesPanel and SaveRouteDialog: dismissing must never resolve
// to a save policy.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'

vi.mock('../../i18n', () => {
  const t = (k: string) => k
  return { useT: () => t }
})

import RouteOverwriteDialog from './RouteOverwriteDialog'

afterEach(cleanup)

function setup() {
  const onResolve = vi.fn()
  const onCancel = vi.fn()
  render(<RouteOverwriteDialog name="A" existingCreatedAt={null} onResolve={onResolve} onCancel={onCancel} />)
  return { onResolve, onCancel }
}

describe('RouteOverwriteDialog', () => {
  it('Esc cancels without resolving', () => {
    const { onResolve, onCancel } = setup()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onResolve).not.toHaveBeenCalled()
  })

  it('backdrop click cancels without resolving', () => {
    const { onResolve, onCancel } = setup()
    fireEvent.click(screen.getByRole('alertdialog').parentElement as HTMLElement)
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onResolve).not.toHaveBeenCalled()
  })

  it('buttons resolve to their policy', () => {
    const { onResolve } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'panel.route_save_new_btn' }))
    fireEvent.click(screen.getByRole('button', { name: 'panel.route_overwrite_btn' }))
    expect(onResolve.mock.calls).toEqual([['new'], ['overwrite']])
  })
})
