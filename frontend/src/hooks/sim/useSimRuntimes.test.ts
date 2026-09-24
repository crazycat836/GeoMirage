// @vitest-environment jsdom
/**
 * Primary-runtime selection. The primary runtime feeds the single-device
 * view (map pin, dock, space-bar, EtaBar), so it must follow the same
 * device `DeviceContext` calls primary (`connectedDevices[0]`) instead of
 * whichever udid happened to be inserted into `runtimes` first.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import {
  useSimRuntimes,
  emptyRuntime,
  primaryRuntimeKey,
  LOCAL_RUNTIME_KEY,
  type RuntimesMap,
} from './useSimRuntimes'

afterEach(cleanup)

const A = 'udid-A'
const B = 'udid-B'

function twoDevices(): RuntimesMap {
  return {
    [A]: { ...emptyRuntime(A), state: 'disconnected', currentPos: { lat: 1, lng: 1 } },
    [B]: { ...emptyRuntime(B), state: 'looping', currentPos: { lat: 2, lng: 2 } },
  }
}

describe('primaryRuntimeKey', () => {
  it('follows the primary udid even when it is not the first map entry', () => {
    expect(primaryRuntimeKey(twoDevices(), B)).toBe(B)
  })

  it('falls back to the first entry when no device is connected', () => {
    expect(primaryRuntimeKey(twoDevices(), null)).toBe(A)
  })

  it('uses the local slot when the primary udid has no entry yet', () => {
    const map: RuntimesMap = { [LOCAL_RUNTIME_KEY]: emptyRuntime(LOCAL_RUNTIME_KEY) }
    expect(primaryRuntimeKey(map, B)).toBe(LOCAL_RUNTIME_KEY)
  })

  it('returns null for an empty map', () => {
    expect(primaryRuntimeKey({}, null)).toBeNull()
  })
})

describe('useSimRuntimes.patchPrimaryRuntime', () => {
  it('writes to the primary udid, not the stale first entry', () => {
    const { result, rerender } = renderHook(
      ({ primary }: { primary: string | null }) => useSimRuntimes(primary),
      { initialProps: { primary: A } },
    )
    act(() => { result.current.setRuntimes(twoDevices()) })
    // A disconnects; B is now the primary device.
    rerender({ primary: B })
    act(() => { result.current.patchPrimaryRuntime({ currentPos: { lat: 9, lng: 9 } }) })
    expect(result.current.runtimes[B].currentPos).toEqual({ lat: 9, lng: 9 })
    expect(result.current.runtimes[A].currentPos).toEqual({ lat: 1, lng: 1 })
  })

  it('creates the primary entry by promoting the local slot', () => {
    const { result } = renderHook(() => useSimRuntimes(B))
    act(() => {
      result.current.setRuntimes({
        [LOCAL_RUNTIME_KEY]: { ...emptyRuntime(LOCAL_RUNTIME_KEY), currentPos: { lat: 3, lng: 3 } },
      })
    })
    act(() => { result.current.patchPrimaryRuntime({ state: 'navigating' }) })
    expect(result.current.runtimes[LOCAL_RUNTIME_KEY]).toBeUndefined()
    expect(result.current.runtimes[B]).toMatchObject({
      udid: B, state: 'navigating', currentPos: { lat: 3, lng: 3 },
    })
  })
})
