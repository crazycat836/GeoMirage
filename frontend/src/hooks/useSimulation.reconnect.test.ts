// @vitest-environment jsdom
/**
 * The status / last-position seed runs on mount and again on every accepted
 * WebSocket (`connectEpoch` bump), so a backend that was still starting at
 * mount still gets its last-position pin on screen.
 */
import { renderHook, cleanup, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  getStatus: vi.fn(),
  getLastDevicePosition: vi.fn(),
}))
vi.mock('../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/api')>()),
  ...api,
}))

import { useSimulation } from './useSimulation'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('useSimulation status seed', () => {
  it('re-fetches status and last position when connectEpoch bumps', async () => {
    api.getStatus.mockRejectedValue(new Error('ECONNREFUSED'))
    api.getLastDevicePosition.mockRejectedValue(new Error('ECONNREFUSED'))
    const { result, rerender } = renderHook(
      ({ epoch }: { epoch: number }) => useSimulation(undefined, { connectEpoch: epoch }),
      { initialProps: { epoch: 0 } },
    )
    await waitFor(() => expect(api.getStatus).toHaveBeenCalledTimes(1))
    expect(result.current.currentPosition).toBeNull()

    api.getStatus.mockResolvedValue({})
    api.getLastDevicePosition.mockResolvedValue({ position: { lat: 25, lng: 121 } })
    rerender({ epoch: 1 })

    await waitFor(() => expect(result.current.currentPosition).toEqual({ lat: 25, lng: 121 }))
    expect(api.getStatus).toHaveBeenCalledTimes(2)
    expect(api.getLastDevicePosition).toHaveBeenCalledTimes(2)
  })
})
