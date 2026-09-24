import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import * as api from '../services/api'
import type { LatLng } from './sim/types'
import {
  useSimRuntimes,
  emptyRuntime,
  primaryRuntimeKey,
  type DeviceRuntime,
  type RuntimesMap,
} from './sim/useSimRuntimes'
import {
  useSimWsDispatcher,
  type WsSubscribe,
  type SimErrorCode,
  type SimulationStatus,
} from './sim/useSimWsDispatcher'
import {
  usePauseSettings,
  useStraightLineToggle,
  type PauseSetting,
} from './sim/usePauseSettings'
import { MoveMode, useSpeedPrefs, type SpeedPrefs } from './sim/useSpeedPrefs'
import type { FlowerSettings } from '../lib/flower'
import type { FlowerOpts } from '../services/locationApi'
import {
  useSimGroupActions,
  type FanoutOutcome,
} from './sim/useSimGroupActions'

/** One-shot DDI-failure signal. `hintKey` picks the banner text (backend
 *  `hint_key`); `udid` lets the banner offer a per-device action such as
 *  revealing the Developer Mode toggle. */
/** `false` when idle; otherwise which DDI step the backend is on. */
export type DdiMountingState = false | 'downloading' | 'mounting'

export type DdiMissingSignal = {
  reason: string
  stage?: string
  udid?: string
  hintKey?: string
  ts: number
}

// Re-export the public types so existing callers (DeviceChip, EtaBar,
// SimContext, App.tsx, etc.) keep importing from `'../hooks/useSimulation'`
// without churn.
export type { LatLng, DeviceRuntime, RuntimesMap, WsSubscribe, SimErrorCode, SimulationStatus, PauseSetting, FanoutOutcome }
export { emptyRuntime, MoveMode }

export enum SimMode {
  Teleport = 'teleport',
  Navigate = 'navigate',
  Loop = 'loop',
  Joystick = 'joystick',
  MultiStop = 'multistop',
  RandomWalk = 'randomwalk',
  Flower = 'flower',
}

/** Wire payload for a flower run (backend `FlowerRequest` field names). */
export function flowerOpts(s: FlowerSettings): FlowerOpts {
  return {
    radius_m: s.radiusM,
    segments: s.segments,
    laps: s.laps,
    rounds: s.rounds,
    wait_before_s: s.waitBeforeS,
    wait_after_s: s.waitAfterS,
    transfer: s.transfer,
  }
}

/** Loop / MultiStop / RandomWalk / Flower are the "Route" sub-modes: they live
 *  behind the single "Route" tab in the mode bar and share one staged
 *  waypoint chain. Defined next to SimMode (not in a component) so both the
 *  UI and `setMode`'s guard can reference one definition. */
export const ROUTE_SUB_MODES: ReadonlySet<SimMode> = new Set([
  SimMode.Loop,
  SimMode.MultiStop,
  SimMode.RandomWalk,
  SimMode.Flower,
])

export function isRouteSubMode(mode: SimMode): boolean {
  return ROUTE_SUB_MODES.has(mode)
}

// Explicit speed selection used to hot-swap a running route's speed without
// reading hook state. Passing the values explicitly (rather than relying on
// the `applySpeed` closure) avoids a stale-closure bug: a caller that does
// `setMoveMode(x)` then `applySpeed()` in the same tick would otherwise send
// the *previous* moveMode, because the state update hasn't re-rendered yet.
export type SpeedSelection = SpeedPrefs

/** Map backend state strings to SimMode. */
function stateToMode(state: string): SimMode | null {
  switch (state) {
    case 'navigating': return SimMode.Navigate
    case 'looping': return SimMode.Loop
    case 'multi_stop': return SimMode.MultiStop
    case 'random_walk': return SimMode.RandomWalk
    case 'flower': return SimMode.Flower
    case 'joystick': return SimMode.Joystick
    default: return null
  }
}

/** Inverse of `stateToMode` — the engine state a mode runs in. Used for
 *  optimistic runtime patches (resume) where the backend state string
 *  isn't known yet. Teleport has no running state → null. */
