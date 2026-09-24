// @vitest-environment jsdom
/**
 * `scan` must not overwrite device state that a WebSocket event updated
 * while `/api/device/list` was still in flight (the REST answer is older
 * than the WS event). Same race guard `connect` / `forget` already use.
 */
import { renderHook, act, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeviceInfo } from '../types/device'
import type { WsMessage } from './useWebSocket'

const listDevices = vi.fn<() => Promise<DeviceInfo[]>>()
vi.mock('../services/api', () => ({
  listDevices: () => listDevices(),
  connectDevice: vi.fn(),
  disconnectDevice: vi.fn(),
  forgetDevice: vi.fn(),
}))

import { useDevice } from './useDevice'

afterEach(() => {
  cleanup()
  listDevices.mockReset()
})

const A: DeviceInfo = {
  udid: 'udid-A', name: 'iPhone', ios_version: '18.0', connection_type: 'USB', is_connected: false,
}

function fakeWs() {
  const handlers = new Set<(m: WsMessage) => void>()
  return {
    subscribe: (fn: (m: WsMessage) => void) => {
      handlers.add(fn)
      return () => { handlers.delete(fn) }
    },
    send: (type: WsMessage['type'], data: unknown) => {
      act(() => { handlers.forEach((h) => h({ type, data })) })
    },
  }
}

describe('useDevice.scan', () => {
  it('drops a stale list when a WS device event lands during the request', async () => {
    let resolveList: (v: DeviceInfo[]) => void = () => {}
    listDevices.mockReturnValue(new Promise((r) => { resolveList = r }))
    const ws = fakeWs()
    const { result } = renderHook(() => useDevice(ws.subscribe))

    let pending: Promise<unknown> = Promise.resolve()
    act(() => { pending = result.current.scan() })
    ws.send('device_connected', { udid: A.udid, name: A.name, ios_version: A.ios_version })
    await act(async () => {
      resolveList([A]) // queried before the connect finished: is_connected=false
      await pending
    })

    expect(result.current.connectedDevices.map((d) => d.udid)).toEqual([A.udid])
    expect(result.current.connectedDevice?.udid).toBe(A.udid)
  })

  it('applies the list when no WS event raced it', async () => {
    listDevices.mockResolvedValue([{ ...A, is_connected: true }])
    const { result } = renderHook(() => useDevice(fakeWs().subscribe))
    await act(async () => { await result.current.scan() })
    expect(result.current.devices).toHaveLength(1)
    expect(result.current.connectedDevice?.udid).toBe(A.udid)
  })
})

describe('useDevice.everConnectedUdids', () => {
  it('remembers devices that were connected after they disconnect', async () => {
    const B: DeviceInfo = { ...A, udid: 'udid-B' }
    listDevices.mockResolvedValue([A, B])
    const ws = fakeWs()
    const { result } = renderHook(() => useDevice(ws.subscribe))
    await act(async () => { await result.current.scan() })
    expect(result.current.everConnectedUdids.size).toBe(0)

    ws.send('device_connected', { udid: A.udid, name: A.name, ios_version: A.ios_version })
    ws.send('device_disconnected', { udid: A.udid, udids: [A.udid], reason: 'user' })

    expect(result.current.connectedDevices).toEqual([])
    expect(result.current.lostUdids.has(A.udid)).toBe(false)
    expect(result.current.everConnectedUdids.has(A.udid)).toBe(true)
    expect(result.current.everConnectedUdids.has(B.udid)).toBe(false)
  })
})
