// @vitest-environment jsdom
/**
 * Regression tests for `useSimulation`'s stop / restore clears.
 *
 * Both actions wipe per-run overlays so nothing from the old run lingers
 * on the map or in the panels (a destination pin and a "3 / 5" lap count
 * surviving Stop were both reported UX bugs). Restore additionally drops
 * the staged waypoints and the device position.
 */
import { renderHook, act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WsMessage } from './useWebSocket'

const api = vi.hoisted(() => ({
  stopSim: vi.fn(),
  restoreSim: vi.fn(),
  startLoop: vi.fn(),
  getStatus: vi.fn(),
  getLastDevicePosition: vi.fn(),
}))
vi.mock('../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/api')>()),
  ...api,
}))

import { useSimulation, type WsSubscribe } from './useSimulation'

const UDID = 'udid-A'
const WPS = [
  { lat: 25.0, lng: 121.5 },
  { lat: 25.01, lng: 121.51 },
]

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

beforeEach(() => {
  api.stopSim.mockResolvedValue({})
  api.restoreSim.mockResolvedValue({})
  api.startLoop.mockResolvedValue({})
  api.getStatus.mockResolvedValue({})
  api.getLastDevicePosition.mockResolvedValue({ position: null })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

/** Mount the hook with a loop run in flight: staged route, destination,
 *  effective speed, route polyline, ETA, waypoint + lap progress. */
async function mountMidRun() {
  const ws = fakeWs()
  const hook = renderHook(() => useSimulation(ws.subscribe, { primaryUdid: UDID }))
  // Let the mount-time status fetch settle before seeding.
  await act(async () => {})
  act(() => {
    hook.result.current.loadRouteWaypoints(WPS)
    hook.result.current.setDestination({ lat: 25.02, lng: 121.52 })
  })
  await act(async () => { await hook.result.current.startLoop(WPS) })
  ws.send('state_change', { udid: UDID, state: 'looping' })
  ws.send('position_update', { udid: UDID, lat: 25.0, lng: 121.5, eta_seconds: 90 })
  ws.send('route_path', { udid: UDID, coords: WPS })
  ws.send('waypoint_progress', { udid: UDID, current_index: 1, next_index: 2, total: 3 })
  ws.send('lap_complete', { udid: UDID, lap: 3, total: 5 })

  const r = hook.result.current
  expect(r.status.running).toBe(true)
  expect(r.destination).not.toBeNull()
  expect(r.waypoints).toEqual(WPS)
  expect(r.routePath.length).toBeGreaterThan(0)
  expect(r.eta).toBe(90)
  expect(r.waypointProgress).not.toBeNull()
  expect(r.lapProgress).toEqual({ current: 3, total: 5 })
  expect(r.effectiveSpeed).not.toBeNull()
  return hook
}

describe('useSimulation stop', () => {
  it('clears destination, route, ETA, waypoint and lap progress', async () => {
    const { result } = await mountMidRun()

    await act(async () => { await result.current.stop() })

    expect(api.stopSim).toHaveBeenCalledTimes(1)
    const r = result.current
    expect(r.status.running).toBe(false)
    expect(r.destination).toBeNull()
    expect(r.routePath).toEqual([])
    expect(r.eta).toBeNull()
    expect(r.waypointProgress).toBeNull()
    expect(r.lapProgress).toBeNull()
    expect(r.effectiveSpeed).toBeNull()
    // The staged route survives Stop so the user can start it again.
    expect(r.waypoints).toEqual(WPS)
  })
})

describe('useSimulation restore', () => {
  it('clears destination, staged waypoints, route, position and progress overlays', async () => {
    const { result } = await mountMidRun()

    await act(async () => { await result.current.restore() })

    expect(api.restoreSim).toHaveBeenCalledTimes(1)
    const r = result.current
    expect(r.status.running).toBe(false)
    expect(r.destination).toBeNull()
    expect(r.waypoints).toEqual([])
    expect(r.routePath).toEqual([])
    expect(r.eta).toBeNull()
    expect(r.currentPosition).toBeNull()
    expect(r.backendPositionSynced).toBe(false)
    expect(r.waypointProgress).toBeNull()
    expect(r.lapProgress).toBeNull()
    expect(r.effectiveSpeed).toBeNull()
  })
})