function modeToState(mode: SimMode): string | null {
  switch (mode) {
    case SimMode.Navigate: return 'navigating'
    case SimMode.Loop: return 'looping'
    case SimMode.MultiStop: return 'multi_stop'
    case SimMode.RandomWalk: return 'random_walk'
    case SimMode.Flower: return 'flower'
    case SimMode.Joystick: return 'joystick'
    default: return null
  }
}

/** States in which the engine is actively simulating. `paused` counts as
 *  running — a paused run is still a run (the pause/resume pill stays). */
function isActiveState(state: string | undefined): boolean {
  return state != null && state !== 'idle' && state !== 'disconnected'
}

// Stable empty path so the derived `routePath` keeps referential identity
// across renders when no runtime exists yet.
const EMPTY_ROUTE_PATH: LatLng[] = []

export interface UseSimulationOptions {
  /**
   * Optional code → localised string translator. Owned by the consumer
   * (SimContext has `useT`); the hook itself stays i18n-agnostic. When
   * omitted, the raw error code is stored — fine for tests / non-UI use.
   */
  translateError?: (code: SimErrorCode) => string
  /**
   * DeviceContext's primary device udid (`connectedDevices[0]`). The
   * derived single-device view and optimistic single-device patches
   * follow it; null/omitted falls back to the first runtime entry.
   */
  primaryUdid?: string | null
  /**
   * `useWebSocket().connectEpoch`: bumped on every accepted socket. The
   * status / last-position seed re-runs on each bump so a backend that was
   * still starting at mount (or restarted) is re-read.
   */
  connectEpoch?: number
}

