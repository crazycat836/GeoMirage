// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, act, fireEvent } from '@testing-library/react'
import type { ReactNode } from 'react'
import { I18nProvider } from '../../i18n'
import { ToastProvider } from '../../contexts/ToastContext'
import TagManagerDialog from './TagManagerDialog'
import PlaceManagerDialog from './PlaceManagerDialog'
import BulkCoordsDialog from './BulkCoordsDialog'
import BookmarkEditDialog from './BookmarkEditDialog'

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

describe('manager dialogs', () => {
  // Every change in these dialogs saves immediately, so the only button
  // closes the dialog; calling it "Cancel" suggests the changes are undone.
  it('labels the close button Done, not Cancel', () => {
    wrap(<TagManagerDialog open onClose={vi.fn()} tags={[]} />)
    expect(screen.getByRole('button', { name: /^(完成|Done)$/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^(取消|Cancel)$/ })).toBeNull()
    cleanup()
    wrap(<PlaceManagerDialog open onClose={vi.fn()} places={[]} onAdd={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getByRole('button', { name: /^(完成|Done)$/ })).toBeTruthy()
  })
})

function clickBackdrop() {
  fireEvent.click(document.querySelector('.modal-overlay')!)
}

describe('unsaved input survives a backdrop click', () => {
  it('BulkCoordsDialog closes on backdrop while empty, not after text is pasted', () => {
    const onCancel = vi.fn()
    wrap(<BulkCoordsDialog open mode="bookmarks" onCancel={onCancel} onConfirm={vi.fn()} />)
    clickBackdrop()
    expect(onCancel).toHaveBeenCalledOnce()

    fireEvent.change(document.querySelector('textarea')!, { target: { value: '25.03, 121.56' } })
    clickBackdrop()
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('BookmarkEditDialog closes on backdrop while untouched, not after typing', () => {
    const onClose = vi.fn()
    wrap(
      <BookmarkEditDialog
        open
        mode="create"
        currentPosition={{ lat: 25, lng: 121 }}
        places={[]}
        tags={[]}
        onClose={onClose}
        onSubmit={vi.fn()}
      />,
    )
    clickBackdrop()
    expect(onClose).toHaveBeenCalledOnce()

    const nameInput = screen.getAllByRole('textbox')[0]
    fireEvent.change(nameInput, { target: { value: 'Cafe' } })
    clickBackdrop()
    expect(onClose).toHaveBeenCalledOnce()
  })
})
