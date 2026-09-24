import React, { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSimulation, SimMode, MoveMode, flowerOpts, type SpeedSelection } from '../hooks/useSimulation'
import type { SimErrorCode } from '../hooks/useSimulation'
import { useJoystick } from '../hooks/useJoystick'
import * as api from '../services/api'
import {
  RANDOM_GEN_COUNT_MAX,
  RANDOM_GEN_COUNT_MIN,
  RANDOM_GEN_RADIUS_MAX_M,
  RANDOM_GEN_RADIUS_MIN_M,
  RESTORE_MIN_DISPLAY_MS,
  SPEED_MAP,
  MIN_WAYPOINTS_FOR_OPTIMIZE,
} from '../lib/constants'
import { devWarn } from '../lib/dev-log'
import { formatCoord } from '../lib/format'
import { clampLat, normalizeLng } from '../lib/geo'
import { FANOUT_MIN_DEVICES, runWithFanout, toastForFanout } from '../lib/sim-fanout'
import { generateRandomTour } from '../lib/waypoint_gen'
import { useDeviceContext } from './DeviceContext'
import { useToastContext } from './ToastContext'
import { useWebSocketContext } from './WebSocketContext'
import { useSimSettings } from './SimSettingsContext'
import { useT } from '../i18n'
import type { StringKey } from '../i18n'
import ConfirmDialog from '../components/ui/ConfirmDialog'

// Translator keys for hook-emitted error codes (`SimErrorCode`). Defined
// here so SimContext can hand `useSimulation` a code → localised string
// function without baking i18n knowledge into the hook itself.
const SIM_ERROR_KEYS: Record<SimErrorCode, StringKey> = {
  tunnel_lost: 'err.tunnel_lost',
}

// Re-export for consumers
export { SimMode, MoveMode }
export type { SpeedSelection }


// Re-export `SPEED_MAP` so existing consumers (`App.tsx`) keep importing
// it through `contexts/SimContext`. The canonical definition lives in
// `lib/constants.ts` next to `SPEED_PRESETS` so the two cannot drift.
export { SPEED_MAP }

// `useSimulation`'s return shape — the source the two context slices
// below are carved from. Using `Pick` keeps every field/function type
// identical to the hook's by construction.
type Sim = ReturnType<typeof useSimulation>

// ── Stable actions slice ───────────────────────────────────────────────
// Everything here is referentially stable for the lifetime of the
// provider: the handle* dispatchers read their inputs through a ref at
// call time, and the passthroughs are useState setters / []-dep
// useCallbacks from `useSimulation`. Consumers that only fire actions
// (buttons, menus, dialogs) subscribe here and never re-render on
// position ticks.
export interface SimActionsValue extends Pick<Sim,
  | 'setMode'
  | 'loadRouteWaypoints'
  | 'setWaypoints'
  | 'setMoveMode'
  | 'setCustomSpeedKmh'
  | 'setSpeedMinKmh'
  | 'setSpeedMaxKmh'
  | 'setLoopLapCount'
  | 'setPauseMultiStop'
  | 'clearError'
  | 'clearDdiMounting'
> {
  handleTeleport: (lat: number, lng: number) => void
  handleNavigate: (lat: number, lng: number) => void
  handleStart: () => void
  handleStop: () => void
  handlePause: () => void
  handleResume: () => void
  handleRestore: () => void
  handleApplySpeed: (sel?: SpeedSelection) => Promise<void>
  handleAddWaypoint: (lat: number, lng: number) => void
  handleClearWaypoints: () => void
  handleRemoveWaypoint: (index: number) => void
  handleGenerateRandomWaypoints: () => void
  handleOptimizeWaypoints: () => Promise<void>
  handleGenerateAllRandom: () => void
  handleOpenLog: () => void
  handleSetTeleportDest: (lat: number, lng: number) => void
  handleClearTeleportDest: () => void
  handleMapClick: (lat: number, lng: number) => void
}

