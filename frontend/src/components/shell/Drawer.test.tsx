// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import Drawer from './Drawer'

vi.mock('../../services/usage', () => ({ useDialogUsage: () => {} }))
vi.mock('../../i18n', () => {
  const t = (k: string) => k
  return { useT: () => t }
})

afterEach(cleanup)

function renderDrawer(open: boolean) {
  return render(
    <Drawer open={open} onClose={vi.fn()} title="Library">
      <button type="button">row</button>
    </Drawer>,
  )
}

describe('Drawer', () => {
  it('takes a closed drawer out of the tab order and the accessibility tree', () => {
    // The panel stays mounted (it slides off-screen), so without inert its
    // rows are still reachable with Tab.
    renderDrawer(false)
    const panel = screen.getByRole('dialog', { hidden: true })
    expect(panel.hasAttribute('inert')).toBe(true)
    expect(panel.getAttribute('aria-hidden')).toBe('true')
  })

  it('leaves an open drawer interactive', () => {
    renderDrawer(true)
    const panel = screen.getByRole('dialog')
    expect(panel.hasAttribute('inert')).toBe(false)
    expect(panel.hasAttribute('aria-hidden')).toBe(false)
  })
})
