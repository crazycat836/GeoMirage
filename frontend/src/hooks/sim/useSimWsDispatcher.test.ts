// @vitest-environment jsdom
/**
 * CHARACTERIZATION tests for useSimWsDispatcher (single-write architecture).
 *
 * Every WS frame is routed into ONE home: per-device state goes into the
 * `runtimes` map (udid-tagged frames target that device's slot; untagged
 * frames target the primary/local slot), and session-global state
 * (overlays, DDI, error banner, sync flag) goes through dedicated
 * setters. The legacy single-device surface no longer exists — it is
 * DERIVED from the primary runtime in `useSimulation`, so asserting the
 * primary runtime asserts what single-device consumers observe.
 *
 * Asymmetries translated from the pre-refactor dual-write tests are
 * marked with "TRANSLATED ASYMMETRY" comments: where the legacy surface
 * and the runtimes map used to disagree, the runtime now reproduces what
 * the LEGACY surface showed (legacy was what the UI actually displayed).
 *
 * The harness mounts the REAL `useSimRuntimes` hook so slot promotion
 * (local → first udid) is exercised, not mocked.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useMemo } from 'react'
import type { SetStateAction } from 'react'
import { useSimWsDispatcher } from './useSimWsDispatcher'
import type { SimWsSetters, WsSubscribe } from './useSimWsDispatcher'
import { useSimRuntimes, emptyRuntime, LOCAL_RUNTIME_KEY } from './useSimRuntimes'
import type { DeviceRuntime, RuntimesMap, UseSimRuntimesValue } from './useSimRuntimes'
import type { LatLng } from './types'
import type { WsMessage } from '../useWebSocket'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// ── Harness ────────────────────────────────────────────────────────────

const UDID_A = 'udid-A'
const UDID_B = 'udid-B'

interface GlobalState {
  backendPositionSynced: boolean
  destination: LatLng | null
  pauseEndAt: number | null
  waypointProgress: { current: number; next: number; total: number } | null
  lapProgress: { current: number; total: number | null } | null
  ddiMounting: false | 'downloading' | 'mounting'
  ddiMissing: {
    reason: string
    stage?: string
    udid?: string
    hintKey?: string
    ts: number
  } | null
  error: string | null
}

function initialGlobals(): GlobalState {
  return {
    backendPositionSynced: false,
    destination: null,
    pauseEndAt: null,
    waypointProgress: null,
    lapProgress: null,
    ddiMounting: false,
    ddiMissing: null,
    error: null,
  }
}

function resolveAction<T>(action: SetStateAction<T>, prev: T): T {
  return typeof action === 'function' ? (action as (p: T) => T)(prev) : action
}

interface Harness {
  /** Session-global state mirror (the non-runtime setters' targets). */
  globals: GlobalState
  /** Live runtimes map from the REAL useSimRuntimes hook. */
  readonly runtimes: RuntimesMap
  /** Primary runtime — what the derived single-device view projects. */
  readonly primary: DeviceRuntime | null
  setters: SimWsSetters
  send: (type: WsMessage['type'], data: unknown) => void
  seedRuntimes: (map: RuntimesMap) => void
  unmount: () => void
  subscribe: WsSubscribe
  unsubscribe: () => void
  /** Setter mocks keyed by name, for "which setters fired" assertions. */
  mocks: Record<string, { mock: { calls: unknown[][] } }>
}

function createHarness(seed?: {
  runtimes?: RuntimesMap
  globals?: Partial<GlobalState>
  /** Primary device udid the dispatcher sees (null = unknown). */
  primaryUdid?: string | null
}): Harness {
  const globals: GlobalState = { ...initialGlobals(), ...seed?.globals }

  const track = <T,>(key: { [K in keyof GlobalState]: GlobalState[K] extends T ? K : never }[keyof GlobalState]) =>
    vi.fn((action: SetStateAction<T>) => {
      Object.assign(globals, { [key]: resolveAction(action, globals[key] as T) })
    })

  // Spies delegate to the real useSimRuntimes functions (stable
  // useCallback identities), captured via a ref filled on first render.
  const rtRef: { current: UseSimRuntimesValue | null } = { current: null }
  const setRuntimes = vi.fn((action: SetStateAction<RuntimesMap>) => rtRef.current!.setRuntimes(action))
  const updateRuntime = vi.fn((udid: string, patch: Partial<DeviceRuntime>) => rtRef.current!.updateRuntime(udid, patch))
  const patchPrimaryRuntime = vi.fn((patch: Partial<DeviceRuntime>) => rtRef.current!.patchPrimaryRuntime(patch))

  const setters: SimWsSetters = {
    setRuntimes,
    updateRuntime,
    patchPrimaryRuntime,
    setBackendPositionSynced: track<boolean>('backendPositionSynced'),
    setDestination: track<LatLng | null>('destination'),
    setPauseEndAt: track<number | null>('pauseEndAt'),
    setWaypointProgress: track<GlobalState['waypointProgress']>('waypointProgress'),
    setLapProgress: track<GlobalState['lapProgress']>('lapProgress'),
    setDdiMounting: track<GlobalState['ddiMounting']>('ddiMounting'),
    setDdiMissing: track<GlobalState['ddiMissing']>('ddiMissing'),
    setError: track<string | null>('error'),
    localizeError: vi.fn((code) => `localized:${code}`),
    // Plain function (not a spy) so the "which setters fired" table
    // doesn't count reads.
    getPrimaryUdid: () => seed?.primaryUdid ?? null,
  }

  let handler: ((m: WsMessage) => void) | undefined
  const unsubscribe = vi.fn()
  const subscribe: WsSubscribe = vi.fn((fn) => {
    handler = fn
    return unsubscribe
  })

  const { result, unmount } = renderHook(() => {
    const rt = useSimRuntimes()
    rtRef.current = rt
    // Stable setters bag (the dispatcher refs it anyway).
    const bag = useMemo(() => setters, [])
    useSimWsDispatcher(subscribe, bag)
    return rt
  })

  const send = (type: WsMessage['type'], data: unknown) => {
    act(() => { handler?.({ type, data }) })
  }

  const seedRuntimes = (map: RuntimesMap) => {
    // Seed through the hook's own setter, bypassing the spy so the
    // "which setters fired" assertions only count dispatcher writes.
    act(() => { rtRef.current!.setRuntimes(map) })
  }

  if (seed?.runtimes) seedRuntimes(seed.runtimes)

  return {
    globals,
    get runtimes() { return result.current.runtimes },
    get primary() {
      const keys = Object.keys(result.current.runtimes)
      return keys.length ? result.current.runtimes[keys[0]] : null
    },
    setters,
    send,
    seedRuntimes,
    unmount,
    subscribe,
    unsubscribe,
    mocks: setters as unknown as Harness['mocks'],
  }
}

