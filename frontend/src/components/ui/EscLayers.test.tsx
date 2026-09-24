// @vitest-environment jsdom
/**
 * One Escape closes only the topmost surface: a row menu or an inline
 * rename inside a dialog must not also close the dialog behind it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'
import Modal from '../Modal'
import KebabMenu from './KebabMenu'
import InlineRenameInput from './InlineRenameInput'

vi.mock('../../services/usage', () => ({ useDialogUsage: () => {} }))

afterEach(cleanup)

describe('Escape inside a dialog', () => {
  it('closes an open kebab menu without closing the dialog', () => {
    const onClose = vi.fn()
    render(
      <Modal open onClose={onClose} ariaLabel="dialog">
        <KebabMenu ariaLabel="Row actions" items={[{ id: 'a', label: 'Edit', onSelect: vi.fn() }]} />
      </Modal>,
    )
    const trigger = screen.getByRole('button', { name: 'Row actions' })
    act(() => { fireEvent.click(trigger) })
    expect(screen.queryByRole('menu')).not.toBeNull()

    act(() => { fireEvent.keyDown(document, { key: 'Escape' }) })

    expect(screen.queryByRole('menu')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(trigger)

    // With the menu gone, the next Escape reaches the dialog.
    act(() => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('cancels an inline rename without closing the dialog', () => {
    const onClose = vi.fn()
    const onCancel = vi.fn()
    render(
      <Modal open onClose={onClose} ariaLabel="dialog">
        <InlineRenameInput value="x" onChange={vi.fn()} onCommit={vi.fn()} onCancel={onCancel} />
      </Modal>,
    )

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })

    expect(onCancel).toHaveBeenCalledOnce()
    expect(onClose).not.toHaveBeenCalled()
  })
})
