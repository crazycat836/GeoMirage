// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'
import { I18nProvider } from '../../i18n'
import { useModalDismiss } from '../../hooks/useModalDismiss'
import AvatarPicker from './AvatarPicker'

vi.mock('../../services/usage', () => ({ useDialogUsage: () => {} }))
vi.mock('../../contexts/AvatarContext', () => ({
  useAvatarContext: () => ({
    current: { kind: 'preset', key: 'dot' },
    customDataUrl: '',
    applyPreset: () => {},
    applyCustom: () => true,
    uploadCustom: async () => {},
    clearCustom: () => {},
  }),
}))

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { cleanup(); vi.useRealTimers() })

// Stands in for the Settings popover the picker opens from.
// The picker opens later than the popover, as it does in the app.
function Parent({ pickerOpen, onParentDismiss, onPickerClose }: {
  pickerOpen: boolean
  onParentDismiss: () => void
  onPickerClose: () => void
}) {
  useModalDismiss({ open: true, onDismiss: onParentDismiss })
  return (
    <>
      <button type="button">settings row</button>
      {pickerOpen && <AvatarPicker anchor={new DOMRect(100, 400, 40, 40)} onClose={onPickerClose} />}
    </>
  )
}

describe('AvatarPicker', () => {
  it('takes focus on open and closes alone on Escape', () => {
    const onParentDismiss = vi.fn()
    const onPickerClose = vi.fn()
    const ui = (pickerOpen: boolean) => (
      <I18nProvider>
        <Parent pickerOpen={pickerOpen} onParentDismiss={onParentDismiss} onPickerClose={onPickerClose} />
      </I18nProvider>
    )
    const { rerender } = render(ui(false))
    ;(screen.getByText('settings row') as HTMLButtonElement).focus()
    rerender(ui(true))
    act(() => { vi.advanceTimersByTime(80) })
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)

    act(() => { fireEvent.keyDown(document, { key: 'Escape' }) })

    expect(onPickerClose).toHaveBeenCalledOnce()
    expect(onParentDismiss).not.toHaveBeenCalled()
  })
})
