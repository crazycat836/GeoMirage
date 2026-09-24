/** Device slot labels and colors for dual-device mode (max 2). */
export const DEVICE_LETTERS = ['A', 'B'] as const
export const DEVICE_COLORS = ['var(--color-device-a)', 'var(--color-device-b)'] as const

/**
 * Raw hex values for contexts that cannot use CSS variables
 * (e.g., Leaflet map markers, SVG inline attributes).
 *
 * These mirror the `--color-*` tokens in `styles/tokens.css`.
 * Keep the two in sync — see DESIGN.md §2 for the canonical names.
 */
export const DEVICE_COLORS_HEX = ['#4285f4', '#ff9800'] as const

/** Waypoint marker palette — mirrors `--color-marker-*` in tokens.css. */
export const MARKER_HEX = {
  start: '#43a047',
  startInner: '#2e7d32',
  end: '#fb8c00',
  endInner: '#ef6c00',
} as const

/** Primary accent — mirrors `--color-accent`. Used for Leaflet polyline
 *  strokes that bypass CSS. */
export const ACCENT_HEX = '#a78bfa'

export type DeviceLetter = (typeof DEVICE_LETTERS)[number]

/**
 * Network defaults — no imports to avoid circular dependency chains.
 *
 * `API_HOST` accepts a build-time override via `VITE_API_HOST` so dev
 * builds against a remote backend (LAN tunnel, Docker host, etc.) don't
 * have to fork the source. `API_BASE` and `WS_BASE` are derived, so a
 * single override covers both transports.
 */
const API_HOST = import.meta.env.VITE_API_HOST ?? '127.0.0.1:8777'
export const API_BASE = `http://${API_HOST}`
export const WS_BASE = `ws://${API_HOST}/ws/status`
export const DEFAULT_TUNNEL_PORT = 49152

/** Simulation defaults. */
export const DEFAULT_PAUSE = { enabled: true, min: 5, max: 20 } as const
export const DEFAULT_RANDOM_WALK_RADIUS = 500
// Fewer staged points than this and there is no order to optimise.
export const MIN_WAYPOINTS_FOR_OPTIMIZE = 3
export const DEFAULT_WP_GEN_RADIUS = 300
export const DEFAULT_WP_GEN_COUNT = 5

/** Random-walk radius preset rail (metres). Shared by BottomDock and RandomWalkPanel. */
export const RADIUS_PRESETS = [200, 500, 1000, 2000] as const

/**
 * Move-mode speed presets — the single source of truth for Walk/Run/Drive
 * km/h values. Shared by `SpeedControls`, `SpeedToggle`, and `SimContext`.
 *
 * `mode` strings match `MoveMode` enum values in `hooks/useSimulation.ts`
 * exactly (kept as literals here to avoid a circular import).
 *
 * Backend `SPEED_PROFILES` (m/s equivalents 3.0 / 5.5 / 16.667) must mirror
 * these values — retuned 2026-04.
 */
export const SPEED_PRESETS = [
  { mode: 'walking', kmh: 10.8 },
  { mode: 'running', kmh: 19.8 },
  { mode: 'driving', kmh: 60 },
] as const

export type SpeedPresetMode = (typeof SPEED_PRESETS)[number]['mode']

export const SPEED_MAP = Object.fromEntries(
  SPEED_PRESETS.map((p) => [p.mode, p.kmh]),
) as Record<SpeedPresetMode, number>

/**
 * True when the active mode + custom/range overrides line up with one of
 * the canonical Walk/Run/Drive presets. Pulled out so the predicate has
 * one definition shared by `SpeedControls` (panel chips), `SpeedPresets`
 * (joystick chips), and `SpeedToggle` (dock chips).
 *
 * `preset` and `sim.moveMode` are typed as `string` rather than
 * `SpeedPresetMode` / `MoveMode` so callers can pass the enum directly
 * without a cast — the values are structurally identical at runtime.
 */
export function isSpeedPresetActive(
  preset: string,
  sim: {
    moveMode: string
    customSpeedKmh: number | null
    speedMinKmh: number | null
    speedMaxKmh: number | null
  },
): boolean {
  return (
    sim.moveMode === preset
    && sim.customSpeedKmh == null
    && sim.speedMinKmh == null
    && sim.speedMaxKmh == null
  )
}

const COOLDOWN_TABLE: readonly [number, number][] = [
  [1, 0], [5, 30], [10, 120], [25, 300], [100, 900],
  [250, 1500], [500, 2700], [750, 3600], [1000, 5400], [Infinity, 7200],
]

export function cooldownForDistM(distM: number): number {
  const km = distM / 1000
  for (const [maxKm, secs] of COOLDOWN_TABLE) {
    if (km <= maxKm) return secs
  }
  return 7200
}

/**
 * Bounds for the "all random" waypoint generator. Both the radius (metres)
 * and the count are inclusive on both ends — `handleGenerateAllRandom`
 * picks an integer in `[MIN, MAX]` for each.
 */
export const RANDOM_GEN_RADIUS_MIN_M = 50
export const RANDOM_GEN_RADIUS_MAX_M = 1000
export const RANDOM_GEN_COUNT_MIN = 3
export const RANDOM_GEN_COUNT_MAX = 10

/**
 * Retry backoff for `fetchWithRetry` in `services/api.ts`.
 * Used only when the connection itself fails (e.g. backend not yet up).
 * Schedule per attempt `i`: min(INITIAL + i * STEP, MAX).
 */
export const RETRY_BACKOFF_INITIAL_MS = 500
export const RETRY_BACKOFF_STEP_MS = 300
export const RETRY_BACKOFF_MAX_MS = 2000

/**
 * Hard ceiling for a single fetch attempt in `services/api.ts`. Converts a
 * backend that accepts the TCP socket but never answers (deadlocked engine,
 * half-open WiFi tunnel) from an *infinite* hang into a bounded failure.
 *
 * Deliberately longer than the backend's own worst-case internal timeout
 * (the ~120 s cold personalized-DDI mount on first connect), so a
 * legitimately-slow request is never aborted client-side — only a truly
 * wedged backend trips it. A timed-out attempt is NOT retried: the request
 * may be a non-idempotent POST (teleport/connect/save) the backend already
 * received and is merely slow to acknowledge.
 */
export const REQUEST_TIMEOUT_MS = 130_000

/**
 * Retry policy for user-initiated reads that should report "backend not
 * ready" quickly (manual device scan): 3 attempts (~1.3 s of backoff when
 * the port refuses) and a 15 s per-attempt cap for a backend that accepts
 * but never answers. /api/device/list does one lockdown query per device,
 * which takes seconds, not tens of seconds.
 */
export const FAST_FAIL_REQUEST = { maxAttempts: 3, timeoutMs: 15_000 } as const

/**
 * Minimum on-screen time for the "Clearing virtual location…" toast in
 * `SimContext.handleRestore`. Restore can complete in <100ms on a healthy
 * USB link; the user wouldn't see the toast at all otherwise.
 */
export const RESTORE_MIN_DISPLAY_MS = 1200

/**
 * Settle delay between the group-mode pre-sync teleport fan-out and the
 * follow-up action (navigate / loop / etc.). Lets each engine finalise the
 * teleport before the next command arrives. See `useSimulation.preSyncStart`.
 */
export const PRE_SYNC_SETTLE_MS = 150

/**
 * Visible filter chips (route categories / bookmark places) before the
 * bar collapses into a "+N" / "More" overflow. Shared so the two library
 * drawers feel the same.
 */
export const LIBRARY_CHIPS_VISIBLE_CAP = 5
