// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useWebSocket } from './useWebSocket'
import type { WsMessage } from './useWebSocket'

/**
 * Characterization tests for useWebSocket. These pin CURRENT behavior:
 *
 * - Issue #5 regression: the subscribe-callback fan-out delivers every
 *   frame synchronously, so two back-to-back onmessage frames in the
 *   same microtask both reach a subscriber (the old useState<lastMessage>
 *   design lost the intermediate one to React 18 auto-batching).
 * - `connected` stays false after onopen and only flips true once the
 *   FIRST server frame arrives (firstMessageReceivedRef).
 * - Before any socket of the session has been accepted (backend still
 *   starting), reconnects run at a flat STARTUP_RETRY_INTERVAL (1000).
 * - After that, on close a reconnect is scheduled at the current backoff
 *   delay; the delay grows 1.5x per cycle from RECONNECT_INTERVAL (3000) and
 *   caps at MAX_RECONNECT_INTERVAL (30000); the first server frame on a
 *   socket resets it (a bare TCP open does not).
 * - A close with code 4001 (backend auth rejected) sets `authFailed` and
 *   backs off straight to MAX_RECONNECT_INTERVAL.
 * - On open, an auth frame `{type:'auth', token}` is sent first, with the
 *   token resolved from the Electron preload bridge
 *   `globalThis.geoMirage.getSessionToken()` (empty string when the
 *   bridge is absent or rejects), and never into a socket that closed
 *   while the token was being awaited.
 */

// Mirrors RECONNECT_INTERVAL / MAX_RECONNECT_INTERVAL in useWebSocket.ts.
const RECONNECT_INTERVAL = 3000
const MAX_RECONNECT_INTERVAL = 30000
const STARTUP_RETRY_INTERVAL = 1000

class MockWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  static instances: MockWebSocket[] = []

  url: string
  readyState: number = MockWebSocket.CONNECTING
  sentFrames: string[] = []

  onopen: (() => unknown) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: (() => void) | null = null

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sentFrames.push(data)
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.({ code: 1000 })
  }

  // --- test drivers -------------------------------------------------------

  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
  }

  simulateServerFrame(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) })
  }

  simulateRawFrame(data: string): void {
    this.onmessage?.({ data })
  }

  simulateServerClose(code = 1006): void {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.({ code })
  }
}

function latestSocket(): MockWebSocket {
  const instances = MockWebSocket.instances
  expect(instances.length).toBeGreaterThan(0)
  return instances[instances.length - 1]
}

// Get one socket accepted so the hook leaves its startup retry mode.
async function acceptLatest(): Promise<void> {
  await act(async () => { latestSocket().simulateOpen() })
  act(() => { latestSocket().simulateServerFrame({ type: 'cooldown_update', data: {} }) })
}

function parseFrames(ws: MockWebSocket): Array<Record<string, unknown>> {
  return ws.sentFrames.map((f) => JSON.parse(f) as Record<string, unknown>)
}

type SessionTokenBridge = { getSessionToken?: () => Promise<unknown> }

function stubBridge(bridge: SessionTokenBridge | undefined): void {
  vi.stubGlobal('geoMirage', bridge)
}

