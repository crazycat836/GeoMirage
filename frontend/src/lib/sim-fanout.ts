// Group fan-out helpers shared by SimContext's action dispatchers.
// Pure functions — behavior is pinned by ./sim-fanout.test.ts.
import type { FanoutOutcome } from '../hooks/useSimulation'
import type { StringKey } from '../i18n'

// Summarise a group fan-out result into a single toast string.
export function toastForFanout<T>(
  t: (k: StringKey, v?: Record<string, string | number>) => string,
  action: string,
  outcome: FanoutOutcome<T>,
  devices: { udid: string }[],
): string {
  const total = outcome.ok.length + outcome.failed.length
  if (total === 0) return action
  if (outcome.failed.length === 0) return t('group.action_all_success', { action })
  if (outcome.ok.length === 0) return t('group.action_all_failed', { action })
  const statusFor = (udid: string) =>
    outcome.ok.some((o) => o.udid === udid) ? 'OK'
      : outcome.failed.find((f) => f.udid === udid)?.reason ?? 'error'
  return t('group.action_partial', {
    action,
    aStatus: devices[0] ? statusFor(devices[0].udid) : '-',
    bStatus: devices[1] ? statusFor(devices[1].udid) : '-',
  })
}

// Threshold at which a list of connected devices switches the action
// from "single device call" to "fan-out across all devices". Kept here
// (rather than as a magic `>= 2` in every handler) so the rule has one
// definition.
export const FANOUT_MIN_DEVICES = 2

// Most "do an action" handlers in SimContext share the same shape:
//   if 2+ devices → await sim.xAll(udids, …) → showToast(toastForFanout(…))
//   else          → sim.x(…)  (sometimes async, sometimes sync)
//
// `runWithFanout` collapses that branch into one call site. Callers
// supply the resolved udids/devices, the toast label, and two thunks:
// `single` for the 1-device path and `multi` for the fan-out. Anything
// outside that shape (optimistic writes, pre-gates like
// `confirmStartFromCached`, success toasts on the single path, custom
// outcome handling) stays in the caller — that's intentional, the
// helper exists for the common case, not to be a do-everything wrapper.
export async function runWithFanout<T>(params: {
  udids: string[]
  devices: { udid: string }[]
  action: string
  // `single` may be sync (e.g. `sim.pause()`) or async (e.g.
  // `sim.teleport(...)` which returns `Promise<StatusResponse>`). The
  // return value is intentionally ignored — the helper only cares that
  // the call has finished before resolving.
  single: () => unknown
  multi: (udids: string[]) => Promise<FanoutOutcome<T>>
  t: (k: StringKey, v?: Record<string, string | number>) => string
  showToast: (msg: string) => void
}): Promise<void> {
  const { udids, devices, action, single, multi, t, showToast } = params
  if (udids.length >= FANOUT_MIN_DEVICES) {
    const outcome = await multi(udids)
    showToast(toastForFanout(t, action, outcome, devices))
  } else {
    await single()
  }
}

// `runWithFanout` for fire-and-forget controls (stop / pause / resume):
// callers (dock buttons, ETA bar, Space key) never handle the promise, so a
// single-device failure would otherwise be an unhandled rejection with no
// visible message. The fan-out path already toasts via toastForFanout.
export async function runWithFanoutOrToast<T>(
  params: Parameters<typeof runWithFanout<T>>[0],
): Promise<void> {
  try {
    await runWithFanout(params)
  } catch (err: unknown) {
    params.showToast(params.t('toast.action_failed', {
      action: params.action,
      msg: err instanceof Error ? err.message : String(err),
    }))
  }
}
