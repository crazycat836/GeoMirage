// @vitest-environment jsdom
/**
 * The derived single-device view (`primaryRuntime`, `currentPosition`,
 * `status`) follows the primary udid handed in by SimProvider
 * (`DeviceContext.primaryDevice`), so a disconnected first device no
 * longer pins the map / dock / space-bar to itself.
 */
import { renderHook, act, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useSimulation } from './useSimulation'
import type { WsSubscribe } from './useSimulation'
import type { WsMessage } from './useWebSocket'

afterEach(cleanup)

const A = 'udid-A'
const B = 'udid-B'

function fakeWs() {
  const handlers = new Set<(m: WsMessage) => void>()
  const subscribe: WsSubscribe = (fn) => {
    handlers.add(fn)
    return () => { handlers.delete(fn) }
  }
  const send = (type: WsMessage['type'], data: unknown) => {
    act(() => { handlers.forEach((h) => h({ type, data })) })
  }
  return { subscribe, send }
}

describe('primary runtime', () => {
  it('points at the still-connected device after the first one disconnects', () => {
    const ws = fakeWs()
    const { result, rerender } = renderHook(
      ({ primary }: { primary: string | null }) => useSimulation(ws.subscribe, { primaryUdid: primary }),
      { initialProps: { primary: A as string | null } },
    )
    ws.send('device_connected', { udid: A })
    ws.send('device_connected', { udid: B })
    ws.send('state_change', { udid: A, state: 'looping' })
    ws.send('state_change', { udid: B, state: 'looping' })
    ws.send('position_update', { udid: B, lat: 2, lng: 2 })

    ws.send('device_disconnected', { udid: A, udids: [A], reason: 'usb_removed' })
    rerender({ primary: B })

    expect(result.current.primaryRuntime?.udid).toBe(B)
    expect(result.current.status.running).toBe(true)
    expect(result.current.currentPosition).toEqual({ lat: 2, lng: 2 })
  })

  it('shows the new device position after swapping iPhones in one session', () => {
    const ws = fakeWs()
    const { result, rerender } = renderHook(
      ({ primary }: { primary: string | null }) => useSimulation(ws.subscribe, { primaryUdid: primary }),
      { initialProps: { primary: A as string | null } },
    )
    ws.send('device_connected', { udid: A })
    ws.send('position_update', { udid: A, lat: 1, lng: 1 })
    ws.send('device_disconnected', { udid: A, udids: [A], reason: 'usb_removed' })
    rerender({ primary: null })

    ws.send('device_connected', { udid: B })
    rerender({ primary: B })
    ws.send('position_update', { udid: B, lat: 5, lng: 5 })

    expect(result.current.currentPosition).toEqual({ lat: 5, lng: 5 })
  })
})
