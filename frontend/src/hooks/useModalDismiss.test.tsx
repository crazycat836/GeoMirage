// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { useModalDismiss, useEscLayer } from './useModalDismiss'

afterEach(cleanup)

function Layer({ open, onDismiss, busy }: { open: boolean; onDismiss: () => void; busy?: boolean }) {
  useModalDismiss({ open, onDismiss, busy })
  return null
}

describe('useModalDismiss', () => {
  it('dismisses a single open layer on Escape', () => {
    const onDismiss = vi.fn()
    render(<Layer open onDismiss={onDismiss} />)

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('only dismisses the topmost layer when two layers are stacked', () => {
    const dismissOuter = vi.fn()
    const dismissInner = vi.fn()
    render(
      <>
        <Layer open onDismiss={dismissOuter} />
        <Layer open onDismiss={dismissInner} />
      </>,
    )

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(dismissInner).toHaveBeenCalledOnce()
    expect(dismissOuter).not.toHaveBeenCalled()
  })

  it('dismisses the remaining layer once the topmost one has closed', () => {
    const dismissOuter = vi.fn()
    const dismissInner = vi.fn()
    const { rerender } = render(
      <>
        <Layer open onDismiss={dismissOuter} />
        <Layer open onDismiss={dismissInner} />
      </>,
    )

    rerender(
      <>
        <Layer open onDismiss={dismissOuter} />
        <Layer open={false} onDismiss={dismissInner} />
      </>,
    )
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(dismissOuter).toHaveBeenCalledOnce()
    expect(dismissInner).not.toHaveBeenCalled()
  })

  it('swallows Escape entirely while the topmost layer is busy', () => {
    const dismissOuter = vi.fn()
    const dismissInner = vi.fn()
    render(
      <>
        <Layer open onDismiss={dismissOuter} />
        <Layer open onDismiss={dismissInner} busy />
      </>,
    )

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(dismissInner).not.toHaveBeenCalled()
    expect(dismissOuter).not.toHaveBeenCalled()
  })

  it('ignores an Escape that an inner control already handled', () => {
    const onDismiss = vi.fn()
    render(<Layer open onDismiss={onDismiss} />)

    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    e.preventDefault()
    document.dispatchEvent(e)

    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('ignores the Escape that closes an IME candidate window', () => {
    const onDismiss = vi.fn()
    render(<Layer open onDismiss={onDismiss} />)

    fireEvent.keyDown(document, { key: 'Escape', isComposing: true })

    expect(onDismiss).not.toHaveBeenCalled()
  })
})

function EscLayer({ active, onEscape }: { active: boolean; onEscape: () => void }) {
  useEscLayer(active, onEscape)
  return null
}

describe('useEscLayer', () => {
  it('shares one stack with useModalDismiss: a menu over a dialog closes alone', () => {
    const dismissDialog = vi.fn()
    const closeMenu = vi.fn()
    render(
      <>
        <Layer open onDismiss={dismissDialog} />
        <EscLayer active onEscape={closeMenu} />
      </>,
    )

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(closeMenu).toHaveBeenCalledOnce()
    expect(dismissDialog).not.toHaveBeenCalled()
  })
})