function calledSetterNames(h: Harness): string[] {
  return Object.keys(h.mocks)
    .filter((k) => typeof (h.mocks[k] as { mock?: unknown }).mock === 'object')
    .filter((k) => h.mocks[k].mock.calls.length > 0)
    .sort()
}

// ── (1) position_update: partial-payload merge ─────────────────────────

describe('position_update', () => {
  it('full payload writes the runtime patch and flips the sync flag', () => {
    const h = createHarness()
    h.send('position_update', {
      udid: UDID_A,
      lat: 25.04,
      lng: 121.56,
      progress: 0.5,
      eta_seconds: 120,
      distance_remaining: 800,
      distance_traveled: 200,
      speed_mps: 10,
    })

    expect(h.runtimes[UDID_A]).toEqual({
      ...emptyRuntime(UDID_A),
      currentPos: { lat: 25.04, lng: 121.56 },
      progress: 0.5,
      eta: 120,
      distanceRemaining: 800,
      distanceTraveled: 200,
      currentSpeedKmh: 36, // speed_mps * 3.6
    })
    // The single-device view derives from this same entry.
    expect(h.primary).toBe(h.runtimes[UDID_A])
    // Session-global: a real device coordinate marks the engine synced.
    expect(h.globals.backendPositionSynced).toBe(true)
  })

  it('partial tick (lat/lng only) does NOT wipe cached eta/progress/distances', () => {
    const h = createHarness()
    h.send('position_update', {
      udid: UDID_A,
      lat: 1, lng: 2, progress: 0.4, eta_seconds: 99,
      distance_remaining: 500, distance_traveled: 100, speed_mps: 5,
    })
    h.send('position_update', { udid: UDID_A, lat: 3, lng: 4 })

    expect(h.runtimes[UDID_A].currentPos).toEqual({ lat: 3, lng: 4 })
    expect(h.runtimes[UDID_A].progress).toBe(0.4)
    expect(h.runtimes[UDID_A].eta).toBe(99)
    expect(h.runtimes[UDID_A].distanceRemaining).toBe(500)
    expect(h.runtimes[UDID_A].currentSpeedKmh).toBe(18)
    // One runtime write per frame — the second frame patches position only.
    expect(h.setters.updateRuntime).toHaveBeenCalledTimes(2)
    expect(h.setters.updateRuntime).toHaveBeenLastCalledWith(UDID_A, { currentPos: { lat: 3, lng: 4 } })
  })

  it('eta comes from eta_seconds (udid-less → local slot)', () => {
    const h = createHarness()
    h.send('position_update', { eta_seconds: 77 })
    expect(h.runtimes[LOCAL_RUNTIME_KEY].eta).toBe(77)
    expect(h.primary?.eta).toBe(77)
  })

  it('ignores a non-contract `eta` field', () => {
    const h = createHarness()
    h.send('position_update', { udid: UDID_A, eta: 100 })
    expect(h.setters.updateRuntime).not.toHaveBeenCalled()
  })

  it('WsMessage.type only accepts contract event names', () => {
    // Type-level guard (checked by tsconfig.test.json): a renamed or
    // misspelled event name must fail tsc instead of silently never matching.
    // @ts-expect-error 'lap_completed' is not a backend WS event
    const bogus: WsMessage['type'] = 'lap_completed'
    expect(bogus).toBe('lap_completed')
  })

  it('lat without lng is dropped — position only applies as a pair', () => {
    const h = createHarness()
    h.send('position_update', { udid: UDID_A, lat: 25.04, progress: 0.1 })
    expect(h.runtimes[UDID_A].currentPos).toBeNull()
    expect(h.setters.setBackendPositionSynced).not.toHaveBeenCalled()
    expect(h.runtimes[UDID_A].progress).toBe(0.1)
  })

  it('payload with udid but no recognized fields skips the runtime write entirely (empty patch)', () => {
    const h = createHarness()
    h.send('position_update', { udid: UDID_A })
    expect(h.setters.updateRuntime).not.toHaveBeenCalled()
    expect(h.setters.patchPrimaryRuntime).not.toHaveBeenCalled()
    expect(h.runtimes).toEqual({})
  })

  it('payload without udid is routed to the local slot (translated from the legacy-only path)', () => {
    // TRANSLATED: pre-refactor, udid-less frames updated only the legacy
    // single-device surface. That surface is now the derived primary
    // view, so the frame lands in the reserved local slot — which IS the
    // primary while no device has been seen.
    const h = createHarness()
    h.send('position_update', { lat: 1, lng: 2, progress: 0.3 })
    expect(h.setters.updateRuntime).not.toHaveBeenCalled()
    expect(h.setters.patchPrimaryRuntime).toHaveBeenCalledTimes(1)
    expect(h.primary?.currentPos).toEqual({ lat: 1, lng: 2 })
    expect(h.primary?.progress).toBe(0.3)
    expect(h.globals.backendPositionSynced).toBe(true)
  })

  it('udid-less frames target the first REAL udid entry once one exists', () => {
    const h = createHarness({ runtimes: { [UDID_A]: emptyRuntime(UDID_A) } })
    h.send('position_update', { lat: 9, lng: 8 })
    expect(h.runtimes[UDID_A].currentPos).toEqual({ lat: 9, lng: 8 })
    expect(h.runtimes[LOCAL_RUNTIME_KEY]).toBeUndefined()
  })

  it('non-object payload fires nothing', () => {
    const h = createHarness()
    h.send('position_update', null)
    h.send('position_update', 'garbage')
    expect(calledSetterNames(h)).toEqual([])
  })
})