export function useSimulation(subscribe?: WsSubscribe, options?: UseSimulationOptions) {
  const translateError = options?.translateError
  const primaryUdid = options?.primaryUdid ?? null
  const connectEpoch = options?.connectEpoch ?? 0
  // Latest translator in a ref so the WS subscribe effect can call it
  // without listing `translateError` in its deps (which would otherwise
  // tear down + rebuild the subscriber every time the i18n language flips).
  const translateErrorRef = useRef<((code: SimErrorCode) => string) | undefined>(translateError)
  useEffect(() => { translateErrorRef.current = translateError }, [translateError])

  const localizeError = useCallback((code: SimErrorCode): string => {
    const fn = translateErrorRef.current
    return fn ? fn(code) : code
  }, [])
  const [mode, _setMode] = useState<SimMode>(SimMode.Teleport)
  // Latest mode in a ref so optimistic action handlers can capture the
  // pre-call value cheaply (without re-creating their useCallback identity
  // on every mode change). Used by navigate/startLoop/multiStop/randomWalk/
  // joystickStart to roll back if the backend rejects the request.
  const modeRef = useRef(mode)
  useEffect(() => { modeRef.current = mode }, [mode])
  // Speed prefs (moveMode + the custom/min/max overrides) live in their
  // own hook: lazy localStorage load on mount, persisted on every change.
  const {
    moveMode, setMoveMode,
    customSpeedKmh, setCustomSpeedKmh,
    speedMinKmh, setSpeedMinKmh,
    speedMaxKmh, setSpeedMaxKmh,
  } = useSpeedPrefs()
  // Engine speed multiplier reported by the initial `getStatus()` fetch.
  // Feeds the derived `status.speed` field (no consumer reads it today,
  // but the public SimulationStatus shape keeps it).
  const [statusSpeed, setStatusSpeed] = useState(0)
  // True once the backend engine is known to hold the same position the UI is
  // showing — i.e. a teleport/navigate/etc. has succeeded this session, an
  // initial `getStatus()` returned a live position, or a WS position_update
  // arrived. False immediately after startup when the pin is purely a
  // rehydrated cache from persisted settings (backend engine is idle to
  // preserve the phone's real GPS). The UI uses this flag to dim the cached
  // pin and to prompt before the first movement action.
  const [backendPositionSynced, setBackendPositionSynced] = useState(false)
  // User-input state: the destination marker (map clicks, search results)
  // and staged waypoints. These are NOT device state — they stay real
  // state here; the WS dispatcher only ever CLEARS destination.
  const [destination, setDestination] = useState<LatLng | null>(null)
  const [waypoints, setWaypoints] = useState<LatLng[]>([])
  // Global "straight-line path" toggle. When on, all nav modes bypass OSRM
  // and move along densified straight segments between waypoints.
  const [straightLine, setStraightLine] = useStraightLineToggle()

  // Per-mode pause settings, persisted in localStorage. Default
  // {enabled: true, min: 5, max: 20} matches backend DEFAULT_PAUSE_*.
  const {
    pauseLoop, pauseMultiStop, pauseRandomWalk,
    setPauseLoop, setPauseMultiStop, setPauseRandomWalk,
  } = usePauseSettings()
  const [error, setError] = useState<string | null>(null)
  // Random-walk pause countdown (unix epoch seconds of when pause ends)
  const [pauseEndAt, setPauseEndAt] = useState<number | null>(null)
  const [pauseRemaining, setPauseRemaining] = useState<number | null>(null)
  const [ddiMounting, setDdiMounting] = useState<DdiMountingState>(false)
  // One-shot signal consumed by SimContext's toast observer. `ts`
  // deduplicates repeats of the same failure across re-renders.
  const [ddiMissing, setDdiMissing] = useState<DdiMissingSignal | null>(null)
  const [waypointProgress, setWaypointProgress] = useState<{ current: number; next: number; total: number } | null>(null)
  // Loop / MultiStop target lap count. null = unlimited (existing
  // behaviour). Positive = backend will auto-stop after N laps.
  const [loopLapCount, setLoopLapCount] = useState<number | null>(1)
  // Progress readout from the `lap_complete` WS event. total is the
  // target (when set) so the UI can render "3 / 5" style.
  const [lapProgress, setLapProgress] = useState<{ current: number; total: number | null } | null>(null)
  // What's *actually* running on the device — set when a route handler
  // starts or when applySpeed succeeds. Used by the status bar so the user
  // doesn't see the typed-but-unapplied speed before pressing Apply.
  const [effectiveSpeed, setEffectiveSpeed] = useState<
    { mode: MoveMode; kmh: number | null; min: number | null; max: number | null } | null
  >(null)

  // Per-device runtime map — the single source of truth for device
  // simulation state. Populated from WS events via the dispatcher hook
  // below and patched optimistically by the action handlers here. The
  // single-device fields this hook returns (currentPosition, status,
  // progress, eta, routePath) are derived from the primary entry.
  const { runtimes, setRuntimes, updateRuntime, patchPrimaryRuntime } = useSimRuntimes(primaryUdid)
  // Latest primary udid for the WS dispatcher's overlay gating.
  const primaryUdidRef = useRef(primaryUdid)
  useEffect(() => { primaryUdidRef.current = primaryUdid }, [primaryUdid])
  const getPrimaryUdid = useCallback(() => primaryUdidRef.current, [])

  // Tick the pause countdown at 1 Hz
  useEffect(() => {
    if (pauseEndAt == null) {
      setPauseRemaining(null)
      return
    }
    const tick = () => {
      const rem = Math.max(0, Math.round((pauseEndAt - Date.now()) / 1000))
      setPauseRemaining(rem)
      if (rem <= 0) setPauseEndAt(null)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [pauseEndAt])

  // Wire incoming WS messages into the runtimes map (per-device state)
  // and the session-global setters (overlays, DDI, error). The dispatcher
  // itself owns no state — it just routes events to the setters bundled
  // below. The bundle is rebuilt each render but the dispatcher captures
  // it via a ref so its subscribe effect doesn't tear down on every
  // parent re-render.
  useSimWsDispatcher(subscribe, {
    setRuntimes,
    updateRuntime,
    patchPrimaryRuntime,
    setBackendPositionSynced,
    setDestination,
    setPauseEndAt,
    setWaypointProgress,
    setLapProgress,
    setDdiMounting,
    setDdiMissing,
    setError,
    localizeError,
    getPrimaryUdid,
  })

  // Derived: primary runtime feeding the single-device view below —
  // the primary device's slot (see `primaryRuntimeKey`). Memoised so
  // consumers see a stable reference between renders when `runtimes`
  // itself is unchanged.
  const primaryRuntime: DeviceRuntime | null = useMemo(() => {
    const key = primaryRuntimeKey(runtimes, primaryUdid)
    return key ? runtimes[key] : null
  }, [runtimes, primaryUdid])
  const anyRunning = Object.values(runtimes).some((r) => isActiveState(r.state))

  // ── Single-device view (derived from the primary runtime) ──────────
  // These keep the names and semantics the pre-refactor legacy state
  // exposed, but there is no separate write path any more: WS frames and
  // optimistic actions both patch `runtimes`, and the view falls out.
  const currentPosition = primaryRuntime?.currentPos ?? null
  const progress = primaryRuntime?.progress ?? 0
  const eta = primaryRuntime?.eta ?? null
  const routePath = primaryRuntime?.routePath ?? EMPTY_ROUTE_PATH
  const status: SimulationStatus = useMemo(() => ({
    running: isActiveState(primaryRuntime?.state),
    paused: primaryRuntime?.state === 'paused',
    speed: statusSpeed,
    state: primaryRuntime?.state,
    ...(primaryRuntime
      ? {
          distance_remaining: primaryRuntime.distanceRemaining,
          distance_traveled: primaryRuntime.distanceTraveled,
        }
      : {}),
  }), [primaryRuntime, statusSpeed])

  // Imperative position setter kept for optimistic writers outside this
  // hook (SimContext's multi-device teleport). Routes through the same
  // runtimes write path as everything else.
  const setCurrentPosition = useCallback((pos: LatLng | null) => {
    patchPrimaryRuntime({ currentPos: pos })
  }, [patchPrimaryRuntime])

  const clearError = useCallback(() => setError(null), [])

  // Force-clear the DDI mount overlay. Used by App's client-side safety
  // timeout / WS-offline guard / user Cancel so the full-screen overlay
  // can't get stuck if the terminating WS frame is lost (backend crash or
  // mid-mount disconnect).
  const clearDdiMounting = useCallback(() => setDdiMounting(false), [])

  // Drop the staged destination + rendered route so stale setup doesn't
  // leak across mode switches / route loads. Waypoints are handled by the
  // caller (setMode clears them, loadRouteWaypoints replaces them).
  const clearStagedRoute = useCallback(() => {
    setDestination(null)
    patchPrimaryRuntime({ routePath: [], progress: 0, eta: null })
  }, [patchPrimaryRuntime])

  // Public mode setter: clears the destination marker + route path when the
  // user switches mode tabs. Internal handlers (teleport/navigate/loop/...)
  // still use _setMode directly so they can set destination in the same tick.
  const setMode = useCallback((next: SimMode) => {
    _setMode((prev) => {
      if (prev === next) return prev
      // Switching among the Route sub-modes (Loop / MultiStop / RandomWalk)
      // keeps the staged waypoints — they share one chain, so flipping
      // Loop↔MultiStop↔Random must NOT discard the user's hand-placed points.
      // Any other transition clears the staged destination + route so stale
      // setup doesn't leak across unrelated modes. (Callers that want to warn
      // the user about a non-empty discard do so before calling setMode.)
      if (isRouteSubMode(prev) && isRouteSubMode(next)) return next
      clearStagedRoute()
      setWaypoints([])
      return next
    })
  }, [clearStagedRoute])

  // Load a saved route into the Route editor (Loop, or Flower when that
  // sub-mode is already selected). Uses the raw mode
  // setter (like the internal start-handlers): combining setMode with
  // setWaypoints is ordering-sensitive (points staged before the mode
  // switch get wiped by setMode's clear), so route-load gets one explicit
  // action that can't be broken by call order.
  const loadRouteWaypoints = useCallback((wps: LatLng[]) => {
    _setMode((prev) => (prev === SimMode.Flower ? prev : SimMode.Loop))
    clearStagedRoute()
    setWaypoints(wps)
  }, [clearStagedRoute])

  const teleport = useCallback(async (lat: number, lng: number, autoJitter?: boolean) => {
    // Mode is owned by the user's explicit tab choice; the backend
    // stops any active simulation atomically on teleport, so we don't
    // touch mode here — quick-fly actions (bookmark click, search,
    // TeleportPanel "Go") keep the current Loop / MultiStop / Navigate.
    setError(null)
    const res = await api.teleport(lat, lng, undefined, autoJitter)
    patchPrimaryRuntime({ currentPos: { lat, lng }, progress: 0, eta: null })
    setBackendPositionSynced(true)
    setDestination(null)
    return res
  }, [patchPrimaryRuntime])

  const navigate = useCallback(
    async (lat: number, lng: number) => {
      setError(null)
      // Capture pre-call state for rollback on backend rejection. Without
      // this the tab UI stays on "Navigate" with a destination pin while
      // the engine is actually idle.
      const prevMode = modeRef.current
      _setMode(SimMode.Navigate)
      setDestination({ lat, lng })
      patchPrimaryRuntime({ progress: 0 })
      try {
        const res = await api.navigate(lat, lng, moveMode, { speed_kmh: customSpeedKmh, speed_min_kmh: speedMinKmh, speed_max_kmh: speedMaxKmh }, undefined, straightLine)
        // Optimistic running flip: the derived status reads running=true
        // from the active state string; the authoritative `state_change`
        // lands moments later with the same value.
        patchPrimaryRuntime({ state: 'navigating' })
        setEffectiveSpeed({ mode: moveMode, kmh: customSpeedKmh, min: speedMinKmh, max: speedMaxKmh })
        return res
      } catch (err) {
        _setMode(prevMode)
        setDestination(null)
        throw err
      }
    },
    // navigate body doesn't read pauseMultiStop / pauseLoop / pauseRandomWalk —
    // dropping them so this callback identity doesn't churn on unrelated edits.
    [moveMode, customSpeedKmh, speedMinKmh, speedMaxKmh, straightLine, patchPrimaryRuntime],
  )

  const startLoop = useCallback(
    async (wps: LatLng[]) => {
      setError(null)
      const prevMode = modeRef.current
      _setMode(SimMode.Loop)
      // Don't setWaypoints(wps) — wps is the route as sent to the backend
      // (already includes the start position from caller). Overwriting UI
      // waypoints here would prepend the start point on every restart,
      // and break the backend↔UI seg_idx mapping for highlighting.
      patchPrimaryRuntime({ progress: 0 })
      setLapProgress(loopLapCount != null ? { current: 0, total: loopLapCount } : null)
      try {
        const res = await api.startLoop(wps, moveMode, { speed_kmh: customSpeedKmh, speed_min_kmh: speedMinKmh, speed_max_kmh: speedMaxKmh }, { pause_enabled: pauseLoop.enabled, pause_min: pauseLoop.min, pause_max: pauseLoop.max }, undefined, straightLine, loopLapCount)
        patchPrimaryRuntime({ state: 'looping' })
        setEffectiveSpeed({ mode: moveMode, kmh: customSpeedKmh, min: speedMinKmh, max: speedMaxKmh })
        return res
      } catch (err) {
        _setMode(prevMode)
        setLapProgress(null)
        throw err
      }
    },
    // Body reads only pauseLoop — keep deps tight so this callback identity
    // doesn't churn on unrelated pauseMultiStop / pauseRandomWalk edits.
    [moveMode, customSpeedKmh, speedMinKmh, speedMaxKmh, pauseLoop, straightLine, loopLapCount, patchPrimaryRuntime],
  )

  const multiStop = useCallback(
    async (wps: LatLng[], stopDuration: number, loop: boolean) => {
      setError(null)
      const prevMode = modeRef.current
      _setMode(SimMode.MultiStop)
      // See startLoop — do not overwrite UI waypoints with the backend route.
      patchPrimaryRuntime({ progress: 0 })
      setLapProgress(loop && loopLapCount != null ? { current: 0, total: loopLapCount } : null)
      try {
        const res = await api.multiStop(wps, moveMode, stopDuration, loop, { speed_kmh: customSpeedKmh, speed_min_kmh: speedMinKmh, speed_max_kmh: speedMaxKmh }, { pause_enabled: pauseMultiStop.enabled, pause_min: pauseMultiStop.min, pause_max: pauseMultiStop.max }, undefined, straightLine, loop ? loopLapCount : null)
        patchPrimaryRuntime({ state: 'multi_stop' })
        setEffectiveSpeed({ mode: moveMode, kmh: customSpeedKmh, min: speedMinKmh, max: speedMaxKmh })
        return res
      } catch (err) {
        _setMode(prevMode)
        setLapProgress(null)
        throw err
      }
    },
    // Body reads only pauseMultiStop — mirror of startLoop above.
    [moveMode, customSpeedKmh, speedMinKmh, speedMaxKmh, pauseMultiStop, straightLine, loopLapCount, patchPrimaryRuntime],
  )

  const randomWalk = useCallback(
    async (center: LatLng, radiusM: number) => {
      setError(null)
      const prevMode = modeRef.current
      _setMode(SimMode.RandomWalk)
      patchPrimaryRuntime({ progress: 0 })
      try {
        const res = await api.randomWalk(center, radiusM, moveMode, { speed_kmh: customSpeedKmh, speed_min_kmh: speedMinKmh, speed_max_kmh: speedMaxKmh }, { pause_enabled: pauseRandomWalk.enabled, pause_min: pauseRandomWalk.min, pause_max: pauseRandomWalk.max }, undefined, undefined, straightLine)
        patchPrimaryRuntime({ state: 'random_walk' })
        setEffectiveSpeed({ mode: moveMode, kmh: customSpeedKmh, min: speedMinKmh, max: speedMaxKmh })
        return res
      } catch (err) {
        _setMode(prevMode)
        throw err
      }
    },
    // Body uses only pauseRandomWalk — drop the other two pause settings.
    [moveMode, customSpeedKmh, speedMinKmh, speedMaxKmh, pauseRandomWalk, straightLine, patchPrimaryRuntime],
  )

  const startFlower = useCallback(
    async (wps: LatLng[], settings: FlowerSettings) => {
      setError(null)
      const prevMode = modeRef.current
      _setMode(SimMode.Flower)
      // See startLoop — the UI waypoints stay as the user staged them.
      patchPrimaryRuntime({ progress: 0 })
      setLapProgress(settings.rounds != null ? { current: 0, total: settings.rounds } : null)
      try {
        const res = await api.startFlower(wps, moveMode, flowerOpts(settings), { speed_kmh: customSpeedKmh, speed_min_kmh: speedMinKmh, speed_max_kmh: speedMaxKmh }, undefined, straightLine)
        patchPrimaryRuntime({ state: 'flower' })
        setEffectiveSpeed({ mode: moveMode, kmh: customSpeedKmh, min: speedMinKmh, max: speedMaxKmh })
        return res
      } catch (err) {
        _setMode(prevMode)
        setLapProgress(null)
        throw err
      }
    },
    [moveMode, customSpeedKmh, speedMinKmh, speedMaxKmh, straightLine, patchPrimaryRuntime],
  )

  const joystickStart = useCallback(async () => {
    setError(null)
    const prevMode = modeRef.current
    _setMode(SimMode.Joystick)
    try {
      const res = await api.joystickStart(moveMode)
      patchPrimaryRuntime({ state: 'joystick' })
      return res
    } catch (err) {
      _setMode(prevMode)
      throw err
    }
  }, [moveMode, patchPrimaryRuntime])

  const joystickStop = useCallback(async () => {
    setError(null)
    const res = await api.joystickStop()
    // leave mode as-is; the derived status drives running state
    patchPrimaryRuntime({ state: 'idle' })
    return res
  }, [patchPrimaryRuntime])

  const pause = useCallback(async () => {
    setError(null)
    const res = await api.pauseSim()
    patchPrimaryRuntime({ state: 'paused' })
    return res
  }, [patchPrimaryRuntime])

  const resume = useCallback(async () => {
    setError(null)
    const res = await api.resumeSim()
    // Optimistically return to the active mode's state string. When the
    // mode tab doesn't map to a running state (e.g. the user switched to
    // Teleport while paused), skip the patch — the backend's
    // `state_change` lands moments later with the real state.
    const resumedState = modeToState(modeRef.current)
    if (resumedState) patchPrimaryRuntime({ state: resumedState })
    return res
  }, [patchPrimaryRuntime])

  const stop = useCallback(async () => {
    setError(null)
    const res = await api.stopSim()
    patchPrimaryRuntime({ state: 'idle', progress: 0, eta: null, routePath: [] })
    setWaypointProgress(null)
    // Clear the lap progress counter too — otherwise a stopped run
    // keeps showing "3 / 5" in the Loop / MultiStop panel until the
    // next `multi_stop_complete` / `random_walk_complete` WS event
    // (which never arrives on a manual Stop in some edge cases).
    setLapProgress(null)
    setEffectiveSpeed(null)
    // Clear the destination so the red "target" marker goes away —
    // lingering destination pin after Stop was a reported UX bug.
    setDestination(null)
    return res
  }, [patchPrimaryRuntime])

  const restore = useCallback(async () => {
    setError(null)
    const res = await api.restoreSim()
    // leave mode as-is; the derived status drives running state
    patchPrimaryRuntime({
      state: 'idle',
      currentPos: null,
      destination: null,
      routePath: [],
      progress: 0,
      eta: null,
      distanceRemaining: 0,
      distanceTraveled: 0,
      waypointIndex: null,
    })
    setStatusSpeed(0)
    setBackendPositionSynced(false)
    setDestination(null)
    setWaypoints([])
    setWaypointProgress(null)
    setLapProgress(null)
    setEffectiveSpeed(null)
    return res
  }, [patchPrimaryRuntime])

  const applySpeed = useCallback(async (sel?: SpeedSelection) => {
    setError(null)
    // An explicit selection wins over hook state so a caller can switch speed
    // and apply it in the same tick (the dock SpeedToggle) without hitting the
    // stale closure. Falls back to current state for the panel's Apply button.
    const s = sel ?? { moveMode, customSpeedKmh, speedMinKmh, speedMaxKmh }
    const res = await api.applySpeed(s.moveMode, {
      speed_kmh: s.customSpeedKmh,
      speed_min_kmh: s.speedMinKmh,
      speed_max_kmh: s.speedMaxKmh,
    })
    // Status bar should now reflect the just-applied values, not the
    // ones the route originally started with.
    setEffectiveSpeed({ mode: s.moveMode, kmh: s.customSpeedKmh, min: s.speedMinKmh, max: s.speedMaxKmh })
    return res
  }, [moveMode, customSpeedKmh, speedMinKmh, speedMaxKmh])

  // Fetch initial status on mount, and again whenever a WebSocket is
  // accepted (`connectEpoch`).
  //
  // Sequence (single async/await chain so failures and the secondary
  // last-position fetch share one top-level try/catch):
  //   1. getStatus() — primary source, also tells us whether the engine
  //      is currently pushing a live position.
  //   2. getLastDevicePosition() — fallback rehydration when the engine
  //      is idle on a fresh server restart. Skipped when (1) already
  //      delivered a live position.
  //
  // `aborted` guards every setState call so a late resolution after the
  // component unmounts is a no-op.
  //
  // Do NOT add a `useRef` "already fetched" guard here. Under dev StrictMode
  // (mount → unmount → mount) such a guard makes the FIRST mount claim the
  // one-shot, then its cleanup sets `aborted = true`, so when its fetch
  // resolves the setState is skipped — and the SECOND mount, seeing the guard
  // already set, never re-fetches. Net result: the persisted last position is
  // fetched but silently dropped, so the pin never appears on launch. Letting
  // the effect re-run per mount costs one extra read-only GET in dev (none in
  // prod) and the aborted first run is a harmless no-op.
  useEffect(() => {
    let aborted = false

    const run = async () => {
      // Issue both fetches in parallel: getStatus() is authoritative when
      // the engine is live; getLastDevicePosition() is the persisted
      // fallback used only when status has no live position. Sequential
      // awaits would cost an extra RTT on every cold mount even though
      // the fallback is almost always discarded.
      const [statusRes, lastPosRes] = await Promise.allSettled([
        api.getStatus(),
        api.getLastDevicePosition(),
      ])
      if (aborted) return

      let hadLivePosition = false
      if (statusRes.status === 'fulfilled') {
        const res = statusRes.value
        if (res.position) {
          hadLivePosition = true
          patchPrimaryRuntime({ currentPos: { lat: res.position.lat, lng: res.position.lng } })
          setBackendPositionSynced(true)
        }
        if (res.mode) {
          const mapped = stateToMode(res.mode)
          if (mapped) _setMode(mapped)
        }
        if (res.running != null || res.paused != null) {
          setStatusSpeed(res.speed ?? 0)
          // Seed the runtime state so the derived running/paused flags
          // match the engine snapshot. Lands in the local slot before the
          // first udid-tagged frame; the slot is promoted into the real
          // udid entry when that frame arrives.
          patchPrimaryRuntime({
            state: !res.running ? 'idle' : res.paused ? 'paused' : (res.mode ?? 'navigating'),
          })
        }
      }
      // Rehydrate from persisted settings only when the live engine has
      // no position (fresh server restart). A real position_update from
      // the device supersedes this immediately after.
      if (!hadLivePosition && lastPosRes.status === 'fulfilled') {
        const { position } = lastPosRes.value
        if (position) {
          // Functional patch: keep an already-set position (mirrors the
          // old `prev ?? value` updater).
          patchPrimaryRuntime((cur) =>
            cur.currentPos ? {} : { currentPos: { lat: position.lat, lng: position.lng } })
        }
      }
    }

    void run()

    return () => {
      aborted = true
    }
    // patchPrimaryRuntime is a stable useCallback — listing it keeps the
    // deps honest without re-running the fetch; connectEpoch re-runs it.
  }, [patchPrimaryRuntime, connectEpoch])

  // ── Group-mode fan-out helpers ──────────────────────────────────────
  // Extracted to useSimGroupActions. Each takes an explicit list of udids
  // so the caller (App.tsx) decides which devices to target and returns a
  // FanoutOutcome for toast summarisation. The deps bundle hands over the
  // speed / pause / lap state the fan-outs read plus the setters restoreAll
  // patches after the fan-out.
  const {
    teleportAll, navigateAll, startLoopAll, multiStopAll, randomWalkAll,
    startFlowerAll, applySpeedAll, pauseAll, resumeAll, stopAll, restoreAll,
    joystickStartAll, joystickStopAll,
  } = useSimGroupActions({
    currentPosition,
    moveMode, customSpeedKmh, speedMinKmh, speedMaxKmh,
    straightLine,
    pauseLoop, pauseMultiStop, pauseRandomWalk,
    loopLapCount,
    setLapProgress,
    setRuntimes,
    setDestination,
    setWaypoints,
    setWaypointProgress,
    setEffectiveSpeed,
  })

  return {
    runtimes,
    primaryRuntime,
    anyRunning,
    teleportAll,
    navigateAll,
    startLoopAll,
    multiStopAll,
    randomWalkAll,
    startFlowerAll,
    applySpeedAll,
    pauseAll,
    resumeAll,
    stopAll,
    restoreAll,
    joystickStartAll,
    joystickStopAll,
    mode,
    setMode,
    loadRouteWaypoints,
    moveMode,
    setMoveMode,
    status,
    currentPosition,
    setCurrentPosition,
    backendPositionSynced,
    setBackendPositionSynced,
    destination,
    setDestination,
    progress,
    eta,
    waypoints,
    setWaypoints,
    routePath,
    customSpeedKmh,
    setCustomSpeedKmh,
    speedMinKmh,
    setSpeedMinKmh,
    speedMaxKmh,
    setSpeedMaxKmh,
    straightLine,
    setStraightLine,
    pauseMultiStop,
    setPauseMultiStop,
    pauseLoop,
    setPauseLoop,
    pauseRandomWalk,
    setPauseRandomWalk,
    pauseRemaining,
    ddiMounting,
    ddiMissing,
    waypointProgress,
    loopLapCount,
    setLoopLapCount,
    lapProgress,
    effectiveSpeed,
    applySpeed,
    error,
    clearError,
    clearDdiMounting,
    teleport,
    stop,
    navigate,
    startLoop,
    multiStop,
    randomWalk,
    startFlower,
    joystickStart,
    joystickStop,
    pause,
    resume,
    restore,
  }
}