beforeEach(() => {
  vi.useFakeTimers()
  MockWebSocket.instances = []
  vi.stubGlobal('WebSocket', MockWebSocket)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useWebSocket — connection lifecycle', () => {
  it('opens a socket to the /ws/status endpoint on mount with connected=false', () => {
    const { result } = renderHook(() => useWebSocket())

    expect(MockWebSocket.instances).toHaveLength(1)
    expect(MockWebSocket.instances[0].url).toMatch(/^ws:\/\/.+\/ws\/status$/)
    expect(result.current.connected).toBe(false)
  })

  it('keeps connected=false after onopen until the FIRST server frame arrives', async () => {
    const { result } = renderHook(() => useWebSocket())
    const ws = latestSocket()

    await act(async () => {
      ws.simulateOpen()
    })
    // TCP open + auth sent is NOT enough — backend must speak first.
    expect(result.current.connected).toBe(false)

    act(() => {
      ws.simulateServerFrame({ type: 'cooldown_update', data: {} })
    })
    expect(result.current.connected).toBe(true)
  })

  it('flips connected=true even when the first frame is unparseable (peer proven alive), without fanning it out', async () => {
    const { result } = renderHook(() => useWebSocket())
    const ws = latestSocket()
    const received: WsMessage[] = []
    result.current.subscribe((m) => received.push(m))

    await act(async () => {
      ws.simulateOpen()
    })
    act(() => {
      ws.simulateRawFrame('not-json{{{')
    })

    expect(result.current.connected).toBe(true)
    expect(received).toHaveLength(0)

    // The stream survives the malformed frame: the next valid one is delivered.
    act(() => {
      ws.simulateServerFrame({ type: 'device_snapshot', data: { devices: [] } })
    })
    expect(received).toHaveLength(1)
    expect(received[0].type).toBe('device_snapshot')
  })

  it('resets connected to false when the server closes the socket', async () => {
    const { result } = renderHook(() => useWebSocket())
    const ws = latestSocket()

    await act(async () => {
      ws.simulateOpen()
    })
    act(() => {
      ws.simulateServerFrame({ type: 'cooldown_update', data: {} })
    })
    expect(result.current.connected).toBe(true)

    act(() => {
      ws.simulateServerClose()
    })
    expect(result.current.connected).toBe(false)
  })

  it('requires the NEW socket to re-prove itself after a reconnect (per-socket first-frame gate)', async () => {
    const { result } = renderHook(() => useWebSocket())
    const first = latestSocket()

    await act(async () => {
      first.simulateOpen()
    })
    act(() => {
      first.simulateServerFrame({ type: 'cooldown_update', data: {} })
    })
    expect(result.current.connected).toBe(true)

    act(() => {
      first.simulateServerClose()
    })
    act(() => {
      vi.advanceTimersByTime(RECONNECT_INTERVAL)
    })
    const second = latestSocket()
    expect(second).not.toBe(first)

    await act(async () => {
      second.simulateOpen()
    })
    // Last connection's frame must not count for this socket.
    expect(result.current.connected).toBe(false)

    act(() => {
      second.simulateServerFrame({ type: 'device_snapshot', data: {} })
    })
    expect(result.current.connected).toBe(true)
  })
})

describe('useWebSocket — issue #5 regression (synchronous fan-out, no batching loss)', () => {
  it('delivers two SYNCHRONOUS back-to-back frames to a subscriber, in order', async () => {
    const { result } = renderHook(() => useWebSocket())
    const ws = latestSocket()
    const received: WsMessage[] = []
    result.current.subscribe((m) => received.push(m))

    await act(async () => {
      ws.simulateOpen()
    })

    // The mode-switch scenario from issue #5: a stop + route_path pair
    // arriving in the same microtask. With useState<lastMessage> the
    // intermediate message was overwritten before the consumer effect
    // fired; the subscriber pattern must see BOTH.
    act(() => {
      ws.simulateServerFrame({ type: 'state_change', data: { state: 'idle' } })
      ws.simulateServerFrame({ type: 'route_path', data: { points: [] } })
    })

    expect(received).toHaveLength(2)
    expect(received[0]).toEqual({ type: 'state_change', data: { state: 'idle' } })
    expect(received[1]).toEqual({ type: 'route_path', data: { points: [] } })
  })

  it('fans out synchronously within the onmessage callback (no deferral to effects)', async () => {
    const { result } = renderHook(() => useWebSocket())
    const ws = latestSocket()
    let deliveredDuringDispatch = false
    result.current.subscribe(() => {
      deliveredDuringDispatch = true
    })

    await act(async () => {
      ws.simulateOpen()
    })
    ws.onmessage?.({ data: JSON.stringify({ type: 'ping', data: {} }) })

    // Delivered before control returns from onmessage — no act/flush needed.
    expect(deliveredDuringDispatch).toBe(true)
  })

  it('stops delivering to a subscriber after its unsubscribe function runs', async () => {
    const { result } = renderHook(() => useWebSocket())
    const ws = latestSocket()
    const received: WsMessage[] = []
    const unsubscribe = result.current.subscribe((m) => received.push(m))

    await act(async () => {
      ws.simulateOpen()
    })
    act(() => {
      ws.simulateServerFrame({ type: 'a', data: 1 })
    })
    unsubscribe()
    act(() => {
      ws.simulateServerFrame({ type: 'b', data: 2 })
    })

    expect(received).toHaveLength(1)
    expect(received[0].type).toBe('a')
  })

  it('a throwing subscriber does not stop other subscribers from receiving the frame', async () => {
    const { result } = renderHook(() => useWebSocket())
    const ws = latestSocket()
    const received: WsMessage[] = []
    result.current.subscribe(() => {
      throw new Error('subscriber blew up')
    })
    result.current.subscribe((m) => received.push(m))

    await act(async () => {
      ws.simulateOpen()
    })
    act(() => {
      ws.simulateServerFrame({ type: 'state_change', data: {} })
    })

    expect(received).toHaveLength(1)
  })
})

