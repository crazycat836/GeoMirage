// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useSerializedReorder } from './useSerializedReorder'

vi.mock('../lib/dev-log', () => ({ devLog: vi.fn(), devWarn: vi.fn() }))

afterEach(cleanup)

describe('useSerializedReorder', () => {
  it('keeps sending reorders after a refresh fails once', async () => {
    const post = vi.fn().mockRejectedValueOnce(new Error('busy')).mockResolvedValue(undefined)
    const refresh = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue(undefined)
    const { result } = renderHook(() => useSerializedReorder(post, refresh, 'reorder failed'))

    // First run: POST and the follow-up refresh both fail. The handler must
    // not reject (callers fire-and-forget it) and must release the guard.
    await act(async () => { await expect(result.current(['a', 'b'])).resolves.toBeUndefined() })

    await act(async () => { await result.current(['b', 'a']) })
    expect(post).toHaveBeenCalledTimes(2)
    expect(post).toHaveBeenLastCalledWith(['b', 'a'])
  })

  it('still drains the queued order when refresh fails', async () => {
    let releasePost: () => void = () => {}
    const post = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((r) => { releasePost = r }))
      .mockResolvedValue(undefined)
    const refresh = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue(undefined)
    const { result } = renderHook(() => useSerializedReorder(post, refresh, 'reorder failed'))

    let first: Promise<void> = Promise.resolve()
    act(() => { first = result.current(['a', 'b', 'c']) })
    await act(async () => { await result.current(['c', 'b', 'a']) }) // queued
    await act(async () => {
      releasePost()
      await first
    })
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2))
    expect(post).toHaveBeenLastCalledWith(['c', 'b', 'a'])
  })
})
