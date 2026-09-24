// @vitest-environment jsdom
/**
 * Render-count guard for AppShell: a position tick must re-render only the
 * map layer (MapView / EtaBar / add-bookmark dialog), not the shell and the
 * popovers / drawers it renders. Every child component is a stub that
 * counts its renders; a stub re-renders only when its parent (AppShell or
 * SimMapLayer) does.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createContext, useContext, useState, type ReactNode } from 'react'
import { render, act, cleanup } from '@testing-library/react'

const h = vi.hoisted(() => {
  const renders: Record<string, number> = {}
  const stub = (name: string) => function Stub() {
    renders[name] = (renders[name] ?? 0) + 1
    return null
  }
  const passthrough = ({ children }: { children: unknown }) => children
  return {
    renders,
    stub,
    passthrough,
    toastValue: { showToast: () => {} },
    deviceValue: { lastDisconnect: null, lastDeviceError: null },
    healthValue: { canOperate: true, ws: 'online' },
    settingsValue: { flowerSettings: { radiusM: 100 }, randomWalkRadius: 500, wpGenRadius: 300 },
    bmValue: { addBmDialog: null, places: [], tags: [], setAddBmDialog: () => {}, submitAddBookmark: () => {}, handleAddBookmark: () => {} },
  }
})
const { renders } = h

vi.mock('./services/usage', () => ({ useUsageCapture: () => {} }))
vi.mock('./i18n', () => {
  const t = (k: string) => k
  return { useT: () => t }
})

vi.mock('./contexts/ToastContext', () => ({
  ToastProvider: h.passthrough,
  useToastContext: () => h.toastValue,
}))
vi.mock('./contexts/WebSocketContext', () => ({ WebSocketProvider: h.passthrough }))
vi.mock('./contexts/DeviceContext', () => ({
  DeviceProvider: h.passthrough,
  useDeviceContext: () => h.deviceValue,
}))
vi.mock('./contexts/ConnectionHealthContext', () => ({
  ConnectionHealthProvider: h.passthrough,
  useConnectionHealth: () => h.healthValue,
}))
vi.mock('./contexts/SimSettingsContext', () => ({
  SimSettingsProvider: h.passthrough,
  useSimSettings: () => h.settingsValue,
}))
vi.mock('./contexts/BookmarkContext', () => ({
  BookmarkProvider: h.passthrough,
  useBookmarkContext: () => h.bmValue,
}))
vi.mock('./contexts/RouteLibraryContext', () => ({ RouteLibraryProvider: h.passthrough }))
vi.mock('./contexts/AvatarContext', () => ({ AvatarProvider: h.passthrough }))

// Fake SimProvider: holds a SimStateValue-shaped object in React state so
// the real SimDerivedProvider sees ticks exactly as it would in the app.
type FakeSim = Record<string, unknown>
let setSim: ((fn: (s: FakeSim) => FakeSim) => void) | null = null
vi.mock('./contexts/SimContext', () => {
  const Ctx = createContext<FakeSim | null>(null)
  const actions = {
    setMode: () => {}, handlePause: () => {}, handleResume: () => {}, clearDdiMounting: () => {},
    handleTeleport: () => {}, handleSetTeleportDest: () => {}, handleMapClick: () => {},
    handleNavigate: () => {}, handleAddWaypoint: () => {},
  }
  function SimProvider({ children }: { children: ReactNode }) {
    const [sim, set] = useState<FakeSim>(() => ({
      mode: 'navigate',
      moveMode: 'walking',
      status: { running: true, paused: false, state: 'navigating' },
      currentPosition: { lat: 25, lng: 121 },
      backendPositionSynced: true,
      destination: { lat: 25.1, lng: 121.1 },
      progress: 0,
      eta: 100,
      waypoints: [],
      routePath: [],
      customSpeedKmh: null,
      speedMinKmh: null,
      speedMaxKmh: null,
      runtimes: {},
      ddiMounting: false,
      effectiveSpeed: null,
    }))
    setSim = set
    return <Ctx.Provider value={sim}>{children}</Ctx.Provider>
  }
  return {
    SimProvider,
    useSimState: () => useContext(Ctx),
    useSimActions: () => actions,
  }
})

vi.mock('./components/MapView', () => ({ default: h.stub('MapView') }))
vi.mock('./components/EtaBar', () => ({ default: h.stub('EtaBar') }))
vi.mock('./components/UpdateChecker', () => ({ default: h.stub('UpdateChecker') }))
vi.mock('./components/shell/TopBar', () => ({ default: h.stub('TopBar') }))
vi.mock('./components/shell/Brand', () => ({ default: h.stub('Brand') }))
vi.mock('./components/shell/SearchBar', () => ({ default: h.stub('SearchBar') }))
vi.mock('./components/shell/BottomModeBar', () => ({ default: h.stub('BottomModeBar'), isRouteSubMode: () => false }))
vi.mock('./components/shell/BottomDock', () => ({ default: h.stub('BottomDock') }))
vi.mock('./components/shell/MiniStatusBar', () => ({ default: h.stub('MiniStatusBar') }))
vi.mock('./components/shell/TopBarActions', () => ({ default: h.stub('TopBarActions') }))
vi.mock('./components/shell/SettingsMenu', () => ({ default: h.stub('SettingsMenu') }))
vi.mock('./components/shell/TopCenterStack', () => ({ default: h.stub('TopCenterStack') }))
vi.mock('./components/shell/DdiMountingOverlay', () => ({ default: h.stub('DdiMountingOverlay') }))
vi.mock('./components/device/DevicesPopover', () => ({ default: h.stub('DevicesPopover') }))
vi.mock('./components/modals/LibraryDrawer', () => ({ default: h.stub('LibraryDrawer') }))
vi.mock('./components/library/BookmarkEditDialog', () => ({ default: h.stub('BookmarkEditDialog') }))
vi.mock('./components/library/SaveRouteDialog', () => ({ default: h.stub('SaveRouteDialog') }))

import App from './App'

afterEach(() => {
  cleanup()
  for (const k of Object.keys(renders)) delete renders[k]
})

function tick(lat: number) {
  act(() => {
    setSim!((s) => ({
      ...s,
      currentPosition: { lat, lng: 121 },
      progress: (s.progress as number) + 0.01,
      eta: (s.eta as number) - 1,
      status: { ...(s.status as object) },
      runtimes: { A: { udid: 'A', tunnelDegraded: false } },
    }))
  })
}

describe('AppShell render isolation', () => {
  it('re-renders only the map layer on position ticks', () => {
    render(<App />)
    const before = { ...renders }

    tick(25.001)
    tick(25.002)
    tick(25.003)

    // The map layer follows the stream…
    expect(renders.MapView).toBe(before.MapView + 3)
    expect(renders.EtaBar).toBe(before.EtaBar + 3)
    // …the shell and its menus / drawers do not.
    for (const name of ['TopBar', 'BottomModeBar', 'SettingsMenu', 'DevicesPopover', 'LibraryDrawer', 'SaveRouteDialog', 'TopCenterStack']) {
      expect(renders[name], name).toBe(before[name])
    }
  })

  it('re-renders the shell when the run state flips', () => {
    render(<App />)
    const before = renders.SettingsMenu
    act(() => {
      setSim!((s) => ({ ...s, status: { running: true, paused: true, state: 'paused' } }))
    })
    expect(renders.SettingsMenu).toBe(before + 1)
  })
})