describe('useWebSocket — reconnect backoff', () => {
  it('retries at a flat STARTUP_RETRY_INTERVAL until a socket is first accepted', () => {
    const { result } = renderHook(() => useWebSocket())
    expect(result.current.everConnected).toBe(false)
    for (let i = 1; i <= 5; i++) {
      act(() => { latestSocket().simulateServerClose() })
      act(() => { vi.advanceTimersByTime(STARTUP_RETRY_INTERVAL - 1) })
      expect(MockWebSocket.instances).toHaveLength(i)
      act(() => { vi.advanceTimersByTime(1) })
      expect(MockWebSocket.instances).toHaveLength(i + 1)
    }
  })

  it('bumps connectEpoch and sets everConnected on each accepted socket', async () => {
    const { result } = renderHook(() => useWebSocket())
    expect(result.current.connectEpoch).toBe(0)
    await acceptLatest()
    expect(result.current.everConnected).toBe(true)
    expect(result.current.connectEpoch).toBe(1)
    act(() => { latestSocket().simulateServerClose() })
    expect(result.current.everConnected).toBe(true)
    act(() => { vi.advanceTimersByTime(RECONNECT_INTERVAL) })
    await acceptLatest()
    expect(result.current.connectEpoch).toBe(2)
  })

  it('schedules the first reconnect at RECONNECT_INTERVAL (3000ms) after close', async () => {
    renderHook(() => useWebSocket())
    await acceptLatest()
    const ws = latestSocket()

    act(() => {
      ws.simulateServerClose()
    })
    act(() => {
      vi.advanceTimersByTime(RECONNECT_INTERVAL - 1)
    })
    expect(MockWebSocket.instances).toHaveLength(1)

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(MockWebSocket.instances).toHaveLength(2)
  })

  it('grows the delay 1.5x per failed cycle and caps at MAX_RECONNECT_INTERVAL (30000ms)', async () => {
    renderHook(() => useWebSocket())
    await acceptLatest()

    // Delay is multiplied AFTER each timer fires, so cycle N waits the
    // pre-multiplication value: 3000, 4500, 6750, ... capped at 30000.
    const expectedWaits = [3000, 4500, 6750, 10125, 15187.5, 22781.25, 30000, 30000]

    for (const wait of expectedWaits) {
      const countBefore = MockWebSocket.instances.length
      act(() => {
        latestSocket().simulateServerClose()
      })
      act(() => {
        vi.advanceTimersByTime(Math.floor(wait) - 1)
      })
      expect(MockWebSocket.instances).toHaveLength(countBefore)

      act(() => {
        vi.advanceTimersByTime(2)
      })
      expect(MockWebSocket.instances).toHaveLength(countBefore + 1)
    }

    expect(expectedWaits[expectedWaits.length - 1]).toBe(MAX_RECONNECT_INTERVAL)
  })

  it('resets the backoff to RECONNECT_INTERVAL once the server sends a frame', async () => {
    renderHook(() => useWebSocket())
    await acceptLatest()

    // Grow the backoff through two failed cycles (3000ms, then 4500ms).
    act(() => {
      latestSocket().simulateServerClose()
    })
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    act(() => {
      latestSocket().simulateServerClose()
    })
    act(() => {
      vi.advanceTimersByTime(4500)
    })
    expect(MockWebSocket.instances).toHaveLength(3)

    // The first server frame resets the delay back to the base interval.
    await act(async () => {
      latestSocket().simulateOpen()
    })
    act(() => {
      latestSocket().simulateServerFrame({ type: 'cooldown_update', data: {} })
    })
    act(() => {
      latestSocket().simulateServerClose()
    })
    act(() => {
      vi.advanceTimersByTime(RECONNECT_INTERVAL - 1)
    })
    expect(MockWebSocket.instances).toHaveLength(3)
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(MockWebSocket.instances).toHaveLength(4)
  })
})

