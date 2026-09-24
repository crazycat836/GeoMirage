import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type L from 'leaflet'
import { useT } from './i18n'
import type { StringKey } from './i18n/strings'
import { SimMode, type LatLng } from './hooks/useSimulation'
import type { DeviceLostCause } from './hooks/useDevice'
import { STORAGE_KEYS } from './lib/storage-keys'
import { readLS, writeLS } from './lib/local-storage'
import { haversineM, polylineDistanceM } from './lib/geo'
import { estimateFlowerPlan, flowerPlanDistanceM } from './lib/flower'
import { resolveEffectiveKmh } from './lib/sim-derive'
import { useUsageCapture } from './services/usage'

// Context providers
import { ToastProvider, useToastContext } from './contexts/ToastContext'
import { WebSocketProvider } from './contexts/WebSocketContext'
import { DeviceProvider, useDeviceContext } from './contexts/DeviceContext'
import { ConnectionHealthProvider } from './contexts/ConnectionHealthContext'
import { SimProvider, useSimActions, useSimState } from './contexts/SimContext'
import { SimSettingsProvider, useSimSettings } from './contexts/SimSettingsContext'
import { SimDerivedProvider, useSimDerived, useSimOverview } from './contexts/SimDerivedContext'
import { BookmarkProvider, useBookmarkContext } from './contexts/BookmarkContext'
import { RouteLibraryProvider } from './contexts/RouteLibraryContext'
import { AvatarProvider } from './contexts/AvatarContext'

// Components
import MapView from './components/MapView'
import EtaBar from './components/EtaBar'
import UpdateChecker from './components/UpdateChecker'
// Shell components
import TopBar from './components/shell/TopBar'
import Brand from './components/shell/Brand'
import SearchBar from './components/shell/SearchBar'
import BottomModeBar, { isRouteSubMode } from './components/shell/BottomModeBar'
import BottomDock from './components/shell/BottomDock'
import MiniStatusBar from './components/shell/MiniStatusBar'
import TopBarActions from './components/shell/TopBarActions'
import SettingsMenu from './components/shell/SettingsMenu'
import TopCenterStack from './components/shell/TopCenterStack'
import DdiMountingOverlay from './components/shell/DdiMountingOverlay'

// Contexts consumed inside AppShell
import { useConnectionHealth } from './contexts/ConnectionHealthContext'


// Modals/Drawers
import DevicesPopover from './components/device/DevicesPopover'
import LibraryDrawer from './components/modals/LibraryDrawer'
import BookmarkEditDialog, { type BookmarkEditValues } from './components/library/BookmarkEditDialog'
import SaveRouteDialog from './components/library/SaveRouteDialog'

// Root component — just providers.
//
// Order matters: WebSocketProvider is the single owner of the backend
// socket; everything else reads from it. DeviceProvider feeds state
// into ConnectionHealthProvider, which then fans `canOperate` /
// `hint` out to action-button consumers (panels, search bar, banner).
// SimProvider sits inside health so sim consumers can disable actions
// without duplicating the health derivation.

// i18n keys for cause-classified device-lost toasts. `unknown` (and any
// future cause we don't have a key for yet) falls back to the generic
// `toast.device_lost`. Mirrors the SIM_ERROR_KEYS pattern in SimContext.
const DEVICE_LOST_TOAST_KEYS: Record<DeviceLostCause, StringKey> = {
  unknown: 'toast.device_lost',
  usb_removed: 'toast.device_lost.usb_removed',
  wifi_dropped: 'toast.device_lost.wifi_dropped',
  phone_locked: 'toast.device_lost.phone_locked',
  ddi_not_mounted: 'toast.device_lost.ddi_not_mounted',
}

