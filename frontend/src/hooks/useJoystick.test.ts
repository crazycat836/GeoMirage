// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useJoystick, JOYSTICK_SEND_INTERVAL_MS } from './useJoystick'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function setup(active = true) {
  const send = vi.fn()
  let renders = 0
  const hook = renderHook(({ on }) => {
    renders++
    return useJoystick(send, on)
  }, { initialProps: { on: active } })
  return { send, hook, renders: () => renders }
}

describe('useJoystick', () => {
  it('caps a one-second drag at 20 frames and never re-renders its host', () => {
    const { send, hook, renders } = setup()
    const r0 = renders()
    // A pointer drag fires pointermove at ~120 Hz with ever-changing values.
    for (let i = 0; i < 120; i++) {
      act(() => {
        hook.result.current.updateFromPad(i % 360, 0.3 + (i % 50) / 100)
        vi.advanceTimersByTime(1000 / 120)
      })
    }
    act(() => { vi.advanceTimersByTime(JOYSTICK_SEND_INTERVAL_MS) })
    expect(send.mock.calls.length).toBeGreaterThan(5)
    expect(send.mock.calls.length).toBeLessThanOrEqual(1000 / JOYSTICK_SEND_INTERVAL_MS + 1)
    expect(JOYSTICK_SEND_INTERVAL_MS).toBeGreaterThanOrEqual(50)
    expect(renders()).toBe(r0)
    // The trailing frame carries the latest input.
    const last = send.mock.calls.at(-1)![1]
    expect(last.direction).toBe(119)
  })

  it('drops input that does not change the rounded value', () => {
    const { send, hook } = setup()
    act(() => { hook.result.current.updateFromPad(90, 0.5) })
    act(() => { vi.advanceTimersByTime(200) })
    act(() => { hook.result.current.updateFromPad(90, 0.5001) })
    act(() => { vi.advanceTimersByTime(200) })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('sends a release immediately and cancels the pending trailing frame', () => {
    const { send, hook } = setup()
    act(() => { hook.result.current.updateFromPad(90, 0.5) })
    act(() => { hook.result.current.updateFromPad(95, 0.6) }) // queued
    act(() => { hook.result.current.updateFromPad(0, 0) })
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1][1]).toMatchObject({ direction: 0, intensity: 0 })
    act(() => { vi.advanceTimersByTime(200) })
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('drops a queued frame when joystick mode exits', () => {
    const { send, hook } = setup()
    act(() => { hook.result.current.updateFromPad(90, 0.5) })
    act(() => { hook.result.current.updateFromPad(95, 0.6) })
    hook.rerender({ on: false })
    act(() => { vi.advanceTimersByTime(200) })
    expect(send).toHaveBeenCalledTimes(1)
  })
})