// ── (1b) local-slot promotion ──────────────────────────────────────────

describe('local slot promotion', () => {
  it('first udid-tagged write promotes the accumulated local slot into the udid entry', () => {
    const h = createHarness()
    h.send('position_update', { lat: 1, lng: 2, progress: 0.3 }) // → local slot
    h.send('position_update', { udid: UDID_A, progress: 0.4 })   // → promotes
    expect(h.runtimes[LOCAL_RUNTIME_KEY]).toBeUndefined()
    expect(h.runtimes[UDID_A]).toEqual({
      ...emptyRuntime(UDID_A),
      currentPos: { lat: 1, lng: 2 }, // carried over from the local slot
      progress: 0.4,
    })
    expect(h.primary).toBe(h.runtimes[UDID_A])
  })

  it('device_connected promotes the local slot too (rehydrated pin survives connect)', () => {
    const h = createHarness()
    h.send('position_update', { lat: 5, lng: 6 })
    h.send('device_connected', { udid: UDID_A })
    expect(h.runtimes[LOCAL_RUNTIME_KEY]).toBeUndefined()
    expect(h.runtimes[UDID_A].currentPos).toEqual({ lat: 5, lng: 6 })
    expect(h.runtimes[UDID_A].tunnelDegraded).toBe(false)
  })
})

// ── (2) state_change: idle vs paused vs running ────────────────────────

describe('state_change', () => {
  const seedRunning = (): Harness => {
    const h = createHarness({
      globals: { destination: { lat: 9, lng: 9 } },
      runtimes: {
        [UDID_A]: {
          ...emptyRuntime(UDID_A),
          state: 'navigating',
          routePath: [{ lat: 1, lng: 2 }],
          destination: { lat: 9, lng: 9 },
          eta: 60,
        },
      },
    })
    return h
  }

  it.each(['idle', 'disconnected'])(
    '%s clears routePath/destination/eta in the runtime and the user destination marker',
    (st) => {
      const h = seedRunning()
      h.send('state_change', { udid: UDID_A, state: st })

      // TRANSLATED ASYMMETRY: the legacy single-device surface cleared
      // routePath + destination + eta on idle, while the runtime used to
      // clear routePath only. The runtime now feeds the UI directly, so
      // it adopts the legacy clearing in full.
      expect(h.runtimes[UDID_A].state).toBe(st)
      expect(h.runtimes[UDID_A].routePath).toEqual([])
      expect(h.runtimes[UDID_A].destination).toBeNull()
      expect(h.runtimes[UDID_A].eta).toBeNull()
      // User-input destination marker follows the same clear.
      expect(h.globals.destination).toBeNull()
    },
  )

  it('paused stores the raw state and keeps the routePath', () => {
    const h = seedRunning()
    h.send('state_change', { udid: UDID_A, state: 'paused' })
    expect(h.runtimes[UDID_A].state).toBe('paused')
    expect(h.runtimes[UDID_A].routePath).toEqual([{ lat: 1, lng: 2 }])
    // eta/destination retained on pause.
    expect(h.runtimes[UDID_A].eta).toBe(60)
    expect(h.runtimes[UDID_A].destination).toEqual({ lat: 9, lng: 9 })
  })

  it('any other state is stored raw without clearing anything', () => {
    const h = createHarness()
    h.send('state_change', { udid: UDID_A, state: 'navigating' })
    expect(h.runtimes[UDID_A].state).toBe('navigating')
    expect(h.runtimes[UDID_A].routePath).toEqual([])
    expect(h.setters.setDestination).not.toHaveBeenCalled()
  })

  it('udid-less state_change targets the primary slot (translated from the legacy path)', () => {
    const h = createHarness({ runtimes: { [UDID_A]: { ...emptyRuntime(UDID_A), state: 'navigating' } } })
    h.send('state_change', { state: 'idle' })
    expect(h.runtimes[UDID_A].state).toBe('idle')
  })

  it('missing state field fires nothing', () => {
    const h = createHarness()
    h.send('state_change', { udid: UDID_A })
    expect(calledSetterNames(h)).toEqual([])
  })
})

