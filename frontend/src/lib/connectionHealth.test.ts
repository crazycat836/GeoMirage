import { describe, it, expect } from 'vitest'
import { deriveConnectionHealth, OFFLINE_THRESHOLD_MS } from './connectionHealth'

// Pure-function tests for the (transport, device, time) → health derivation.
// Every UI gating decision (Start button, Move button, banner copy,
// stale dimming) ultimately reads this output, so the table below is
// the one place to lock in semantics.

describe('deriveConnectionHealth', () => {
  const baseInput = {
    wsConnected: true,
    disconnectedAt: null as number | null,
    now: 1_000_000,
    connectedCount: 0,
    lostCount: 0,
  }

  it('reports open + none when WS is up and no devices known', () => {
    const h = deriveConnectionHealth(baseInput)
    expect(h).toEqual({
      ws: 'open',
      device: 'none',
      canOperate: false,
      hint: null,
    })
  })

  it('reports open + connected + canOperate when WS up and a device is connected', () => {
    const h = deriveConnectionHealth({ ...baseInput, connectedCount: 1 })
    expect(h.ws).toBe('open')
    expect(h.device).toBe('connected')
    expect(h.canOperate).toBe(true)
    expect(h.hint).toBeNull()
  })

  it('reports lost + device_lost hint when only lostUdids exist', () => {
    const h = deriveConnectionHealth({ ...baseInput, lostCount: 1 })
    expect(h.device).toBe('lost')
    expect(h.hint).toBe('device_lost')
    expect(h.canOperate).toBe(false)
  })

  describe('WS down', () => {
    it('classifies as reconnecting before the threshold elapses', () => {
      const h = deriveConnectionHealth({
        ...baseInput,
        wsConnected: false,
        disconnectedAt: 1_000_000 - 5_000, // 5s ago
        now: 1_000_000,
      })
      expect(h.ws).toBe('reconnecting')
      expect(h.hint).toBe('ws_reconnecting')
      expect(h.canOperate).toBe(false)
    })

    it('classifies as offline once the threshold elapses', () => {
      const h = deriveConnectionHealth({
        ...baseInput,
        wsConnected: false,
        disconnectedAt: 1_000_000 - OFFLINE_THRESHOLD_MS,
        now: 1_000_000,
      })
      expect(h.ws).toBe('offline')
      expect(h.hint).toBe('ws_offline')
    })

    it('treats a known-connected device as stale (not connected) while WS is down', () => {
      const h = deriveConnectionHealth({
        ...baseInput,
        wsConnected: false,
        disconnectedAt: 1_000_000 - 1_000,
        now: 1_000_000,
        connectedCount: 1,
      })
      expect(h.device).toBe('stale')
      expect(h.canOperate).toBe(false)
    })

    it('treats null disconnectedAt as "just disconnected" (offlineMs = 0)', () => {
      // Defensive: in the React code, the effect that sets
      // disconnectedAt may run a frame later than the memo. The
      // derivation should still return reconnecting (not offline)
      // when the timestamp hasn't been recorded yet.
      const h = deriveConnectionHealth({
        ...baseInput,
        wsConnected: false,
        disconnectedAt: null,
        now: 1_000_000,
      })
      expect(h.ws).toBe('reconnecting')
    })

    it('clamps negative offline durations (clock skew) to 0', () => {
      const h = deriveConnectionHealth({
        ...baseInput,
        wsConnected: false,
        disconnectedAt: 1_000_000 + 5_000, // future
        now: 1_000_000,
      })
      expect(h.ws).toBe('reconnecting')
    })

    it('hint severity: WS outage dominates device_lost', () => {
      const h = deriveConnectionHealth({
        ...baseInput,
        wsConnected: false,
        disconnectedAt: 1_000_000 - OFFLINE_THRESHOLD_MS,
        now: 1_000_000,
        lostCount: 1,
      })
      expect(h.hint).toBe('ws_offline')
    })
  })

  it('honours the offlineThresholdMs override (used by tests)', () => {
    const h = deriveConnectionHealth({
      ...baseInput,
      wsConnected: false,
      disconnectedAt: 1_000_000 - 100,
      now: 1_000_000,
      offlineThresholdMs: 50,
    })
    expect(h.ws).toBe('offline')
  })

  it('canOperate is true ONLY when ws=open AND device=connected', () => {
    // table-driven: enumerate states that should NOT canOperate
    const cases = [
      { wsConnected: true,  connectedCount: 0, lostCount: 0 }, // none
      { wsConnected: true,  connectedCount: 0, lostCount: 1 }, // lost
      { wsConnected: false, connectedCount: 0, lostCount: 0, disconnectedAt: 999_000 }, // reconnecting
      { wsConnected: false, connectedCount: 1, lostCount: 0, disconnectedAt: 999_000 }, // stale
    ]
    for (const c of cases) {
      const h = deriveConnectionHealth({ ...baseInput, ...c })
      expect(h.canOperate, JSON.stringify(c)).toBe(false)
    }
    const ok = deriveConnectionHealth({ ...baseInput, connectedCount: 1 })
    expect(ok.canOperate).toBe(true)
  })

  it('reports ws_auth_failed instead of reconnecting/offline when auth was rejected', () => {
    const down = { ...baseInput, wsConnected: false, wsAuthFailed: true }
    expect(deriveConnectionHealth({ ...down, disconnectedAt: baseInput.now }).hint).toBe('ws_auth_failed')
    expect(deriveConnectionHealth({
      ...down,
      disconnectedAt: baseInput.now - OFFLINE_THRESHOLD_MS * 2,
    }).hint).toBe('ws_auth_failed')
  })

  it('ignores a stale auth-failed flag once WS is open', () => {
    const h = deriveConnectionHealth({ ...baseInput, wsAuthFailed: true })
    expect(h.hint).toBeNull()
  })
})
