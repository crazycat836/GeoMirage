// Characterization tests for the group fan-out helpers used by SimContext.
// These pin CURRENT behavior — they describe what the code does today,
// not necessarily what it should do.
import { describe, expect, test, vi } from 'vitest'
import { toastForFanout, runWithFanout, runWithFanoutOrToast } from './sim-fanout'
import type { FanoutOutcome } from '../hooks/useSimulation'
import type { StringKey } from '../i18n'

// Recording translator stub: returns "<key>::<json vars>" so assertions can
// pin both the exact message key and the exact interpolation variables.
function makeT() {
  const calls: Array<{ key: StringKey; vars?: Record<string, string | number> }> = []
  const t = (key: StringKey, vars?: Record<string, string | number>): string => {
    calls.push({ key, vars })
    return `${key}::${JSON.stringify(vars ?? {})}`
  }
  return { t, calls }
}

const DEVICE_A = { udid: 'udid-a' }
const DEVICE_B = { udid: 'udid-b' }

describe('toastForFanout', () => {
  test('returns the raw action string without translating when outcome is empty', () => {
    const { t, calls } = makeT()
    const outcome: FanoutOutcome<number> = { ok: [], failed: [] }

    const msg = toastForFanout(t, 'Start', outcome, [])

    expect(msg).toBe('Start')
    expect(calls).toHaveLength(0)
  })

  test('all-ok uses group.action_all_success with the action variable', () => {
    const { t, calls } = makeT()
    const outcome: FanoutOutcome<number> = {
      ok: [
        { udid: DEVICE_A.udid, value: 1 },
        { udid: DEVICE_B.udid, value: 2 },
      ],
      failed: [],
    }

    const msg = toastForFanout(t, 'Start', outcome, [DEVICE_A, DEVICE_B])

    expect(msg).toBe('group.action_all_success::{"action":"Start"}')
    expect(calls).toEqual([{ key: 'group.action_all_success', vars: { action: 'Start' } }])
  })

  test('all-fail uses group.action_all_failed with the action variable', () => {
    const { t, calls } = makeT()
    const outcome: FanoutOutcome<number> = {
      ok: [],
      failed: [
        { udid: DEVICE_A.udid, reason: 'boom' },
        { udid: DEVICE_B.udid, reason: 'bust' },
      ],
    }

    const msg = toastForFanout(t, 'Stop', outcome, [DEVICE_A, DEVICE_B])

    expect(msg).toBe('group.action_all_failed::{"action":"Stop"}')
    expect(calls).toEqual([{ key: 'group.action_all_failed', vars: { action: 'Stop' } }])
  })

  test('partial failure uses group.action_partial: OK for succeeded device, failure reason for failed device', () => {
    const { t } = makeT()
    const outcome: FanoutOutcome<number> = {
      ok: [{ udid: DEVICE_A.udid, value: 1 }],
      failed: [{ udid: DEVICE_B.udid, reason: 'tunnel lost' }],
    }

    const msg = toastForFanout(t, 'Teleport', outcome, [DEVICE_A, DEVICE_B])

    expect(msg).toBe(
      'group.action_partial::{"action":"Teleport","aStatus":"OK","bStatus":"tunnel lost"}',
    )
  })

  test('partial failure maps statuses by device position, not by outcome order', () => {
    const { t } = makeT()
    const outcome: FanoutOutcome<number> = {
      ok: [{ udid: DEVICE_B.udid, value: 1 }],
      failed: [{ udid: DEVICE_A.udid, reason: 'timeout' }],
    }

    // Device A failed, device B succeeded — aStatus follows devices[0].
    const msg = toastForFanout(t, 'Pause', outcome, [DEVICE_A, DEVICE_B])

    expect(msg).toBe(
      'group.action_partial::{"action":"Pause","aStatus":"timeout","bStatus":"OK"}',
    )
  })

  test('partial failure falls back to "error" for a device missing from both lists and "-" for an absent slot', () => {
    const { t } = makeT()
    const ghost = { udid: 'udid-ghost' }
    const outcome: FanoutOutcome<number> = {
      ok: [{ udid: DEVICE_A.udid, value: 1 }],
      failed: [{ udid: DEVICE_B.udid, reason: 'nope' }],
    }

    // devices[0] not in outcome → 'error'; devices[1] missing → '-'.
    const msg = toastForFanout(t, 'Resume', outcome, [ghost])

    expect(msg).toBe(
      'group.action_partial::{"action":"Resume","aStatus":"error","bStatus":"-"}',
    )
  })
})