// ── (3) tunnel_degraded fan-out + device_connected clearing ────────────

describe('tunnel_degraded / tunnel_recovered / device_connected', () => {
  it('tunnel_degraded WITH udid flags only that runtime; other entries keep identity', () => {
    const h = createHarness({
      runtimes: { [UDID_A]: emptyRuntime(UDID_A), [UDID_B]: emptyRuntime(UDID_B) },
    })
    const untouchedB = h.runtimes[UDID_B]
    h.send('tunnel_degraded', { udid: UDID_A })
    expect(h.runtimes[UDID_A].tunnelDegraded).toBe(true)
    expect(h.runtimes[UDID_B].tunnelDegraded).toBe(false)
    expect(h.runtimes[UDID_B]).toBe(untouchedB)
    expect(h.setters.updateRuntime).toHaveBeenCalledWith(UDID_A, { tunnelDegraded: true })
    expect(h.setters.setRuntimes).not.toHaveBeenCalled()
  })

  it('tunnel_degraded WITHOUT udid fans out to ALL runtimes via setRuntimes', () => {
    const h = createHarness({
      runtimes: { [UDID_A]: emptyRuntime(UDID_A), [UDID_B]: emptyRuntime(UDID_B) },
    })
    h.send('tunnel_degraded', {})
    expect(h.runtimes[UDID_A].tunnelDegraded).toBe(true)
    expect(h.runtimes[UDID_B].tunnelDegraded).toBe(true)
    expect(h.setters.updateRuntime).not.toHaveBeenCalled()
    expect(h.setters.setRuntimes).toHaveBeenCalledTimes(1)
  })

  it('tunnel_recovered without udid clears all; a no-op pass returns the SAME map reference', () => {
    const h = createHarness({
      runtimes: {
        [UDID_A]: { ...emptyRuntime(UDID_A), tunnelDegraded: true },
        [UDID_B]: { ...emptyRuntime(UDID_B), tunnelDegraded: true },
      },
    })
    h.send('tunnel_recovered', {})
    expect(h.runtimes[UDID_A].tunnelDegraded).toBe(false)
    expect(h.runtimes[UDID_B].tunnelDegraded).toBe(false)

    // Second recovered with nothing degraded: functional updater returns prev.
    const before = h.runtimes
    h.send('tunnel_recovered', {})
    expect(h.runtimes).toBe(before)
  })

  it('device_connected clears stale tunnelDegraded for that udid and nulls the global error', () => {
    const h = createHarness({
      runtimes: { [UDID_A]: { ...emptyRuntime(UDID_A), state: 'navigating', tunnelDegraded: true } },
      globals: { error: 'localized:tunnel_lost' },
    })
    h.send('device_connected', { udid: UDID_A })
    expect(h.runtimes[UDID_A].tunnelDegraded).toBe(false)
    // Other runtime fields survive the patch.
    expect(h.runtimes[UDID_A].state).toBe('navigating')
    expect(h.globals.error).toBeNull()
  })

  it('device_connected for an unseen udid auto-seeds an empty runtime', () => {
    const h = createHarness()
    h.send('device_connected', { udid: UDID_B })
    expect(h.runtimes[UDID_B]).toEqual({ ...emptyRuntime(UDID_B), tunnelDegraded: false })
  })
})

// ── (4) *_complete: run-end clearing ───────────────────────────────────