// A crashed movement task arrives as device_error with stage
// `simulation:<mode>` (backend api/location/_helpers.py `spawn`). The map
// localizes the mode label in the toast; unknown modes fall back to the
// raw stage suffix.
// DDI mount overlay safety windows. After "taking long" the overlay reveals
// an elapsed hint + a Cancel escape hatch; after the hard timeout it clears
// itself (so a lost terminating WS frame can't leave the user stuck).
const DDI_TAKING_LONG_MS = 20_000
// Per stage (the timers restart when downloading turns into mounting).
// Must stay above the backend's own per-stage timeouts in core/ddi_mount.py
// (download 60s, mount 45s) so the backend's specific failure reason
// arrives before this generic fallback fires.
const DDI_SAFETY_TIMEOUT_MS = 90_000

// device_error events carrying a stable `code` (backend exceptions that
// expose `.code`, forwarded by api/location/_helpers.py) get a specific
// toast; `{msg}` receives the backend's detail (e.g. the failing leg).
const DEVICE_ERROR_CODE_TOASTS: Record<string, StringKey> = {
  route_unavailable: 'toast.route_unavailable',
}

const SIM_CRASH_STAGE_PREFIX = 'simulation:'
const SIM_CRASH_MODE_KEYS: Record<string, StringKey> = {
  navigate: 'mode.navigate',
  loop: 'mode.loop',
  multi_stop: 'mode.multi_stop',
  random_walk: 'mode.random_walk',
  flower: 'mode.flower',
}

function App() {
  useUsageCapture()
  return (
    <ToastProvider>
      <WebSocketProvider>
        <DeviceProvider>
          <ConnectionHealthProvider>
            <SimSettingsProvider>
              <SimProvider>
                <SimDerivedProvider>
                  <BookmarkProvider>
                    <RouteLibraryProvider>
                      <AvatarProvider>
                        <AppShell />
                      </AvatarProvider>
                    </RouteLibraryProvider>
                  </BookmarkProvider>
                </SimDerivedProvider>
              </SimProvider>
            </SimSettingsProvider>
          </ConnectionHealthProvider>
        </DeviceProvider>
      </WebSocketProvider>
    </ToastProvider>
  )
}

// Map layer — everything that has to follow the position stream (map
// props, planned-route ETA preview, the ETA bar, the add-bookmark dialog's
// "use current position"). Split out of AppShell so a position tick only
// re-renders this subtree, not the whole shell and its popovers.
interface SimMapLayerProps {
  layerKey: string
  pcPosition: { lat: number; lng: number } | null
  onMapReady: (map: L.Map | null) => void
  onTeleportNow: (lat: number, lng: number) => void
  onOpenDevices: () => void
  onSaveRoute: () => void
}

