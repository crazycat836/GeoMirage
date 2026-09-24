// Shared display-formatting helpers. Precision is a parameter so each
// call site keeps the exact output it had before these were extracted.

import type { StringKey } from '../i18n'

interface LatLng {
  lat: number
  lng: number
}

export const KM_THRESHOLD_M = 1000

/** "25.033000, 121.565400" — plain comma-joined pair. */
export function formatCoord(c: LatLng, precision = 6): string {
  return `${c.lat.toFixed(precision)}, ${c.lng.toFixed(precision)}`
}

/** "25.03300°N · 121.56540°E" — dock/waypoint cardinal style. */
export function formatCoordCardinal(c: LatLng, precision = 5): string {
  return `${c.lat.toFixed(precision)}°N · ${c.lng.toFixed(precision)}°E`
}

/** "25.033000°, 121.565400°" — degree-suffixed list-row style. */
export function formatCoordDegrees(c: LatLng, precision = 6): string {
  return `${c.lat.toFixed(precision)}°, ${c.lng.toFixed(precision)}°`
}

/** Compact "lat,lng" signature for memo/marker identity keys. */
export function coordKey(c: LatLng, precision = 7): string {
  return `${c.lat.toFixed(precision)},${c.lng.toFixed(precision)}`
}

/** "999 m" below the km threshold, "1.23 km" above it. */
export function formatDistanceM(m: number, kmPrecision: 1 | 2 = 2): string {
  if (m >= KM_THRESHOLD_M) return `${(m / KM_THRESHOLD_M).toFixed(kmPrecision)} km`
  return `${Math.round(m)} m`
}

type Translate = (key: StringKey, vars?: Record<string, string | number>) => string

/** Whole minutes as "< 1 min" / "12 min" / "2 h" / "1 h 5 m" (localised). */
function formatMinutes(mins: number, t: Translate): string {
  if (mins < 1) return t('unit.lt_1_min')
  if (mins < 60) return t('unit.min', { n: mins })
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m === 0 ? t('unit.h', { n: h }) : t('unit.h_min', { h, m })
}

/** Coarse duration for estimates: "< 1 min", "12 min", "1 h 5 m". */
export function formatDurationS(totalSeconds: number, t: Translate): string {
  return formatMinutes(Math.round(totalSeconds / 60), t)
}

/** Cooldown length: seconds below a minute, then floored minutes / hours. */
export function formatCooldownS(secs: number, t: Translate): string {
  if (secs < 60) return t('unit.s', { n: Math.max(0, secs) })
  return formatMinutes(Math.floor(secs / 60), t)
}

/** Cooldown countdown: "M:SS" under an hour, "H:MM:SS" from one hour up. */
export function formatCountdown(totalSeconds: number): string {
  const total = Math.round(totalSeconds)
  const hrs = Math.floor(total / 3600)
  const mins = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const pad = (n: number) => n.toString().padStart(2, '0')
  return hrs > 0 ? `${hrs}:${pad(mins)}:${pad(secs)}` : `${mins}:${pad(secs)}`
}