describe('*_complete events', () => {
  it.each(['multi_stop_complete', 'navigation_complete', 'random_walk_complete'] as const)(
    '%s collapses the runtime to idle and clears destination/eta + global overlays',
    (type) => {
      const h = createHarness({
        globals: {
          pauseEndAt: 12345,
          waypointProgress: { current: 1, next: 2, total: 3 },
          lapProgress: { current: 1, total: 5 },
          destination: { lat: 9, lng: 9 },
        },
        runtimes: {
          [UDID_A]: {
            ...emptyRuntime(UDID_A),
            state: 'navigating',
            progress: 0.8,
            eta: 30,
            destination: { lat: 9, lng: 9 },
          },
        },
      })
      h.send(type, { udid: UDID_A })

      // TRANSLATED ASYMMETRY: pre-refactor, *_complete cleared
      // destination/eta only on the legacy single-device surface; the
      // runtime kept them. The runtime is now the single source feeding
      // the UI, so it adopts the legacy clearing.
      expect(h.runtimes[UDID_A].progress).toBe(1)
      expect(h.runtimes[UDID_A].state).toBe('idle')
      expect(h.runtimes[UDID_A].destination).toBeNull()
      expect(h.runtimes[UDID_A].eta).toBeNull()

      // Session-global run overlays collapse.
      expect(h.globals.pauseEndAt).toBeNull()
      expect(h.globals.waypointProgress).toBeNull()
      expect(h.globals.lapProgress).toBeNull()
      expect(h.globals.destination).toBeNull()
    },
  )

  it('clearing fires even WITHOUT a udid — routed to the primary slot', () => {
    // TRANSLATED: the legacy surface used to clear on udid-less frames
    // while runtimes stayed untouched; the primary slot now takes both.
    const h = createHarness({
      globals: { destination: { lat: 1, lng: 1 } },
      runtimes: { [UDID_A]: { ...emptyRuntime(UDID_A), progress: 0.5, destination: { lat: 1, lng: 1 } } },
    })
    h.send('navigation_complete', {})
    expect(h.globals.destination).toBeNull()
    expect(h.runtimes[UDID_A].progress).toBe(1)
    expect(h.runtimes[UDID_A].destination).toBeNull()
    expect(h.setters.updateRuntime).not.toHaveBeenCalled()
    expect(h.setters.patchPrimaryRuntime).toHaveBeenCalledTimes(1)
  })
})

// ── Remaining event details ────────────────────────────────────────────

describe('route_path coercion', () => {
  it('coerces tuple and object points; missing fields default to 0', () => {
    const h = createHarness()
    h.send('route_path', {
      udid: UDID_A,
      coords: [[1, 2], { lat: 3, lng: 4 }, { lat: 5 }, {}],
    })
    expect(h.runtimes[UDID_A].routePath).toEqual([
      { lat: 1, lng: 2 },
      { lat: 3, lng: 4 },
      { lat: 5, lng: 0 },
      { lat: 0, lng: 0 },
    ])
  })

  it('route_path without udid lands in the primary/local slot', () => {
    const h = createHarness()
    h.send('route_path', { coords: [[1, 2]] })
    expect(h.primary?.routePath).toEqual([{ lat: 1, lng: 2 }])
    expect(h.runtimes[LOCAL_RUNTIME_KEY]).toBeDefined()
  })

  it('route_path without coords fires nothing', () => {
    const h = createHarness()
    h.send('route_path', { udid: UDID_A })
    expect(calledSetterNames(h)).toEqual([])
  })
})

describe('waypoint_progress / lap_complete defaults', () => {
  it('waypoint_progress: next defaults to current+1, total to 0; runtime stores waypointIndex', () => {
    const h = createHarness()
    h.send('waypoint_progress', { udid: UDID_A, current_index: 2 })
    expect(h.globals.waypointProgress).toEqual({ current: 2, next: 3, total: 0 })
    expect(h.runtimes[UDID_A].waypointIndex).toBe(2)
  })

  it('waypoint_progress with explicit next/total uses them verbatim', () => {
    const h = createHarness()
    h.send('waypoint_progress', { udid: UDID_A, current_index: 1, next_index: 5, total: 7 })
    expect(h.globals.waypointProgress).toEqual({ current: 1, next: 5, total: 7 })
  })

  it('waypoint_progress without udid patches the primary slot waypointIndex', () => {
    const h = createHarness({ runtimes: { [UDID_A]: emptyRuntime(UDID_A) } })
    h.send('waypoint_progress', { current_index: 4 })
    expect(h.runtimes[UDID_A].waypointIndex).toBe(4)
    expect(h.globals.waypointProgress).toEqual({ current: 4, next: 5, total: 0 })
  })

  it('lap_complete: total defaults to null; no runtime write (session-global event)', () => {
    const h = createHarness()
    h.send('lap_complete', { lap: 3 })
    expect(h.globals.lapProgress).toEqual({ current: 3, total: null })
    h.send('lap_complete', { lap: 4, total: 10 })
    expect(h.globals.lapProgress).toEqual({ current: 4, total: 10 })
    expect(h.setters.updateRuntime).not.toHaveBeenCalled()
    expect(h.setters.patchPrimaryRuntime).not.toHaveBeenCalled()
  })
})

