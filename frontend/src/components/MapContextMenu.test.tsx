// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'
import MapContextMenu from './MapContextMenu'
import { I18nProvider } from '../i18n'

vi.mock('../services/api', () => ({ reverseGeocode: vi.fn(async () => null) }))

afterEach(cleanup)

const STATE = { visible: true, x: 10, y: 10, lat: 25.03, lng: 121.56 }

function renderMenu() {
  const onClose = vi.fn()
  const onTeleport = vi.fn()
  render(
    <I18nProvider>
      <MapContextMenu
        state={STATE}
        onClose={onClose}
        onTeleport={onTeleport}
        onNavigate={vi.fn()}
        onAddBookmark={vi.fn()}
        deviceConnected
      />
    </I18nProvider>,
  )
  return { onClose, onTeleport }
}

async function flushFocus() {
  await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
}

describe('MapContextMenu keyboard', () => {
  it('exposes a menu whose actions are focusable buttons', () => {
    renderMenu()
    expect(screen.getByRole('menu')).toBeTruthy()
    const items = screen.getAllByRole('menuitem')
    expect(items.length).toBeGreaterThanOrEqual(5)
    for (const item of items) expect(item.tagName).toBe('BUTTON')
  })

  it('closes on Escape', () => {
    const { onClose } = renderMenu()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('focuses the first item on open and moves with the arrow keys', async () => {
    const { onTeleport } = renderMenu()
    await flushFocus()
    const items = screen.getAllByRole('menuitem')
    expect(document.activeElement).toBe(items[0])
    fireEvent.keyDown(items[0], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[1])
    fireEvent.keyDown(items[1], { key: 'ArrowUp' })
    fireEvent.keyDown(items[0], { key: 'ArrowUp' })
    expect(document.activeElement).toBe(items[items.length - 1])
    const teleport = screen.getByRole('menuitem', { name: /teleport|瞬移/i })
    fireEvent.click(teleport)
    expect(onTeleport).toHaveBeenCalledWith(STATE.lat, STATE.lng)
  })
})