function SimMapLayer({
  layerKey,
  pcPosition,
  onMapReady,
  onTeleportNow,
  onOpenDevices,
  onSaveRoute,
}: SimMapLayerProps) {
  const toast = useToastContext()
  const simActions = useSimActions()
  const sim = useSimState()
  const { currentPos: simCurrentPos, destPos: simDestPos } = useSimDerived()
  const simSettings = useSimSettings()
  const bm = useBookmarkContext()
  const health = useConnectionHealth()

  const mapWaypoints = useMemo(
    () => sim.waypoints.map((w: LatLng, i: number) => ({ ...w, index: i })),
    [sim.waypoints],
  )

  // Static preview for the ETA bar before simulation starts.
  // Only makes sense for routed modes (Navigate / Loop / MultiStop).
  const plannedDistanceM = useMemo(() => {
    const { mode, waypoints } = sim
    if (mode === SimMode.Navigate) {
      return simCurrentPos && simDestPos
        ? haversineM(simCurrentPos, simDestPos)
        : 0
    }
    if (mode === SimMode.Loop) {
      if (waypoints.length < 2) return 0
      return polylineDistanceM(waypoints) + haversineM(waypoints[waypoints.length - 1], waypoints[0])
    }
    if (mode === SimMode.MultiStop) {
      return waypoints.length < 2 ? 0 : polylineDistanceM(waypoints)
    }
    if (mode === SimMode.Flower) {
      const plan = estimateFlowerPlan(waypoints, simSettings.flowerSettings, simCurrentPos)
      return flowerPlanDistanceM(plan) ?? 0
    }
    return 0
  }, [sim.mode, sim.waypoints, simCurrentPos, simDestPos, simSettings.flowerSettings])

  const plannedEtaSeconds = useMemo(() => {
    if (plannedDistanceM <= 0) return 0
    const kmh = resolveEffectiveKmh(sim)
    const ms = kmh * 1000 / 3600
    return ms > 0 ? plannedDistanceM / ms : 0
  }, [plannedDistanceM, sim.customSpeedKmh, sim.speedMinKmh, sim.speedMaxKmh, sim.moveMode])

  return (
    <>
      <MapView
        currentPosition={simCurrentPos}
        currentPositionUnsynced={!!simCurrentPos && !sim.backendPositionSynced}
        destination={simDestPos}
        waypoints={mapWaypoints}
        routePath={sim.routePath}
        flowerRadiusM={sim.mode === SimMode.Flower ? simSettings.flowerSettings.radiusM : null}
        randomWalkRadius={
          sim.mode === SimMode.RandomWalk ? simSettings.randomWalkRadius :
          (sim.mode === SimMode.Loop || sim.mode === SimMode.MultiStop) ? simSettings.wpGenRadius :
          null
        }
        randomWalkCenterPinned={sim.mode === SimMode.RandomWalk && sim.status.running}
        onMapClick={simActions.handleMapClick}
        onTeleport={onTeleportNow}
        onNavigate={simActions.handleNavigate}
        onAddBookmark={bm.handleAddBookmark}
        onAddWaypoint={simActions.handleAddWaypoint}
        showWaypointOption={sim.mode === SimMode.Loop || sim.mode === SimMode.MultiStop || sim.mode === SimMode.Flower}
        onSaveRoute={onSaveRoute}
        showSaveRouteOption={sim.waypoints.length > 0}
        deviceConnected={health.canOperate}
        onOpenDevices={onOpenDevices}
        onShowToast={toast.showToast}
        layerKey={layerKey}
        onMapReady={onMapReady}
        pcPosition={pcPosition}
      />

      {/* Add bookmark dialog (full form with place, tags, note) */}
      <BookmarkEditDialog
        open={!!bm.addBmDialog}
        mode="create"
        initialCoordinates={bm.addBmDialog ?? undefined}
        currentPosition={simCurrentPos}
        places={bm.places}
        tags={bm.tags}
        onClose={() => bm.setAddBmDialog(null)}
        onSubmit={(values: BookmarkEditValues) => bm.submitAddBookmark({
          name: values.name,
          lat: values.lat,
          lng: values.lng,
          place_id: values.placeId,
          tags: values.tagIds,
          note: values.note,
        })}
      />

      {/* The bottom-left device chip was removed in the design-handoff
          phase 3: device info lives in the top-right status pair
          (MiniStatusBar) and the DeviceDrawer trigger lives in the
          TopBar's right action cluster. */}

      <EtaBar
        runtimes={sim.runtimes}
        state={sim.status?.state ?? 'idle'}
        progress={sim.progress}
        remainingDistance={sim.status?.distance_remaining ?? 0}
        traveledDistance={sim.status?.distance_traveled ?? 0}
        eta={sim.eta ?? 0}
        plannedDistanceM={plannedDistanceM}
        plannedEtaSeconds={plannedEtaSeconds}
      />
    </>
  )
}