describe('device_snapshot', () => {
  it('resets an active runtime whose device is missing from the snapshot', () => {
    // Backend restarted mid-run: the new process knows no devices, so the
    // snapshot is the only signal that the old run is gone.
    const h = createHarness({
      runtimes: {
        [UDID_A]: {
          ...emptyRuntime(UDID_A),
          state: 'navigating',
          routePath: [{ lat: 1, lng: 2 }],
          destination: { lat: 9, lng: 9 },
          eta: 60,
        },
        [UDID_B]: { ...emptyRuntime(UDID_B), state: 'looping', routePath: [{ lat: 3, lng: 4 }] },
      },
    })
    h.send('device_snapshot', { devices: [{ udid: UDID_B }] })

    expect(h.runtimes[UDID_A].state).toBe('idle')
    expect(h.runtimes[UDID_A].routePath).toEqual([])
    expect(h.runtimes[UDID_A].destination).toBeNull()
    expect(h.runtimes[UDID_A].eta).toBeNull()
    // Devices still connected keep their state; the backend follows the
    // snapshot with an authoritative state_change for each engine.
    expect(h.runtimes[UDID_B].state).toBe('looping')
    expect(h.runtimes[UDID_B].routePath).toEqual([{ lat: 3, lng: 4 }])
  })

  it('resets an active local slot when the snapshot is empty', () => {
    const h = createHarness({
      runtimes: { [LOCAL_RUNTIME_KEY]: { ...emptyRuntime(LOCAL_RUNTIME_KEY), state: 'paused' } },
    })
    h.send('device_snapshot', { devices: [] })
    expect(h.runtimes[LOCAL_RUNTIME_KEY].state).toBe('idle')
  })

  it('leaves the map untouched when nothing is stale', () => {
    const seeded: RuntimesMap = { [UDID_A]: { ...emptyRuntime(UDID_A), state: 'navigating' } }
    const h = createHarness({ runtimes: seeded })
    const before = h.runtimes
    h.send('device_snapshot', { devices: [{ udid: UDID_A }] })
    expect(h.runtimes).toBe(before)
  })
})

describe('pause_countdown / ddi / tunnel_lost / device_disconnected', () => {
  it('pause_countdown sets pauseEndAt = now + duration_seconds*1000; non-positive is ignored', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const h = createHarness()
    h.send('pause_countdown', { duration_seconds: 5 })
    expect(h.globals.pauseEndAt).toBe(1_000_000 + 5000)
    h.send('pause_countdown', { duration_seconds: 0 })
    h.send('pause_countdown', {})
    expect(h.setters.setPauseEndAt).toHaveBeenCalledTimes(1)
  })

  it('ddi_mount_missing defaults reason to "unknown" and stamps ts with Date.now', () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000)
    const h = createHarness({ globals: { ddiMounting: 'mounting' } })
    h.send('ddi_mount_missing', {})
    expect(h.globals.ddiMounting).toBe(false)
    expect(h.globals.ddiMissing).toEqual({ reason: 'unknown', stage: undefined, ts: 2_000_000 })

    h.send('ddi_mount_missing', { reason: 'no_image', stage: 'download' })
    expect(h.globals.ddiMissing).toEqual({ reason: 'no_image', stage: 'download', ts: 2_000_000 })
  })

  it('ddi_mounting tracks the download → mount stages; a missing stage means mounting', () => {
    const h = createHarness()
    h.send('ddi_mounting', { udid: UDID_A, stage: 'downloading' })
    expect(h.globals.ddiMounting).toBe('downloading')
    h.send('ddi_mounting', { udid: UDID_A, stage: 'mounting' })
    expect(h.globals.ddiMounting).toBe('mounting')
    h.send('ddi_mounted', { udid: UDID_A })
    expect(h.globals.ddiMounting).toBe(false)
    h.send('ddi_mounting', { udid: UDID_A })
    expect(h.globals.ddiMounting).toBe('mounting')
  })

  it('ddi_mount_missing carries udid and hint_key so the banner can pick a specific message', () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000)
    const h = createHarness()
    h.send('ddi_mount_missing', {
      udid: UDID_A,
      reason: 'developer_mode_disabled',
      stage: 'personalized',
      hint_key: 'ddi.developer_mode_disabled',
    })
    expect(h.globals.ddiMissing).toEqual({
      reason: 'developer_mode_disabled',
      stage: 'personalized',
      udid: UDID_A,
      hintKey: 'ddi.developer_mode_disabled',
      ts: 2_000_000,
    })
  })

  it('ddi_mount_failed keeps the structured reason from its payload instead of overwriting it', () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000)
    const h = createHarness()
    // Backend sends ddi_mount_missing then ddi_mount_failed with the same
    // payload; the second must not downgrade a specific reason to the
    // generic 'mount_failed'.
    h.send('ddi_mount_failed', {
      udid: UDID_A,
      reason: 'developer_mode_disabled',
      hint_key: 'ddi.developer_mode_disabled',
      error: 'developer_mode_disabled',
    })
    expect(h.globals.ddiMissing?.reason).toBe('developer_mode_disabled')
    expect(h.globals.ddiMissing?.hintKey).toBe('ddi.developer_mode_disabled')

    h.send('ddi_mount_failed', {})
    expect(h.globals.ddiMissing?.reason).toBe('mount_failed')
  })

  it('tunnel_lost routes through localizeError into setError', () => {
    const h = createHarness()
    h.send('tunnel_lost', {})
    expect(h.setters.localizeError).toHaveBeenCalledWith('tunnel_lost')
    expect(h.globals.error).toBe('localized:tunnel_lost')
  })

  it('device_disconnected: runtime → disconnected + tunnelDegraded reset', () => {
    // TRANSLATED ASYMMETRY: the legacy surface flipped running/paused to
    // false while keeping its stale `state` string. The derived status
    // now reads running/paused=false from the 'disconnected' state — the
    // stale-string quirk is intentionally not reproduced (no consumer
    // read it, and DeviceChip needs the real 'disconnected').
    const h = createHarness({
      runtimes: { [UDID_A]: { ...emptyRuntime(UDID_A), state: 'navigating', tunnelDegraded: true } },
    })
    h.send('device_disconnected', { udid: UDID_A })
    expect(h.runtimes[UDID_A]).toEqual({
      ...emptyRuntime(UDID_A),
      state: 'disconnected',
      tunnelDegraded: false,
    })
  })

  it('device_disconnected without udid targets the primary slot (translated from the legacy status flip)', () => {
    const h = createHarness({
      runtimes: { [UDID_A]: { ...emptyRuntime(UDID_A), state: 'paused' } },
    })
    h.send('device_disconnected', {})
    expect(h.runtimes[UDID_A].state).toBe('disconnected')
  })
})