describe('useWebSocket — auth rejected (close code 4001)', () => {
  it('does not reset the backoff on a bare open that the server then closes', async () => {
    renderHook(() => useWebSocket())
    await acceptLatest()
    act(() => { latestSocket().simulateServerClose() })
    act(() => { vi.advanceTimersByTime(3000) })
    expect(MockWebSocket.instances).toHaveLength(2)

    // Open without any server frame, then close: the delay must keep
    // growing (4500ms), not snap back to 3000ms.
    await act(async () => { latestSocket().simulateOpen() })
    act(() => { latestSocket().simulateServerClose() })
    act(() => { vi.advanceTimersByTime(RECONNECT_INTERVAL) })
    expect(MockWebSocket.instances).toHaveLength(2)
    act(() => { vi.advanceTimersByTime(1500) })
    expect(MockWebSocket.instances).toHaveLength(3)
  })

  it('flags authFailed and backs off to MAX_RECONNECT_INTERVAL on 4001', async () => {
    const { result } = renderHook(() => useWebSocket())
    expect(result.current.authFailed).toBe(false)

    await act(async () => { latestSocket().simulateOpen() })
    act(() => { latestSocket().simulateServerClose(4001) })
    expect(result.current.authFailed).toBe(true)

    act(() => { vi.advanceTimersByTime(RECONNECT_INTERVAL * 2) })
    expect(MockWebSocket.instances).toHaveLength(1)
    act(() => { vi.advanceTimersByTime(MAX_RECONNECT_INTERVAL - RECONNECT_INTERVAL * 2) })
    expect(MockWebSocket.instances).toHaveLength(2)
  })

  it('clears authFailed once a later socket is accepted', async () => {
    const { result } = renderHook(() => useWebSocket())
    await act(async () => { latestSocket().simulateOpen() })
    act(() => { latestSocket().simulateServerClose(4001) })
    act(() => { vi.advanceTimersByTime(MAX_RECONNECT_INTERVAL) })

    await act(async () => { latestSocket().simulateOpen() })
    act(() => { latestSocket().simulateServerFrame({ type: 'cooldown_update', data: {} }) })
    expect(result.current.authFailed).toBe(false)
    expect(result.current.connected).toBe(true)
  })
})

describe('useWebSocket — auth-frame handshake', () => {
  it('sends an auth frame with the token from the preload bridge as the first frame on open', async () => {
    const getSessionToken = vi.fn().mockResolvedValue('secret-session-token')
    stubBridge({ getSessionToken })

    renderHook(() => useWebSocket())
    const ws = latestSocket()

    await act(async () => {
      ws.simulateOpen()
    })

    expect(getSessionToken).toHaveBeenCalledTimes(1)
    const frames = parseFrames(ws)
    expect(frames).toHaveLength(1)
    // NB: top-level `token` field — not the {type, data} envelope sendMessage uses.
    expect(frames[0]).toEqual({ type: 'auth', token: 'secret-session-token' })
  })

  it('sends an auth frame with an empty token when no preload bridge exists (dev mode)', async () => {
    stubBridge(undefined)

    renderHook(() => useWebSocket())
    const ws = latestSocket()

    await act(async () => {
      ws.simulateOpen()
    })

    expect(parseFrames(ws)).toEqual([{ type: 'auth', token: '' }])
  })

  it('falls back to an empty token when getSessionToken rejects', async () => {
    stubBridge({ getSessionToken: vi.fn().mockRejectedValue(new Error('IPC broke')) })

    renderHook(() => useWebSocket())
    const ws = latestSocket()

    await act(async () => {
      ws.simulateOpen()
    })

    expect(parseFrames(ws)).toEqual([{ type: 'auth', token: '' }])
  })

  it('falls back to an empty token when the bridge resolves a non-string value', async () => {
    stubBridge({ getSessionToken: vi.fn().mockResolvedValue(12345) })

    renderHook(() => useWebSocket())
    const ws = latestSocket()

    await act(async () => {
      ws.simulateOpen()
    })

    expect(parseFrames(ws)).toEqual([{ type: 'auth', token: '' }])
  })

  it('does NOT send the auth frame into a socket that closed while awaiting the token', async () => {
    let resolveToken!: (value: string) => void
    const tokenPromise = new Promise<string>((resolve) => {
      resolveToken = resolve
    })
    stubBridge({ getSessionToken: () => tokenPromise })

    renderHook(() => useWebSocket())
    const ws = latestSocket()

    await act(async () => {
      ws.simulateOpen()
    })
    // Socket dies while onopen is suspended on the token IPC.
    act(() => {
      ws.simulateServerClose()
    })
    await act(async () => {
      resolveToken('too-late-token')
      await Promise.resolve()
    })

    expect(ws.sentFrames).toHaveLength(0)
  })
})