// ── Ticking state slice ────────────────────────────────────────────────
// Live simulation data — updates at position-stream rate while a run is
// in flight. Consumers that render coordinates / progress / runtimes
// subscribe here; derived values (currentPos / displaySpeed / isRunning
// / isPaused) live one level down in `SimDerivedContext`.
export interface SimStateValue extends Pick<Sim,
  | 'mode'
  | 'moveMode'
  | 'status'
  | 'currentPosition'
  | 'backendPositionSynced'
  | 'destination'
  | 'progress'
  | 'eta'
  | 'waypoints'
  | 'routePath'
  | 'customSpeedKmh'
  | 'speedMinKmh'
  | 'speedMaxKmh'
  | 'runtimes'
  | 'pauseRemaining'
  | 'ddiMounting'
  | 'ddiMissing'
  | 'waypointProgress'
  | 'loopLapCount'
  | 'pauseMultiStop'
  | 'lapProgress'
  | 'effectiveSpeed'
  | 'error'
> {
  // From useJoystick — direction/intensity for the active joystick UI
  // (ticks while the pad is being driven) plus its stable input setter.
  joystick: ReturnType<typeof useJoystick>
}

const SimActionsContext = createContext<SimActionsValue | null>(null)
const SimStateContext = createContext<SimStateValue | null>(null)

interface SimProviderProps {
  children: React.ReactNode
}

