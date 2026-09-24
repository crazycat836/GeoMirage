// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, act } from '@testing-library/react'
import Modal from './Modal'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('Modal initial focus', () => {
  it('moves focus to the first focusable element on open', () => {
    render(
      <Modal open onClose={vi.fn()} title="Title" actions={<button type="button">OK</button>}>
        body
      </Modal>,
    )

    act(() => {
      vi.advanceTimersByTime(60)
    })

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'OK' }))
  })

  it('falls back to the dialog container when nothing inside is focusable', () => {
    render(
      <Modal open onClose={vi.fn()} title="Title">
        body
      </Modal>,
    )

    act(() => {
      vi.advanceTimersByTime(60)
    })

    expect(document.activeElement).toBe(screen.getByRole('dialog'))
  })
})

describe('Modal accessible name', () => {
  it('names the dialog from a JSX title without an explicit ariaLabel', () => {
    render(
      <Modal open onClose={vi.fn()} title={<span><svg aria-hidden="true" />Save route</span>}>
        body
      </Modal>,
    )
    expect(screen.getByRole('dialog', { name: 'Save route' })).toBeTruthy()
  })

  it('prefers an explicit ariaLabel over the title', () => {
    render(
      <Modal open onClose={vi.fn()} title="Visible" ariaLabel="Spoken">
        body
      </Modal>,
    )
    expect(screen.getByRole('dialog', { name: 'Spoken' })).toBeTruthy()
  })
})
