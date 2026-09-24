// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import JoystickPad from './JoystickPad'
import { I18nProvider } from '../i18n'
import { useModalDismiss } from '../hooks/useModalDismiss'

afterEach(cleanup)

function OpenLayer() {
  useModalDismiss({ open: true, onDismiss: () => {} })
  return null
}

function renderPad(extra?: React.ReactNode) {
  const onMove = vi.fn()
  const onRelease = vi.fn()
  const utils = render(
    <I18nProvider>
      <JoystickPad direction={0} intensity={0} onMove={onMove} onRelease={onRelease} />
      {extra}
    </I18nProvider>,
  )
  return { onMove, onRelease, ...utils }
}

describe('JoystickPad keyboard control', () => {
  it('drives the joystick with WASD when focus is on the page', () => {
    const { onMove, onRelease } = renderPad()
    fireEvent.keyDown(document.body, { key: 'w' })
    expect(onMove).toHaveBeenCalledWith(0, 1)
    fireEvent.keyUp(document.body, { key: 'w' })
    expect(onRelease).toHaveBeenCalledOnce()
  })

  it('ignores Cmd/Ctrl/Alt combos so Cmd+A keeps its default', () => {
    const { onMove } = renderPad()
    const ev = new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true, cancelable: true })
    document.body.dispatchEvent(ev)
    fireEvent.keyDown(document.body, { key: 's', ctrlKey: true })
    fireEvent.keyDown(document.body, { key: 'd', altKey: true })
    expect(onMove).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(false)
  })

  it('releases held directions when Cmd is released (macOS drops the letter keyup)', () => {
    const { onMove, onRelease } = renderPad()
    fireEvent.keyDown(document.body, { key: 'd' })
    expect(onMove).toHaveBeenCalledOnce()
    // Cmd pressed after D; D's keyup never arrives, only Meta's.
    fireEvent.keyUp(document.body, { key: 'Meta' })
    expect(onRelease).toHaveBeenCalledOnce()
  })

  it('ignores arrows while focus is inside a menu or tab list', () => {
    const { onMove, getByTestId } = renderPad(
      <>
        <div role="menu"><button data-testid="item">x</button></div>
        <div role="tablist"><button data-testid="tab">t</button></div>
      </>,
    )
    fireEvent.keyDown(getByTestId('item'), { key: 'ArrowDown' })
    fireEvent.keyDown(getByTestId('tab'), { key: 'ArrowRight' })
    expect(onMove).not.toHaveBeenCalled()
  })

  it('ignores keys another handler already consumed', () => {
    const { onMove } = renderPad()
    const ev = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })
    ev.preventDefault()
    document.body.dispatchEvent(ev)
    expect(onMove).not.toHaveBeenCalled()
  })

  it('ignores keys while a dialog / drawer layer is open', () => {
    const { onMove } = renderPad(<OpenLayer />)
    fireEvent.keyDown(document.body, { key: 'ArrowUp' })
    expect(onMove).not.toHaveBeenCalled()
  })
})