// ── Multi-device overlays follow the primary device only ──────────────

describe('session overlays with two devices', () => {
  it('pause countdown follows the primary device; the other device cannot clear it', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const h = createHarness({ primaryUdid: UDID_A })
    h.send('pause_countdown', { udid: UDID_A, duration_seconds: 10 })
    h.send('pause_countdown', { udid: UDID_B, duration_seconds: 3 })
    expect(h.globals.pauseEndAt).toBe(1_000_000 + 10_000)
    h.send('pause_countdown_end', { udid: UDID_B })
    expect(h.globals.pauseEndAt).toBe(1_000_000 + 10_000)
    h.send('pause_countdown_end', { udid: UDID_A })
    expect(h.globals.pauseEndAt).toBeNull()
  })

  it('lap and waypoint progress ignore the non-primary device (its runtime still updates)', () => {
    const h = createHarness({ primaryUdid: UDID_A })
    h.send('lap_complete', { udid: UDID_A, lap: 2, total: 5 })
    h.send('lap_complete', { udid: UDID_B, lap: 4, total: 5 })
    expect(h.globals.lapProgress).toEqual({ current: 2, total: 5 })

    h.send('waypoint_progress', { udid: UDID_A, current_index: 1, next_index: 2, total: 4 })
    h.send('waypoint_progress', { udid: UDID_B, current_index: 3, next_index: 0, total: 4 })
    expect(h.globals.waypointProgress).toEqual({ current: 1, next: 2, total: 4 })
    expect(h.runtimes[UDID_B].waypointIndex).toBe(3)
  })

  it('a non-primary run completing leaves the primary overlays alone', () => {
    const h = createHarness({
      primaryUdid: UDID_A,
      globals: { pauseEndAt: 123, lapProgress: { current: 1, total: 3 } },
    })
    h.send('navigation_complete', { udid: UDID_B })
    expect(h.globals.pauseEndAt).toBe(123)
    expect(h.globals.lapProgress).toEqual({ current: 1, total: 3 })
    expect(h.runtimes[UDID_B].state).toBe('idle')
  })

  it('single device with no known primary behaves as before', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const h = createHarness()
    h.send('pause_countdown', { udid: UDID_A, duration_seconds: 5 })
    expect(h.globals.pauseEndAt).toBe(1_000_000 + 5000)
    h.send('pause_countdown_end', { udid: UDID_A })
    expect(h.globals.pauseEndAt).toBeNull()
  })
})

// ── (5) Table: which setters fire per event ────────────────────────────

interface TableRow {
  name: string
  type: WsMessage['type']
  data: unknown
  seed?: RuntimesMap
  fires: string[]
}

const seededRuntimes = (): RuntimesMap => ({ [UDID_A]: emptyRuntime(UDID_A) })