// Inner shell — layout, popover state, keyboard shortcuts, device/DDI
// toasts. Reads only `useSimOverview()` from the sim, so position ticks
// don't re-render it (or the menus / drawers it renders); the ticking
// parts live in SimMapLayer.
function AppShell() {
  const t = useT()
  const toast = useToastContext()
  const { showToast } = toast
  const device = useDeviceContext()
  // Actions are referentially stable for the app's lifetime.
  const simActions = useSimActions()
  const sim = useSimOverview()
  const health = useConnectionHealth()
  const { handlePause, handleResume, setMode, clearDdiMounting } = simActions

  // Mode switching out of the Route family discards the staged waypoints
  // (see useSimulation.setMode). Warn with a toast when that throws away a
  // non-empty route so the loss is never silent. Switching *within* the Route
  // family (Loop / MultiStop / Random) preserves the chain — no warning there.
  const handleModeChange = useCallback((next: SimMode) => {
    if (isRouteSubMode(sim.mode) && !isRouteSubMode(next) && sim.waypoints.length > 0) {
      toast.showToast(t('toast.route_cleared'))
    }
    setMode(next)
  }, [sim.mode, sim.waypoints.length, setMode, toast, t])

  // Search box: in Teleport mode it stages a pending destination (the
  // panel then shows a Go button) instead of teleporting immediately.
  // Other modes keep instant teleport.
  const handleTeleportOrStage = useCallback((lat: number, lng: number) => {
    if (sim.mode === SimMode.Teleport) {
      // Staging is silent and easy to miss (attention is on the search box,
      // not the dock's Move button) — confirm it and point at the next step.
      simActions.handleSetTeleportDest(lat, lng)
      toast.showToast(t('toast.teleport_staged'))
    } else {
      simActions.handleTeleport(lat, lng)
    }
  }, [sim.mode, simActions, toast, t])

  // Map right-click "Teleport here" always teleports immediately, in every
  // mode (including Teleport) — the context-menu action is an explicit
  // "go there now" gesture, so it never stages a pending pin.
  const handleTeleportNow = useCallback((lat: number, lng: number) => {
    simActions.handleTeleport(lat, lng)
  }, [simActions])

  // UI state
  const [devicesPopoverAnchor, setDevicesPopoverAnchor] = useState<DOMRect | null>(null)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [saveRouteOpen, setSaveRouteOpen] = useState(false)
  const openSaveRoute = useCallback(() => setSaveRouteOpen(true), [])

  // Open the devices popover from places that don't own the trigger button
  // (the device-lost banner, the map context-menu "no device" row). Anchors
  // to the top-bar device button so the popover positions consistently.
  const openDevicesPanel = useCallback(() => {
    const btn = document.querySelector<HTMLElement>('[data-device-trigger]')
    if (btn) setDevicesPopoverAnchor(btn.getBoundingClientRect())
  }, [])

  // Leaflet instance is owned by MapView; we hold a ref here so features
  // like "Locate PC" can pan the camera without teleporting.
  const mapRef = useRef<L.Map | null>(null)
  const handleMapReady = useCallback((map: L.Map | null) => {
    mapRef.current = map
  }, [])
  const handleFlyToCoordinate = useCallback((lat: number, lng: number, zoom?: number) => {
    const map = mapRef.current
    if (!map) return
    map.setView([lat, lng], zoom ?? map.getZoom(), { animate: true })
  }, [])
  // Physical PC coordinate pin — surfaced on the map after the user fires
  // a fly/teleport action from LocatePcButton; cleared on Refresh.
  const [pcMarkerCoord, setPcMarkerCoord] = useState<{ lat: number; lng: number } | null>(null)
  const [layerKey, setLayerKey] = useState(() => readLS(STORAGE_KEYS.tileLayer) || 'osm')
  const handleLayerChange = useCallback((key: string) => {
    setLayerKey(key)
    writeLS(STORAGE_KEYS.tileLayer, key)
  }, [])

  // No auto-scan on WebSocket connect. The backend's _send_initial_state
  // pushes a ``device_snapshot`` frame on every WS (re)connect built from
  // ``connection_state.store`` — that's the SSoT. A REST follow-up here
  // used to clobber it: a WiFi-tunnel device is in the store but invisible
  // to usbmux, so /api/device/list could briefly return ``[]`` and the
  // post-await ``setDevices(list)`` would wipe the snapshot-derived state.
  // The 30s background poll + visibility-change scan in ``useDevice`` still
  // act as a safety net for missed WS events; that path is now also safe
  // because /api/device/list merges store entries (see backend
  // ``api/device.py:list_devices``).

  // Fires one cause-specific toast per involuntary disconnect.
  const prevLastDisconnectTs = useRef(0)
  useEffect(() => {
    const ld = device.lastDisconnect
    if (!ld) return
    if (ld.ts <= prevLastDisconnectTs.current) return
    prevLastDisconnectTs.current = ld.ts
    const key = DEVICE_LOST_TOAST_KEYS[ld.cause] ?? 'toast.device_lost'
    toast.showToast(t(key), 4000)
  }, [device.lastDisconnect, toast, t])

  // Fires one toast per backend-side device setup failure (device_error WS
  // event). Without this the failure is silently dropped — the user keeps
  // trying to drive a device whose engine never came up.
  const prevLastDeviceErrorTs = useRef(0)
  useEffect(() => {
    const le = device.lastDeviceError
    if (!le) return
    if (le.ts <= prevLastDeviceErrorTs.current) return
    prevLastDeviceErrorTs.current = le.ts
    const codedKey = le.code ? DEVICE_ERROR_CODE_TOASTS[le.code] : undefined
    if (codedKey) {
      toast.showToast(t(codedKey, { msg: le.error }), 6000)
      return
    }
    if (le.stage.startsWith(SIM_CRASH_STAGE_PREFIX)) {
      // Movement task crashed mid-run — the engine already dropped to
      // idle; explain why instead of showing the generic setup-failure copy.
      const rawMode = le.stage.slice(SIM_CRASH_STAGE_PREFIX.length)
      const modeKey = SIM_CRASH_MODE_KEYS[rawMode]
      toast.showToast(
        t('toast.simulation_crashed', { mode: modeKey ? t(modeKey) : rawMode }),
        4000,
      )
      return
    }
    toast.showToast(t('toast.device_error'), 4000)
  }, [device.lastDeviceError, toast, t])

  // DDI mount overlay robustness. The full-screen "Preparing device" overlay
  // is driven purely by the `ddi_mounting` WS frame and is only cleared by a
  // terminating frame. If that frame is lost (backend crash / mid-mount
  // disconnect) the overlay would block the whole UI forever. Guard it:
  //   1. after a grace window, reveal an elapsed hint + Cancel button;
  //   2. after a hard timeout, clear it and surface a timeout toast;
  //   3. clear immediately if the WS transport goes offline (the offline
  //      banner then explains the real problem).
  const [ddiTakingLong, setDdiTakingLong] = useState(false)
  // Whether this mount started with a download, so the mounting stage can
  // read "step 2 of 2" instead of looking like a fresh, unrelated wait.
  const [ddiDownloaded, setDdiDownloaded] = useState(false)
  useEffect(() => {
    setDdiTakingLong(false)
    if (!sim.ddiMounting) {
      setDdiDownloaded(false)
      return
    }
    if (sim.ddiMounting === 'downloading') setDdiDownloaded(true)
    const graceTimer = setTimeout(() => setDdiTakingLong(true), DDI_TAKING_LONG_MS)
    const safetyTimer = setTimeout(() => {
      clearDdiMounting()
      showToast(t('toast.ddi_timeout'), 6000)
    }, DDI_SAFETY_TIMEOUT_MS)
    return () => {
      clearTimeout(graceTimer)
      clearTimeout(safetyTimer)
    }
  }, [sim.ddiMounting, clearDdiMounting, showToast, t])
  useEffect(() => {
    if (sim.ddiMounting && health.ws === 'offline') clearDdiMounting()
  }, [sim.ddiMounting, health.ws, clearDdiMounting])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'
      if (e.metaKey && e.key === 'b') {
        e.preventDefault(); setLibraryOpen(true); return
      }
      // Escape is not handled here: the library drawer and every dialog /
      // menu close themselves through the useEscLayer stack, one layer per
      // press.
      if (!isInput && e.key >= '1' && e.key <= '4') {
        const modeForKey: SimMode[] = [SimMode.Teleport, SimMode.Navigate, SimMode.Loop, SimMode.Joystick]
        const next = modeForKey[parseInt(e.key) - 1]
        // Like the Route tab: pressing 3 while in Flower stays in Flower.
        handleModeChange(next === SimMode.Loop && sim.mode === SimMode.Flower ? SimMode.Flower : next)
        return
      }
      if (!isInput && e.key === ' ' && sim.isRunning) {
        e.preventDefault()
        if (sim.isPaused) handleResume()
        else handlePause()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
    // Deps are stable actions + the two run-state booleans — the listener
    // re-subscribes when the run/pause state flips, not on position ticks.
  }, [handleModeChange, sim.mode, sim.isRunning, sim.isPaused, handlePause, handleResume])

  return (
    <div className="relative w-screen h-screen overflow-hidden">
      <a
        href="#map-canvas"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[var(--z-toast)] focus:bg-[var(--color-accent)] focus:text-white focus:rounded-md focus:no-underline focus:font-semibold focus:px-3 focus:py-1.5"
      >
        Skip to map
      </a>
      <div data-fc="overlay.noise" className="noise-overlay" aria-hidden />

      {/* Full-screen map layer */}
      <div id="map-canvas" className="absolute inset-0">

        {sim.ddiMounting && (
          <DdiMountingOverlay
            stage={sim.ddiMounting}
            afterDownload={ddiDownloaded}
            takingLong={ddiTakingLong}
            onCancel={clearDdiMounting}
          />
        )}

        <SimMapLayer
          layerKey={layerKey}
          pcPosition={pcMarkerCoord}
          onMapReady={handleMapReady}
          onTeleportNow={handleTeleportNow}
          onOpenDevices={openDevicesPanel}
          onSaveRoute={openSaveRoute}
        />
        <UpdateChecker />
      </div>

      {/* Floating overlay components — siblings of the map container so
          they read as shell chrome, not map content. */}
      <MiniStatusBar />

      {/* Single owner of the top-center status region (error / connection /
          device / DDI banners + pause + cooldown + transient toast). */}
      <TopCenterStack onOpenDevices={openDevicesPanel} />

      <TopBar
        leftContent={<Brand />}
        centerContent={
          <SearchBar onTeleport={handleTeleportOrStage} deviceConnected={health.canOperate} />
        }
        rightContent={
          <TopBarActions
            onDeviceClick={(anchor) => {
              // Open the compact popover anchored to the clicked button.
              // "Manage" inside escalates to the full DeviceDrawer.
              setDevicesPopoverAnchor(anchor.getBoundingClientRect())
            }}
            onLibraryClick={() => setLibraryOpen(true)}
            onSettingsClick={() => setSettingsOpen(prev => !prev)}
            onFlyToCoordinate={handleFlyToCoordinate}
            onPcLocated={setPcMarkerCoord}
          />
        }
      />

      <BottomDock />

      <BottomModeBar activeMode={sim.mode} onModeChange={handleModeChange} />
      <SettingsMenu open={settingsOpen} onClose={() => setSettingsOpen(false)} layerKey={layerKey} onLayerChange={handleLayerChange} />
      <DevicesPopover
        anchor={devicesPopoverAnchor}
        onClose={() => setDevicesPopoverAnchor(null)}
      />
      <LibraryDrawer open={libraryOpen} onClose={() => setLibraryOpen(false)} />
      <SaveRouteDialog open={saveRouteOpen} onClose={() => setSaveRouteOpen(false)} />
    </div>
  )
}

export default App