export function SimProvider({ children }: SimProviderProps) {
  const t = useT()
  const device = useDeviceContext()
  const { showToast } = useToastContext()
  const { subscribe, sendMessage } = useWebSocketContext()
  // Stable translator: looks up the latest `t` via ref so the function
  // identity passed to `useSimulation` doesn't churn on every i18n
  // re-render and tear down the hook's WS subscriber.
  const tRef = useRef(t)
  useEffect(() => { tRef.current = t }, [t])
  const translateError = useCallback((code: SimErrorCode): string => {
    return tRef.current(SIM_ERROR_KEYS[code])
  }, [])
  // Same primary as DeviceContext so the map pin / dock / space-bar and
  // the device UI agree on which phone is primary.
  const primaryUdid = device.primaryDevice?.udid ?? null
  const sim = useSimulation(subscribe, { translateError, primaryUdid })

  // Settings live in `SimSettingsContext`. Handlers below pull values
  // from there; consumers that read settings directly should call
  // `useSimSettings()` not the sim contexts.
  const {
    randomWalkRadius,
    wpGenRadius,
    setWpGenRadius,
    wpGenCount,
    setWpGenCount,
    joystickSensitivity,
    autoJitter,
    flowerSettings,
  } = useSimSettings()

  // Sensitivity stepper is 1-5 with 3 = baseline 1.0×; the wire value is
  // level/3 so level 5 ≈ 1.67× and level 1 ≈ 0.33×.
  const joystick = useJoystick(
    (type, data) => sendMessage(type, { ...data }),
    sim.mode === SimMode.Joystick,
    joystickSensitivity / 3,
  )

  // ── Latest-value snapshot for the stable action handlers ───────────
  // Every handle* callback below reads its inputs through this ref at
  // call time instead of closing over them, so each handler's identity
  // is permanently stable and the actions context value never
  // invalidates — that's what stops position ticks from re-rendering
  // action-only consumers. User events always fire after the commit
  // effect has refreshed the ref, so call-time reads see exactly what a
  // per-render closure would have seen.
  const latest = useRef({
    sim,
    connectedDevices: device.connectedDevices,
    t,
    showToast,
    autoJitter,
    randomWalkRadius,
    wpGenRadius,
    wpGenCount,
    flowerSettings,
  })
  useEffect(() => {
    latest.current = {
      sim,
      connectedDevices: device.connectedDevices,
      t,
      showToast,
      autoJitter,
      randomWalkRadius,
      wpGenRadius,
      wpGenCount,
      flowerSettings,
    }
  })

  // ── Start-from-cached-position confirmation ────────────────────────
  // After a server restart the UI rehydrates the last-known position
  // purely for display; the backend engine is intentionally left idle
  // so it doesn't stomp on the phone's real GPS. The first movement
  // action (navigate / multi-stop / random-walk) therefore needs the
  // user's explicit consent before we teleport. `pendingSync` holds the
  // action to resume once the user confirms; it's null when no prompt
  // is active. Using a ref for the callback keeps the promise resolver
  // stable across re-renders.
  const pendingSyncRef = useRef<{
    position: { lat: number; lng: number }
    resolve: (ok: boolean) => void
  } | null>(null)
  const [syncPrompt, setSyncPrompt] = useState<{
    position: { lat: number; lng: number }
  } | null>(null)

  // Returns a promise that resolves to true when the user gives consent
  // (backend is synced), false if they cancel. Resolves true immediately
  // when no prompt is needed.
  const confirmStartFromCached = useCallback(async (): Promise<boolean> => {
    const { sim, connectedDevices } = latest.current
    // Already synced this session (live position or a prior teleport) —
    // no prompt, no side effect.
    if (sim.backendPositionSynced) return true
    // No cached position to start from — let the action surface its
    // own "no position" error; prompting here wouldn't help.
    if (!sim.currentPosition) return true
    // Group mode (2+ devices) runs its own preSyncStart across all
    // engines. Prompting there would need a multi-device teleport path;
    // single-device is the only case this UX currently covers.
    const udids = connectedDevices.map((d) => d.udid)
    if (udids.length >= FANOUT_MIN_DEVICES) return true

    const position = { lat: sim.currentPosition.lat, lng: sim.currentPosition.lng }
    return new Promise<boolean>((resolve) => {
      pendingSyncRef.current = { position, resolve }
      setSyncPrompt({ position })
    })
  }, [])

  const handleSyncConfirm = useCallback(async () => {
    const pending = pendingSyncRef.current
    if (!pending) return
    const { sim, t, showToast } = latest.current
    try {
      await sim.teleport(pending.position.lat, pending.position.lng)
      pending.resolve(true)
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : t('err.no_position'))
      pending.resolve(false)
    } finally {
      pendingSyncRef.current = null
      setSyncPrompt(null)
    }
  }, [])

  const handleSyncCancel = useCallback(() => {
    const pending = pendingSyncRef.current
    if (pending) pending.resolve(false)
    pendingSyncRef.current = null
    setSyncPrompt(null)
  }, [])
  // Log DDI mount failures for diagnostics. The user-facing surface is now
  // App's persistent, dismissible DdiFailedBanner (a transient toast got
  // overwritten by unrelated toasts before the user could read it). `ts`
  // dedupes repeat failures across re-renders.
  const lastDdiMissingTs = React.useRef<number>(0)
  useEffect(() => {
    const m = sim.ddiMissing
    if (!m) return
    if (m.ts === lastDdiMissingTs.current) return
    lastDdiMissingTs.current = m.ts
    devWarn('[ddi_mount_failed]', m.stage ?? '?', m.reason)
  }, [sim.ddiMissing])

  // --- Handlers ---
  // All read live state through `latest` (see above) so their useCallback
  // deps are [] or other stable handlers — never ticking values.

  const handleRestore = useCallback(async () => {
    const { sim, connectedDevices, t, showToast } = latest.current
    showToast(t('status.restore_in_progress'), 10000)
    const startedAt = Date.now()
    try {
      const udids = connectedDevices.map((d) => d.udid)
      if (udids.length >= FANOUT_MIN_DEVICES) {
        const outcome = await sim.restoreAll(udids)
        if (outcome.failed.length > 0 && outcome.ok.length === 0) {
          throw new Error(outcome.failed[0]?.reason ?? 'restore failed')
        }
      } else {
        await sim.restore()
      }
      const elapsed = Date.now() - startedAt
      if (elapsed < RESTORE_MIN_DISPLAY_MS) {
        await new Promise((r) => setTimeout(r, RESTORE_MIN_DISPLAY_MS - elapsed))
      }
      showToast(t('status.restore_success_wait'))
    } catch {
      showToast(t('status.restore_failed'))
    }
  }, [])

  const generateWaypoints = useCallback((radius: number, count: number) => {
    const { sim, t, showToast } = latest.current
    if (!sim.currentPosition) {
      showToast(t('toast.no_position_random'))
      return
    }
    sim.setWaypoints(generateRandomTour(sim.currentPosition, radius, count))
  }, [])

  const handleGenerateRandomWaypoints = useCallback(() => {
    const { wpGenRadius, wpGenCount } = latest.current
    generateWaypoints(wpGenRadius, wpGenCount)
  }, [generateWaypoints])

  const handleGenerateAllRandom = useCallback(() => {
    // Inclusive on both ends — `+ 1` widens the open upper bound so MAX is
    // reachable. See constants for the numeric bounds.
    const radius = Math.floor(
      RANDOM_GEN_RADIUS_MIN_M + Math.random() * (RANDOM_GEN_RADIUS_MAX_M - RANDOM_GEN_RADIUS_MIN_M + 1),
    )
    const count = Math.floor(
      RANDOM_GEN_COUNT_MIN + Math.random() * (RANDOM_GEN_COUNT_MAX - RANDOM_GEN_COUNT_MIN + 1),
    )
    setWpGenRadius(radius)
    setWpGenCount(count)
    generateWaypoints(radius, count)
  }, [generateWaypoints, setWpGenRadius, setWpGenCount])

  // Reorder the staged waypoints to minimise travel time (backend
  // /api/route/optimize: OSRM duration matrix + nearest-neighbor + 2-opt).
  // Loop mode optimises the round trip back to the first point. Only the
  // staged points change — a saved route keeps its stored order, so
  // reloading it undoes an unwanted optimisation.
  const handleOptimizeWaypoints = useCallback(async () => {
    const { sim, t, showToast } = latest.current
    if (sim.waypoints.length < MIN_WAYPOINTS_FOR_OPTIMIZE) return
    try {
      const res = await api.optimizeRoute(
        sim.waypoints, sim.moveMode, sim.mode === SimMode.Loop,
      )
      const isUnchanged = res.order.every((v, i) => v === i)
      if (isUnchanged) {
        showToast(t('toast.route_order_already_optimal'))
        return
      }
      sim.setWaypoints(res.waypoints)
      showToast(t('toast.route_order_optimized'))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      showToast(t('toast.route_optimize_failed', { msg: message }))
    }
  }, [])

  const handleMapClick = useCallback((lat: number, lng: number) => {
    const { sim } = latest.current
    const nlat = clampLat(lat)
    const nlng = normalizeLng(lng)

    switch (sim.mode) {
      case SimMode.Teleport:
      case SimMode.Navigate:
        sim.setDestination({ lat: nlat, lng: nlng })
        break
      case SimMode.Loop:
      case SimMode.MultiStop:
      case SimMode.Flower:
        sim.setWaypoints((prev) => {
          if (prev.length === 0 && sim.currentPosition) {
            return [
              { lat: sim.currentPosition.lat, lng: sim.currentPosition.lng },
              { lat: nlat, lng: nlng },
            ]
          }
          return [...prev, { lat: nlat, lng: nlng }]
        })
        break
      // RandomWalk / Joystick: no map-click action
    }
  }, [])

  const handleSetTeleportDest = useCallback((latIn: number, lngIn: number) => {
    const lat = clampLat(latIn)
    const lng = normalizeLng(lngIn)
    latest.current.sim.setDestination({ lat, lng })
  }, [])

  const handleClearTeleportDest = useCallback(() => {
    latest.current.sim.setDestination(null)
  }, [])

  const handleTeleport = useCallback(async (latIn: number, lngIn: number) => {
    const { sim, connectedDevices, t, showToast, autoJitter } = latest.current
    const lat = clampLat(latIn)
    const lng = normalizeLng(lngIn)
    const udids = connectedDevices.map((d) => d.udid)
    try {
      await runWithFanout({
        udids,
        devices: connectedDevices,
        action: t('mode.teleport'),
        single: () => sim.teleport(lat, lng, autoJitter),
        multi: (us) => {
          // Optimistic write — only on the multi path, where `teleport`
          // doesn't update currentPosition itself the way the single
          // path does. Lives in the multi thunk so it only runs when
          // the multi branch is taken.
          sim.setCurrentPosition({ lat, lng })
          return sim.teleportAll(us, lat, lng)
        },
        t,
        showToast,
      })
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : t('err.teleport_failed'))
    }
  }, [])

  const handleNavigate = useCallback(async (latIn: number, lngIn: number) => {
    const { sim, connectedDevices, t, showToast } = latest.current
    const lat = clampLat(latIn)
    const lng = normalizeLng(lngIn)
    const udids = connectedDevices.map((d) => d.udid)
    try {
      await runWithFanout({
        udids,
        devices: connectedDevices,
        action: t('mode.navigate'),
        // Single-device path is gated on `confirmStartFromCached` so
        // the user has to consent before we teleport from a cached
        // position. The multi path runs its own preSyncStart inside
        // `navigateAll`, so the gate is single-only.
        single: async () => {
          if (!(await confirmStartFromCached())) return
          await sim.navigate(lat, lng)
        },
        multi: (us) => sim.navigateAll(us, lat, lng),
        t,
        showToast,
      })
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : t('err.no_position'))
    }
  }, [confirmStartFromCached])

  const handleAddWaypoint = useCallback((lat: number, lng: number) => {
    const { sim } = latest.current
    const nlat = clampLat(lat)
    const nlng = normalizeLng(lng)
    sim.setWaypoints((prev) => {
      if (prev.length === 0 && sim.currentPosition) {
        return [
          { lat: sim.currentPosition.lat, lng: sim.currentPosition.lng },
          { lat: nlat, lng: nlng },
        ]
      }
      return [...prev, { lat: nlat, lng: nlng }]
    })
  }, [])

  const handleClearWaypoints = useCallback(() => {
    latest.current.sim.setWaypoints([])
  }, [])

  const handleRemoveWaypoint = useCallback((index: number) => {
    latest.current.sim.setWaypoints((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const handleStartWaypointRoute = useCallback(async () => {
    const { sim, connectedDevices, t, showToast, flowerSettings } = latest.current
    const route = sim.waypoints
    // Flower circles every staged point, so one spot is enough; the
    // path modes need a leg.
    const minPoints = sim.mode === SimMode.Flower ? 1 : 2
    if (route.length < minPoints) {
      showToast(t('toast.no_waypoints'))
      return
    }
    const udids = connectedDevices.map((d) => d.udid)
    try {
      if (sim.mode === SimMode.Loop) {
        await runWithFanout({
          udids,
          devices: connectedDevices,
          action: t('mode.loop'),
          single: () => sim.startLoop(route),
          multi: (us) => sim.startLoopAll(us, route),
          t,
          showToast,
        })
      } else if (sim.mode === SimMode.MultiStop) {
        await runWithFanout({
          udids,
          devices: connectedDevices,
          action: t('mode.multi_stop'),
          // Single-device multi-stop is gated on the cached-position
          // confirm prompt; the multi path runs preSyncStart server-side.
          single: async () => {
            if (!(await confirmStartFromCached())) return
            await sim.multiStop(route, 0, false)
          },
          multi: (us) => sim.multiStopAll(us, route, 0, false),
          t,
          showToast,
        })
      } else if (sim.mode === SimMode.Flower) {
        const settings = flowerSettings
        await runWithFanout({
          udids,
          devices: connectedDevices,
          action: t('mode.flower'),
          // Walking to the first spot starts from the device position, so
          // a cached one needs the user's consent first. Teleport transfers
          // jump straight to the spot and don't depend on it.
          single: async () => {
            if (settings.transfer === 'walk' && !(await confirmStartFromCached())) return
            await sim.startFlower(route, settings)
          },
          multi: (us) => sim.startFlowerAll(us, route, flowerOpts(settings)),
          t,
          showToast,
        })
      }
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : t('toast.start_failed'))
    }
  }, [confirmStartFromCached])

  const handleStart = useCallback(async () => {
    const { sim, connectedDevices, t, showToast, randomWalkRadius } = latest.current
    const udids = connectedDevices.map((d) => d.udid)
    try {
      if (sim.mode === SimMode.Joystick) {
        await runWithFanout({
          udids,
          devices: connectedDevices,
          action: t('mode.joystick'),
          single: () => sim.joystickStart(),
          multi: (us) => sim.joystickStartAll(us),
          t,
          showToast,
        })
      } else if (sim.mode === SimMode.RandomWalk) {
        if (!sim.currentPosition) {
          showToast(t('toast.no_position_random'))
          return
        }
        const startPos = sim.currentPosition
        await runWithFanout({
          udids,
          devices: connectedDevices,
          action: t('mode.random_walk'),
          // Single-device path: gate on confirm, then re-read position
          // through `latest` (the confirm flow may have teleported to a
          // confirmed cached coord, so the live position may differ from
          // `startPos`).
          single: async () => {
            if (!(await confirmStartFromCached())) return
            const pos = latest.current.sim.currentPosition
            if (pos) await sim.randomWalk(pos, randomWalkRadius)
          },
          multi: (us) => sim.randomWalkAll(us, startPos, randomWalkRadius),
          t,
          showToast,
        })
      } else if (sim.mode === SimMode.Navigate) {
        const dest = sim.destination
        if (!dest) {
          showToast(t('toast.no_destination'))
          return
        }
        await runWithFanout({
          udids,
          devices: connectedDevices,
          action: t('mode.navigate'),
          single: async () => {
            if (!(await confirmStartFromCached())) return
            await sim.navigate(dest.lat, dest.lng)
          },
          multi: (us) => sim.navigateAll(us, dest.lat, dest.lng),
          t,
          showToast,
        })
      } else if (sim.mode === SimMode.Loop || sim.mode === SimMode.MultiStop || sim.mode === SimMode.Flower) {
        // `handleStartWaypointRoute` toasts its own failures; awaiting
        // here keeps the start button disabled-state consistent.
        await handleStartWaypointRoute()
      }
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : t('toast.start_failed'))
    }
  }, [handleStartWaypointRoute, confirmStartFromCached])

  const handleStop = useCallback(async () => {
    const { sim, connectedDevices, t, showToast } = latest.current
    const udids = connectedDevices.map((d) => d.udid)
    // Joystick fan-out has no single-device fallback in this handler
    // (single-device joystick stop happens via the joystick UI itself),
    // so it stays inline rather than going through `runWithFanout`.
    if (sim.mode === SimMode.Joystick && udids.length >= FANOUT_MIN_DEVICES) {
      const outcome = await sim.joystickStopAll(udids)
      showToast(toastForFanout(t, t('mode.joystick'), outcome, connectedDevices))
      return
    }
    await runWithFanout({
      udids,
      devices: connectedDevices,
      action: t('generic.stop'),
      single: () => sim.stop(),
      multi: (us) => sim.stopAll(us),
      t,
      showToast,
    })
  }, [])

  const handleApplySpeed = useCallback(async (sel?: SpeedSelection) => {
    const { sim, connectedDevices, t, showToast } = latest.current
    const udids = connectedDevices.map((d) => d.udid)
    try {
      await runWithFanout({
        udids,
        devices: connectedDevices,
        action: t('panel.apply_speed_success'),
        // Single-device path needs an explicit success toast — the multi
        // path gets one through toastForFanout, single does not.
        single: async () => {
          await sim.applySpeed(sel)
          showToast(t('panel.apply_speed_success'))
        },
        multi: (us) => sim.applySpeedAll(us, sel),
        t,
        showToast,
      })
    } catch (err: unknown) {
      showToast(t('panel.apply_speed_failed') + (err instanceof Error ? `: ${err.message}` : ''))
    }
  }, [])

  const handlePause = useCallback(async () => {
    const { sim, connectedDevices, t, showToast } = latest.current
    const udids = connectedDevices.map((d) => d.udid)
    await runWithFanout({
      udids,
      devices: connectedDevices,
      action: t('generic.pause'),
      single: () => sim.pause(),
      multi: (us) => sim.pauseAll(us),
      t,
      showToast,
    })
  }, [])

  const handleResume = useCallback(async () => {
    const { sim, connectedDevices, t, showToast } = latest.current
    const udids = connectedDevices.map((d) => d.udid)
    await runWithFanout({
      udids,
      devices: connectedDevices,
      action: t('generic.resume'),
      single: () => sim.resume(),
      multi: (us) => sim.resumeAll(us),
      t,
      showToast,
    })
  }, [])

  const handleOpenLog = useCallback(async () => {
    const { t, showToast } = latest.current
    try {
      await api.openLogFolder()
    } catch (err: unknown) {
      showToast(t('status.open_log_failed') + (err instanceof Error ? `: ${err.message}` : ''))
    }
  }, [])

  // Stable actions value — every dep here is a []-dep useCallback above
  // or a stable function from useSimulation (state setters / []-dep
  // callbacks), so this memo computes once and never invalidates.
  const actions = useMemo<SimActionsValue>(() => ({
    handleSetTeleportDest,
    handleClearTeleportDest,
    handleTeleport,
    handleNavigate,
    handleStart,
    handleStop,
    handlePause,
    handleResume,
    handleRestore,
    handleApplySpeed,
    handleAddWaypoint,
    handleClearWaypoints,
    handleRemoveWaypoint,
    handleGenerateRandomWaypoints,
    handleOptimizeWaypoints,
    handleGenerateAllRandom,
    handleOpenLog,
    handleMapClick,
    setMode: sim.setMode,
    loadRouteWaypoints: sim.loadRouteWaypoints,
    setWaypoints: sim.setWaypoints,
    setMoveMode: sim.setMoveMode,
    setCustomSpeedKmh: sim.setCustomSpeedKmh,
    setSpeedMinKmh: sim.setSpeedMinKmh,
    setSpeedMaxKmh: sim.setSpeedMaxKmh,
    setLoopLapCount: sim.setLoopLapCount,
    setPauseMultiStop: sim.setPauseMultiStop,
    clearError: sim.clearError,
    clearDdiMounting: sim.clearDdiMounting,
  }), [
    handleSetTeleportDest,
    handleClearTeleportDest,
    handleTeleport,
    handleNavigate,
    handleStart,
    handleStop,
    handlePause,
    handleResume,
    handleRestore,
    handleApplySpeed,
    handleAddWaypoint,
    handleClearWaypoints,
    handleRemoveWaypoint,
    handleGenerateRandomWaypoints,
    handleOptimizeWaypoints,
    handleGenerateAllRandom,
    handleOpenLog,
    handleMapClick,
    sim.setMode,
    sim.loadRouteWaypoints,
    sim.setWaypoints,
    sim.setMoveMode,
    sim.setCustomSpeedKmh,
    sim.setSpeedMinKmh,
    sim.setSpeedMaxKmh,
    sim.setLoopLapCount,
    sim.setPauseMultiStop,
    sim.clearError,
    sim.clearDdiMounting,
  ])

  // Ticking state value — invalidates whenever any live field changes
  // (position-stream rate while running). Deps are the individual fields
  // rather than `sim` itself so unrelated provider re-renders (toast,
  // sync prompt, i18n) don't fan out to state consumers.
  const state = useMemo<SimStateValue>(() => ({
    mode: sim.mode,
    moveMode: sim.moveMode,
    status: sim.status,
    currentPosition: sim.currentPosition,
    backendPositionSynced: sim.backendPositionSynced,
    destination: sim.destination,
    progress: sim.progress,
    eta: sim.eta,
    waypoints: sim.waypoints,
    routePath: sim.routePath,
    customSpeedKmh: sim.customSpeedKmh,
    speedMinKmh: sim.speedMinKmh,
    speedMaxKmh: sim.speedMaxKmh,
    runtimes: sim.runtimes,
    pauseRemaining: sim.pauseRemaining,
    ddiMounting: sim.ddiMounting,
    ddiMissing: sim.ddiMissing,
    waypointProgress: sim.waypointProgress,
    loopLapCount: sim.loopLapCount,
    pauseMultiStop: sim.pauseMultiStop,
    lapProgress: sim.lapProgress,
    effectiveSpeed: sim.effectiveSpeed,
    error: sim.error,
    joystick,
  }), [
    sim.mode,
    sim.moveMode,
    sim.status,
    sim.currentPosition,
    sim.backendPositionSynced,
    sim.destination,
    sim.progress,
    sim.eta,
    sim.waypoints,
    sim.routePath,
    sim.customSpeedKmh,
    sim.speedMinKmh,
    sim.speedMaxKmh,
    sim.runtimes,
    sim.pauseRemaining,
    sim.ddiMounting,
    sim.ddiMissing,
    sim.waypointProgress,
    sim.loopLapCount,
    sim.pauseMultiStop,
    sim.lapProgress,
    sim.effectiveSpeed,
    sim.error,
    joystick.direction,
    joystick.intensity,
    joystick.updateFromPad,
  ])

  return (
    <SimActionsContext.Provider value={actions}>
      <SimStateContext.Provider value={state}>
        {children}
        <ConfirmDialog
          open={syncPrompt != null}
          title={t('sync.confirm.title')}
          description={syncPrompt ? t('sync.confirm.body', {
            coord: formatCoord(syncPrompt.position, 5),
          }) : ''}
          confirmLabel={t('sync.confirm.ok')}
          cancelLabel={t('sync.confirm.cancel')}
          onConfirm={handleSyncConfirm}
          onCancel={handleSyncCancel}
        />
      </SimStateContext.Provider>
    </SimActionsContext.Provider>
  )
}

export function useSimActions(): SimActionsValue {
  const ctx = useContext(SimActionsContext)
  if (!ctx) throw new Error('useSimActions must be used within SimProvider')
  return ctx
}

export function useSimState(): SimStateValue {
  const ctx = useContext(SimStateContext)
  if (!ctx) throw new Error('useSimState must be used within SimProvider')
  return ctx
}