const TABLE: TableRow[] = [
  {
    name: 'position_update with udid + full payload',
    type: 'position_update',
    data: { udid: UDID_A, lat: 1, lng: 2, progress: 0.1, eta_seconds: 9, distance_remaining: 5 },
    fires: ['setBackendPositionSynced', 'updateRuntime'],
  },
  {
    name: 'position_update without udid (primary/local slot)',
    type: 'position_update',
    data: { lat: 1, lng: 2 },
    fires: ['patchPrimaryRuntime', 'setBackendPositionSynced'],
  },
  {
    name: 'route_path with udid',
    type: 'route_path',
    data: { udid: UDID_A, coords: [[1, 2]] },
    fires: ['updateRuntime'],
  },
  {
    name: 'route_path without udid',
    type: 'route_path',
    data: { coords: [[1, 2]] },
    fires: ['patchPrimaryRuntime'],
  },
  {
    name: 'state_change running with udid',
    type: 'state_change',
    data: { udid: UDID_A, state: 'navigating' },
    fires: ['updateRuntime'],
  },
  {
    name: 'state_change idle with udid',
    type: 'state_change',
    data: { udid: UDID_A, state: 'idle' },
    fires: ['setDestination', 'updateRuntime'],
  },
  {
    name: 'state_change idle without udid',
    type: 'state_change',
    data: { state: 'idle' },
    fires: ['patchPrimaryRuntime', 'setDestination'],
  },
  {
    name: 'device_connected with udid',
    type: 'device_connected',
    data: { udid: UDID_A },
    fires: ['setError', 'updateRuntime'],
  },
  {
    name: 'device_connected WITHOUT udid is a no-op (udid-gated branch only)',
    type: 'device_connected',
    data: {},
    fires: [],
  },
  {
    name: 'device_disconnected with udid',
    type: 'device_disconnected',
    data: { udid: UDID_A },
    fires: ['updateRuntime'],
  },
  {
    name: 'device_disconnected without udid (primary slot)',
    type: 'device_disconnected',
    data: {},
    fires: ['patchPrimaryRuntime'],
  },
  {
    name: 'navigation_complete with udid',
    type: 'navigation_complete',
    data: { udid: UDID_A },
    fires: ['setDestination', 'setLapProgress', 'setPauseEndAt', 'setWaypointProgress', 'updateRuntime'],
  },
  {
    name: 'navigation_complete without udid',
    type: 'navigation_complete',
    data: {},
    fires: ['patchPrimaryRuntime', 'setDestination', 'setLapProgress', 'setPauseEndAt', 'setWaypointProgress'],
  },
  {
    name: 'waypoint_progress with udid',
    type: 'waypoint_progress',
    data: { udid: UDID_A, current_index: 1 },
    fires: ['setWaypointProgress', 'updateRuntime'],
  },
  {
    name: 'waypoint_progress without current_index is a no-op',
    type: 'waypoint_progress',
    data: { udid: UDID_A },
    fires: [],
  },
  { name: 'lap_complete', type: 'lap_complete', data: { lap: 1 }, fires: ['setLapProgress'] },
  { name: 'ddi_mounting', type: 'ddi_mounting', data: {}, fires: ['setDdiMounting'] },
  { name: 'ddi_mounted', type: 'ddi_mounted', data: {}, fires: ['setDdiMounting'] },
  // ddi_mount_failed now also emits the missing signal so the persistent
  // DDI-failed banner surfaces a manual-mount hint (was previously silent).
  { name: 'ddi_mount_failed', type: 'ddi_mount_failed', data: {}, fires: ['setDdiMissing', 'setDdiMounting'] },
  {
    name: 'ddi_mount_missing',
    type: 'ddi_mount_missing',
    data: { reason: 'x' },
    fires: ['setDdiMissing', 'setDdiMounting'],
  },
  { name: 'tunnel_lost', type: 'tunnel_lost', data: {}, fires: ['localizeError', 'setError'] },
  {
    name: 'tunnel_degraded with udid',
    type: 'tunnel_degraded',
    data: { udid: UDID_A },
    seed: seededRuntimes(),
    fires: ['updateRuntime'],
  },
  {
    name: 'tunnel_degraded without udid',
    type: 'tunnel_degraded',
    data: {},
    seed: seededRuntimes(),
    fires: ['setRuntimes'],
  },
  {
    name: 'tunnel_recovered without udid',
    type: 'tunnel_recovered',
    data: {},
    seed: seededRuntimes(),
    fires: ['setRuntimes'],
  },
  {
    name: 'pause_countdown with positive duration',
    type: 'pause_countdown',
    data: { duration_seconds: 3 },
    fires: ['setPauseEndAt'],
  },
  { name: 'pause_countdown_end', type: 'pause_countdown_end', data: {}, fires: ['setPauseEndAt'] },
  // Contract event types the dispatcher deliberately does NOT handle today.
  { name: 'cooldown_update (unhandled)', type: 'cooldown_update', data: { udid: UDID_A }, fires: [] },
  { name: 'teleport (unhandled)', type: 'teleport', data: { udid: UDID_A, lat: 1, lng: 2 }, fires: [] },
  { name: 'stop_reached (unhandled)', type: 'stop_reached', data: { udid: UDID_A }, fires: [] },
  { name: 'restored (unhandled)', type: 'restored', data: {}, fires: [] },
  { name: 'totally unknown event type', type: 'not_a_real_event' as WsMessage['type'], data: {}, fires: [] },
]

describe('event → setters table', () => {
  it.each(TABLE)('$name fires exactly: $fires', (row) => {
    const h = createHarness(row.seed ? { runtimes: row.seed } : undefined)
    h.send(row.type, row.data)
    expect(calledSetterNames(h)).toEqual([...row.fires].sort())
  })
})

// ── Subscription lifecycle ─────────────────────────────────────────────

describe('subscription lifecycle', () => {
  it('subscribes once and unsubscribes on unmount', () => {
    const h = createHarness()
    expect(h.subscribe).toHaveBeenCalledTimes(1)
    expect(h.unsubscribe).not.toHaveBeenCalled()
    h.unmount()
    expect(h.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('renders without crashing when subscribe is undefined', () => {
    const setters = createHarness().setters
    expect(() => {
      const { unmount } = renderHook(() => useSimWsDispatcher(undefined, setters))
      unmount()
    }).not.toThrow()
  })
})
