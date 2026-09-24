// @vitest-environment jsdom
/**
 * SimProvider start / stop wiring: each mode's `handleStart` branch, with
 * one and two connected devices, reaches the right api call; missing
 * inputs surface the matching toast instead of calling the backend.
 *
 * `useSimulation` and the fan-out helpers run for real; only the
 * surrounding contexts and `services/api` are mocked.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, cleanup, act, screen, fireEvent } from '@testing-library/react'
import { SimProvider, SimMode, useSimActions, useSimState } from './SimContext'
import type { SimActionsValue, SimStateValue } from './SimContext'
import { DEFAULT_FLOWER_SETTINGS } from '../lib/flower'

const A = 'udid-A'
const B = 'udid-B'

const showToast = vi.fn()
const device = vi.hoisted(() => ({ connectedDevices: [] as { udid: string }[] }))

vi.mock('./DeviceContext', () => ({
  useDeviceContext: () => ({
    connectedDevices: device.connectedDevices,
    primaryDevice: device.connectedDevices[0] ?? null,
  }),
}))
vi.mock('./ToastContext', () => ({
  useToastContext: () => ({ showToast }),
}))
vi.mock('./WebSocketContext', () => ({
  useWebSocketContext: () => ({ subscribe: undefined, sendMessage: vi.fn() }),
}))
vi.mock('./SimSettingsContext', async () => {
  const { DEFAULT_FLOWER_SETTINGS } = await import('../lib/flower')
  return {
    useSimSettings: () => ({
      randomWalkRadius: 500,
      wpGenRadius: 300,
      setWpGenRadius: vi.fn(),
      wpGenCount: 5,
      setWpGenCount: vi.fn(),
      joystickSensitivity: 3,
      autoJitter: false,
      flowerSettings: DEFAULT_FLOWER_SETTINGS,
    }),
  }
})
vi.mock('../i18n', () => ({
  useT: () => (key: string) => key,
}))

const api = vi.hoisted(() => ({
  getStatus: vi.fn(),
  getLastDevicePosition: vi.fn(),
  teleport: vi.fn(),
  navigate: vi.fn(),
  startLoop: vi.fn(),
  multiStop: vi.fn(),
  randomWalk: vi.fn(),
  startFlower: vi.fn(),
  joystickStart: vi.fn(),
  joystickStop: vi.fn(),
  stopSim: vi.fn(),
  restoreSim: vi.fn(),
}))
vi.mock('../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/api')>()),
  ...api,
}))

const POS = { lat: 25.03, lng: 121.56 }
const DEST = { lat: 25.05, lng: 121.5 }
const WPS = [
  { lat: 25.0, lng: 121.5 },
  { lat: 25.01, lng: 121.51 },
]

beforeEach(() => {
  device.connectedDevices = [{ udid: A }]
  for (const fn of Object.values(api)) fn.mockResolvedValue({})
  // Engine is live at POS → backend position synced, no cached-start prompt.
  api.getStatus.mockResolvedValue({ position: POS })
  api.getLastDevicePosition.mockResolvedValue({ position: null })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function mountSim() {
  const ref: { actions: SimActionsValue | null; state: SimStateValue | null } = { actions: null, state: null }
  function Probe() {
    ref.actions = useSimActions()
    ref.state = useSimState()
    return null
  }
  render(<SimProvider><Probe /></SimProvider>)
  // Let the mount-time status fetch settle.
  await act(async () => {})
  return {
    get actions() { return ref.actions! },
    get state() { return ref.state! },
  }
}

async function run(fn: () => unknown) {
  await act(async () => { await fn() })
}

describe('handleStart — Navigate', () => {
  it('toasts and skips the backend when no destination is set', async () => {
    const sim = await mountSim()
    act(() => { sim.actions.setMode(SimMode.Navigate) })
    await run(() => sim.actions.handleStart())
    expect(showToast).toHaveBeenCalledWith('toast.no_destination')
    expect(api.navigate).not.toHaveBeenCalled()
  })

  it('navigates the single device to the destination', async () => {
    const sim = await mountSim()
    act(() => { sim.actions.setMode(SimMode.Navigate) })
    act(() => { sim.actions.handleMapClick(DEST.lat, DEST.lng) })
    await run(() => sim.actions.handleStart())
    expect(api.navigate).toHaveBeenCalledTimes(1)
    expect(api.navigate.mock.calls[0].slice(0, 2)).toEqual([DEST.lat, DEST.lng])
    expect(api.navigate.mock.calls[0][4]).toBeUndefined()
  })

  it('fans out to every connected device in group mode', async () => {
    device.connectedDevices = [{ udid: A }, { udid: B }]
    const sim = await mountSim()
    act(() => { sim.actions.setMode(SimMode.Navigate) })
    act(() => { sim.actions.handleMapClick(DEST.lat, DEST.lng) })
    await run(() => sim.actions.handleStart())
    expect(api.navigate.mock.calls.map((c) => c[4])).toEqual([A, B])
    expect(showToast).toHaveBeenCalledWith('group.action_all_success')
  })

  it('asks before starting from a cached position, then teleports and navigates', async () => {
    api.getStatus.mockResolvedValue({})
    api.getLastDevicePosition.mockResolvedValue({ position: POS })
    const sim = await mountSim()
    expect(sim.state.backendPositionSynced).toBe(false)
    act(() => { sim.actions.setMode(SimMode.Navigate) })
    act(() => { sim.actions.handleMapClick(DEST.lat, DEST.lng) })
    let started: Promise<void> | undefined
    act(() => { started = Promise.resolve(sim.actions.handleStart()) })
    expect(api.navigate).not.toHaveBeenCalled()

    await act(async () => { fireEvent.click(screen.getByText('sync.confirm.ok')) })
    await act(async () => { await started })

    expect(api.teleport).toHaveBeenCalledWith(POS.lat, POS.lng, undefined, undefined)
    expect(api.navigate).toHaveBeenCalledTimes(1)
  })
})

describe('handleStart — Random walk', () => {
  it('toasts when there is no current position', async () => {
    api.getStatus.mockResolvedValue({})
    const sim = await mountSim()
    act(() => { sim.actions.setMode(SimMode.RandomWalk) })
    await run(() => sim.actions.handleStart())
    expect(showToast).toHaveBeenCalledWith('toast.no_position_random')
    expect(api.randomWalk).not.toHaveBeenCalled()
  })

  it('walks around the current position on a single device', async () => {
    const sim = await mountSim()
    act(() => { sim.actions.setMode(SimMode.RandomWalk) })
    await run(() => sim.actions.handleStart())
    expect(api.randomWalk).toHaveBeenCalledTimes(1)
    expect(api.randomWalk.mock.calls[0].slice(0, 2)).toEqual([POS, 500])
  })

  it('fans out to both devices in group mode', async () => {
    device.connectedDevices = [{ udid: A }, { udid: B }]
    const sim = await mountSim()
    act(() => { sim.actions.setMode(SimMode.RandomWalk) })
    await run(() => sim.actions.handleStart())
    expect(api.randomWalk.mock.calls.map((c) => c[5])).toEqual([A, B])
  })
})

describe('handleStart — waypoint routes', () => {
  it('toasts when fewer than two waypoints are staged', async () => {
    const sim = await mountSim()
    act(() => { sim.actions.loadRouteWaypoints([WPS[0]]) })
    await run(() => sim.actions.handleStart())
    expect(showToast).toHaveBeenCalledWith('toast.no_waypoints')
    expect(api.startLoop).not.toHaveBeenCalled()
  })

  it('starts a loop on a single device', async () => {
    const sim = await mountSim()
    act(() => { sim.actions.loadRouteWaypoints(WPS) })
    await run(() => sim.actions.handleStart())
    expect(api.startLoop).toHaveBeenCalledTimes(1)
    expect(api.startLoop.mock.calls[0][0]).toEqual(WPS)
    expect(api.startLoop.mock.calls[0][4]).toBeUndefined()
  })

  it('fans a loop out to both devices', async () => {
    device.connectedDevices = [{ udid: A }, { udid: B }]
    const sim = await mountSim()
    act(() => { sim.actions.loadRouteWaypoints(WPS) })
    await run(() => sim.actions.handleStart())
    expect(api.startLoop.mock.calls.map((c) => c[4])).toEqual([A, B])
  })

  it('starts a multi-stop run on a single device', async () => {
    const sim = await mountSim()
    act(() => {
      sim.actions.loadRouteWaypoints(WPS)
      sim.actions.setMode(SimMode.MultiStop)
    })
    // setMode between route sub-modes keeps the staged chain.
    expect(sim.state.waypoints).toEqual(WPS)
    await run(() => sim.actions.handleStart())
    expect(api.multiStop).toHaveBeenCalledTimes(1)
    expect(api.multiStop.mock.calls[0][0]).toEqual(WPS)
  })

  it('starts a flower run with a single staged point', async () => {
    const sim = await mountSim()
    act(() => {
      sim.actions.loadRouteWaypoints([WPS[0]])
      sim.actions.setMode(SimMode.Flower)
    })
    await run(() => sim.actions.handleStart())
    expect(api.startFlower).toHaveBeenCalledTimes(1)
    expect(api.startFlower.mock.calls[0][0]).toEqual([WPS[0]])
    expect(api.startFlower.mock.calls[0][2]).toMatchObject({ segments: DEFAULT_FLOWER_SETTINGS.segments })
  })
})

describe('handleStart — Joystick', () => {
  it('starts the joystick on a single device', async () => {
    const sim = await mountSim()
    act(() => { sim.actions.setMode(SimMode.Joystick) })
    await run(() => sim.actions.handleStart())
    expect(api.joystickStart).toHaveBeenCalledTimes(1)
  })

  it('fans the joystick out to both devices', async () => {
    device.connectedDevices = [{ udid: A }, { udid: B }]
    const sim = await mountSim()
    act(() => { sim.actions.setMode(SimMode.Joystick) })
    await run(() => sim.actions.handleStart())
    expect(api.joystickStart.mock.calls.map((c) => c[1])).toEqual([A, B])
  })
})

describe('handleStop', () => {
  it('stops the single device', async () => {
    const sim = await mountSim()
    await run(() => sim.actions.handleStop())
    expect(api.stopSim).toHaveBeenCalledTimes(1)
    expect(api.stopSim).toHaveBeenCalledWith()
  })

  it('stops every device in group mode', async () => {
    device.connectedDevices = [{ udid: A }, { udid: B }]
    const sim = await mountSim()
    await run(() => sim.actions.handleStop())
    expect(api.stopSim.mock.calls).toEqual([[A], [B]])
  })

  it('toasts when the single-device stop fails', async () => {
    api.stopSim.mockRejectedValue(new Error('boom'))
    const sim = await mountSim()
    await run(() => sim.actions.handleStop())
    expect(showToast).toHaveBeenCalledWith('toast.action_failed')
  })
})
