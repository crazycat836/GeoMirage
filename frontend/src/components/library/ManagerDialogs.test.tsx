// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { I18nProvider } from '../../i18n'
import { ToastProvider } from '../../contexts/ToastContext'
import TagManagerDialog from './TagManagerDialog'
import PlaceManagerDialog from './PlaceManagerDialog'
import BulkCoordsDialog from './BulkCoordsDialog'

vi.mock('../../contexts/BookmarkContext', () => ({
  useBookmarkContext: () => ({ places: [{ id: 'default', name: 'Default' }] }),
}))

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { cleanup(); vi.useRealTimers() })

function wrap(node: ReactNode) {
  return render(
    <I18nProvider>
      <ToastProvider>
        <button type="button">trigger</button>
        {node}
      </ToastProvider>
    </I18nProvider>,
  )
}

function expectFocusInsideDialog() {
  act(() => { vi.advanceTimersByTime(80) })
  const dialog = screen.getByRole('dialog')
  expect(dialog.contains(document.activeElement)).toBe(true)
}

describe('library dialogs take focus on open', () => {
  it('TagManagerDialog', () => {
    wrap(<TagManagerDialog open onClose={vi.fn()} tags={[{ id: 't1', name: 'Tag', color: '#fff' } as never]} />)
    ;(screen.getByText('trigger') as HTMLButtonElement).focus()
    expectFocusInsideDialog()
  })

  it('PlaceManagerDialog', () => {
    wrap(<PlaceManagerDialog open onClose={vi.fn()} places={[]} onAdd={vi.fn()} onDelete={vi.fn()} />)
    ;(screen.getByText('trigger') as HTMLButtonElement).focus()
    expectFocusInsideDialog()
  })

  it('BulkCoordsDialog focuses the textarea', () => {
    wrap(<BulkCoordsDialog open mode="bookmarks" onCancel={vi.fn()} onConfirm={vi.fn()} />)
    act(() => { vi.advanceTimersByTime(80) })
    expect(document.activeElement?.tagName).toBe('TEXTAREA')
  })
})
