/**
 * Shared simulation-state derivation helpers.
 *
 * `SimContext` and `SimDerivedContext` both need to derive `currentPos`,
 * `destPos`, and `displaySpeed` from the live `useSimulation()` snapshot.
 * Keeping the formulae here means there is exactly one definition of
 * `formatDisplaySpeed` and the shape transformers, and both providers stay
 * in lockstep without one having to re-import from the other.
 */

import type { MoveMode } from '../hooks/useSimulation'
import { SPEED_MAP } from './constants'

export interface LatLng {
  lat: number
  lng: number
}

/**
 * Strip a (possibly richer) position-like object down to a plain
 * `{ lat, lng }` pair, or pass through `null`. Defined here so both
 * providers feed `useMemo` identical reference-stable transforms.
 */
export function toLatLng(p: LatLng | null | undefined): LatLng | null {
  return p ? { lat: p.lat, lng: p.lng } : null
}

/**
 * Numeric km/h when a single value is set, "min~max" range string when both
 * range bounds are set, or the default speed implied by `moveMode` when the
 * caller has no overrides. This is the function that used to be a local
 * `fmt` closure inside both providers.
 */
function formatDisplaySpeed(
  kmh: number | null,
  lo: number | null,
  hi: number | null,
  moveMode: MoveMode,
): number | string {
  if (lo != null && hi != null) {
    return `${Math.min(lo, hi)}~${Math.max(lo, hi)}`
  }
  if (kmh != null) return kmh
  return SPEED_MAP[moveMode] ?? SPEED_MAP.walking
}

/** Inputs `pickDisplaySpeed` consumes from a `useSimulation()` snapshot. */
export interface DisplaySpeedInputs {
  running: boolean
  moveMode: MoveMode
  effectiveSpeed: { kmh: number | null; min: number | null; max: number | null } | null
  customSpeedKmh: number | null
  speedMinKmh: number | null
  speedMaxKmh: number | null
}

/**
 * Pick the right speed source: the engine-reported `effectiveSpeed` while a
 * route is running, otherwise the user-staged custom/range/preset values.
 */
export function pickDisplaySpeed(s: DisplaySpeedInputs): number | string {
  return s.running && s.effectiveSpeed
    ? formatDisplaySpeed(
        s.effectiveSpeed.kmh,
        s.effectiveSpeed.min,
        s.effectiveSpeed.max,
        s.moveMode,
      )
    : formatDisplaySpeed(s.customSpeedKmh, s.speedMinKmh, s.speedMaxKmh, s.moveMode)
}

/** The user-staged speed preferences a run is started with. */
export interface SpeedPrefs {
  moveMode: string
  customSpeedKmh: number | null
  speedMinKmh: number | null
  speedMaxKmh: number | null
}

/**
 * The km/h a run started with these preferences will move at, for ETA and
 * distance estimates. Mirrors the backend's `resolve_speed_profile`
 * (backend/config.py): range > fixed custom > mode preset. A range is
 * sampled uniformly per leg there, so the estimate uses its midpoint, with
 * the same 0.1 km/h floor on the low end; a custom speed of 0 falls
 * through to the preset like the backend's truthiness check.
 */
export function resolveEffectiveKmh(p: SpeedPrefs): number {
  if (p.speedMinKmh != null && p.speedMaxKmh != null) {
    let lo = Math.min(p.speedMinKmh, p.speedMaxKmh)
    const hi = Math.max(p.speedMinKmh, p.speedMaxKmh)
    if (lo <= 0) lo = 0.1
    return (lo + hi) / 2
  }
  if (p.customSpeedKmh) return p.customSpeedKmh
  return SPEED_MAP[p.moveMode as MoveMode] ?? SPEED_MAP.walking
}
