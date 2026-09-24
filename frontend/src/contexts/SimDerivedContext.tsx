import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useSimState, type SimStateValue } from './SimContext'
import { pickDisplaySpeed, toLatLng } from '../lib/sim-derive'

// A focused slice of sim state for read-only consumers (route cards,
// pause-resume pill, action gating). Derived from `SimStateContext` so
// every formula lives in `lib/sim-derive.ts` exactly once.
export interface SimDerivedContextValue {
  currentPos: { lat: number; lng: number } | null
  destPos: { lat: number; lng: number } | null
  // numeric km/h when single, "min~max" range string when bounded
  displaySpeed: number | string
  isRunning: boolean
  isPaused: boolean
}

const SimDerivedContext = createContext<SimDerivedContextValue | null>(null)

// The sim state the app shell needs, minus everything that changes on a
// position tick (position, progress, ETA, runtimes). The value only changes
// when the user switches mode, edits the route, starts / pauses / stops a
// run, a DDI mount starts or ends, or a device's tunnel degrades or
// recovers. AppShell and the popovers it renders read this instead of
// `useSimState()` so a running simulation doesn't re-render the whole tree.
export interface SimOverviewValue {
  mode: SimStateValue['mode']
  waypoints: SimStateValue['waypoints']
  isRunning: boolean
  isPaused: boolean
  ddiMounting: SimStateValue['ddiMounting']
  /** Udids whose tunnel is mid-reconnect (`runtime.tunnelDegraded`). */
  tunnelDegradedUdids: readonly string[]
}

const SimOverviewContext = createContext<SimOverviewValue | null>(null)

interface SimDerivedProviderProps {
  children: ReactNode
}

export function SimDerivedProvider({ children }: SimDerivedProviderProps) {
  const sim = useSimState()

  // Derivations live in `lib/sim-derive.ts` so this provider and
  // `SimContext` agree on every formula (toLatLng, pickDisplaySpeed) by
  // construction. No more "must stay in sync" comments.
  const currentPos = useMemo(
    () => toLatLng(sim.currentPosition),
    [sim.currentPosition?.lat, sim.currentPosition?.lng],
  )

  const destPos = useMemo(
    () => toLatLng(sim.destination),
    [sim.destination?.lat, sim.destination?.lng],
  )

  const isRunning = sim.status.running
  const isPaused = sim.status.paused

  const displaySpeed: number | string = useMemo(
    () => pickDisplaySpeed({
      running: sim.status.running,
      moveMode: sim.moveMode,
      effectiveSpeed: sim.effectiveSpeed,
      customSpeedKmh: sim.customSpeedKmh,
      speedMinKmh: sim.speedMinKmh,
      speedMaxKmh: sim.speedMaxKmh,
    }),
    [
      sim.status.running,
      sim.moveMode,
      sim.effectiveSpeed?.kmh,
      sim.effectiveSpeed?.min,
      sim.effectiveSpeed?.max,
      sim.customSpeedKmh,
      sim.speedMinKmh,
      sim.speedMaxKmh,
    ],
  )

  const value = useMemo<SimDerivedContextValue>(
    () => ({ currentPos, destPos, displaySpeed, isRunning, isPaused }),
    [currentPos, destPos, displaySpeed, isRunning, isPaused],
  )

  // Keyed by a joined string so a tick that rebuilds `runtimes` without
  // changing who is degraded keeps the same array (and overview value).
  const degradedKey = Object.values(sim.runtimes)
    .filter((r) => r.tunnelDegraded)
    .map((r) => r.udid)
    .sort()
    .join('\n')
  const tunnelDegradedUdids = useMemo(
    () => (degradedKey ? degradedKey.split('\n') : []),
    [degradedKey],
  )

  const overview = useMemo<SimOverviewValue>(
    () => ({
      mode: sim.mode,
      waypoints: sim.waypoints,
      isRunning,
      isPaused,
      ddiMounting: sim.ddiMounting,
      tunnelDegradedUdids,
    }),
    [sim.mode, sim.waypoints, isRunning, isPaused, sim.ddiMounting, tunnelDegradedUdids],
  )

  return (
    <SimOverviewContext.Provider value={overview}>
      <SimDerivedContext.Provider value={value}>{children}</SimDerivedContext.Provider>
    </SimOverviewContext.Provider>
  )
}

export function useSimOverview(): SimOverviewValue {
  const ctx = useContext(SimOverviewContext)
  if (!ctx) throw new Error('useSimOverview must be used inside SimDerivedProvider')
  return ctx
}

export function useSimDerived(): SimDerivedContextValue {
  const ctx = useContext(SimDerivedContext)
  if (!ctx) throw new Error('useSimDerived must be used inside SimDerivedProvider')
  return ctx
}
