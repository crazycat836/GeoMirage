// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { useEffect } from 'react'
import { render, act, cleanup } from '@testing-library/react'
import { ToastProvider, useToastContext, useToastMsg } from './ToastContext'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('ToastContext', () => {
  it('keeps the actions value stable while a toast shows and clears', () => {
    // Mirrors App's DDI safety-timer effect, which lists the toast context in
    // its deps: every re-run restarts the timers and hides the Cancel button.
    const effectRuns = vi.fn()
    const renders = vi.fn()
    let show: ((msg: string, ms?: number) => void) | null = null

    function ActionsConsumer() {
      const toast = useToastContext()
      renders()
      show = toast.showToast
      useEffect(() => { effectRuns() }, [toast])
      return null
    }
    function MsgConsumer() {
      const msg = useToastMsg()
      return <span data-testid="msg">{msg ?? ''}</span>
    }

    const { getByTestId } = render(
      <ToastProvider>
        <ActionsConsumer />
        <MsgConsumer />
      </ToastProvider>,
    )
    expect(effectRuns).toHaveBeenCalledTimes(1)
    const rendersBefore = renders.mock.calls.length

    act(() => { show!('hello', 1000) })
    expect(getByTestId('msg').textContent).toBe('hello')

    act(() => { vi.advanceTimersByTime(1000) })
    expect(getByTestId('msg').textContent).toBe('')

    expect(effectRuns).toHaveBeenCalledTimes(1)
    expect(renders.mock.calls.length).toBe(rendersBefore)
  })
})