describe('runWithFanout', () => {
  test('with 1 device calls the single thunk, never the fanout, and shows no toast', async () => {
    const { t } = makeT()
    const single = vi.fn()
    const multi = vi.fn()
    const showToast = vi.fn()

    const result = await runWithFanout({
      udids: [DEVICE_A.udid],
      devices: [DEVICE_A],
      action: 'Start',
      single,
      multi,
      t,
      showToast,
    })

    expect(single).toHaveBeenCalledTimes(1)
    expect(multi).not.toHaveBeenCalled()
    expect(showToast).not.toHaveBeenCalled()
    // Return semantics: resolves to undefined (single's return value is ignored).
    expect(result).toBeUndefined()
  })

  test('with 0 devices still takes the single path', async () => {
    const { t } = makeT()
    const single = vi.fn()
    const multi = vi.fn()
    const showToast = vi.fn()

    await runWithFanout({
      udids: [],
      devices: [],
      action: 'Start',
      single,
      multi,
      t,
      showToast,
    })

    expect(single).toHaveBeenCalledTimes(1)
    expect(multi).not.toHaveBeenCalled()
    expect(showToast).not.toHaveBeenCalled()
  })

  test('with exactly 2 devices (the threshold) calls the fanout with all udids and toasts the summary', async () => {
    const { t } = makeT()
    const single = vi.fn()
    const outcome: FanoutOutcome<number> = {
      ok: [
        { udid: DEVICE_A.udid, value: 1 },
        { udid: DEVICE_B.udid, value: 2 },
      ],
      failed: [],
    }
    const multi = vi.fn().mockResolvedValue(outcome)
    const showToast = vi.fn()

    const result = await runWithFanout({
      udids: [DEVICE_A.udid, DEVICE_B.udid],
      devices: [DEVICE_A, DEVICE_B],
      action: 'Start',
      single,
      multi,
      t,
      showToast,
    })

    expect(single).not.toHaveBeenCalled()
    expect(multi).toHaveBeenCalledTimes(1)
    expect(multi).toHaveBeenCalledWith([DEVICE_A.udid, DEVICE_B.udid])
    expect(showToast).toHaveBeenCalledTimes(1)
    expect(showToast).toHaveBeenCalledWith('group.action_all_success::{"action":"Start"}')
    expect(result).toBeUndefined()
  })

  test('multi-device partial failure toasts the partial summary built by toastForFanout', async () => {
    const { t } = makeT()
    const single = vi.fn()
    const outcome: FanoutOutcome<number> = {
      ok: [{ udid: DEVICE_A.udid, value: 1 }],
      failed: [{ udid: DEVICE_B.udid, reason: 'tunnel lost' }],
    }
    const multi = vi.fn().mockResolvedValue(outcome)
    const showToast = vi.fn()

    await runWithFanout({
      udids: [DEVICE_A.udid, DEVICE_B.udid],
      devices: [DEVICE_A, DEVICE_B],
      action: 'Teleport',
      single,
      multi,
      t,
      showToast,
    })

    expect(showToast).toHaveBeenCalledWith(
      'group.action_partial::{"action":"Teleport","aStatus":"OK","bStatus":"tunnel lost"}',
    )
  })

  test('awaits an async single thunk before resolving', async () => {
    const { t } = makeT()
    const order: string[] = []
    const single = vi.fn().mockImplementation(async () => {
      await Promise.resolve()
      order.push('single-done')
      return 'ignored-return-value'
    })

    await runWithFanout({
      udids: [DEVICE_A.udid],
      devices: [DEVICE_A],
      action: 'Teleport',
      single,
      multi: vi.fn(),
      t,
      showToast: vi.fn(),
    })
    order.push('run-resolved')

    expect(order).toEqual(['single-done', 'run-resolved'])
  })

  test('rejects when the single thunk throws (errors propagate to the caller)', async () => {
    const { t } = makeT()
    const single = vi.fn().mockRejectedValue(new Error('single failed'))

    await expect(
      runWithFanout({
        udids: [DEVICE_A.udid],
        devices: [DEVICE_A],
        action: 'Start',
        single,
        multi: vi.fn(),
        t,
        showToast: vi.fn(),
      }),
    ).rejects.toThrow('single failed')
  })

  test('rejects when the fanout rejects and shows no toast', async () => {
    const { t } = makeT()
    const showToast = vi.fn()
    const multi = vi.fn().mockRejectedValue(new Error('fanout failed'))

    await expect(
      runWithFanout({
        udids: [DEVICE_A.udid, DEVICE_B.udid],
        devices: [DEVICE_A, DEVICE_B],
        action: 'Start',
        single: vi.fn(),
        multi,
        t,
        showToast,
      }),
    ).rejects.toThrow('fanout failed')
    expect(showToast).not.toHaveBeenCalled()
  })
})

describe('runWithFanoutOrToast', () => {
  test('toasts the failure instead of rejecting when the single thunk throws', async () => {
    const { t } = makeT()
    const showToast = vi.fn()

    await expect(
      runWithFanoutOrToast({
        udids: [DEVICE_A.udid],
        devices: [DEVICE_A],
        action: 'Stop',
        single: vi.fn().mockRejectedValue(new Error('503 busy')),
        multi: vi.fn(),
        t,
        showToast,
      }),
    ).resolves.toBeUndefined()
    expect(showToast).toHaveBeenCalledWith(
      'toast.action_failed::{"action":"Stop","msg":"503 busy"}',
    )
  })

  test('shows no toast when the single thunk succeeds', async () => {
    const { t } = makeT()
    const showToast = vi.fn()
    await runWithFanoutOrToast({
      udids: [DEVICE_A.udid],
      devices: [DEVICE_A],
      action: 'Pause',
      single: vi.fn().mockResolvedValue(undefined),
      multi: vi.fn(),
      t,
      showToast,
    })
    expect(showToast).not.toHaveBeenCalled()
  })
})
