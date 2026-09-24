import { describe, expect, test } from 'vitest'
import { resolveEffectiveKmh } from './sim-derive'
import { SPEED_MAP } from './constants'

// Mirrors backend/config.py::resolve_speed_profile — range > custom >
// mode preset (a range is sampled per leg there; the estimate is its mean).
describe('resolveEffectiveKmh', () => {
  const base = { moveMode: 'running', customSpeedKmh: null, speedMinKmh: null, speedMaxKmh: null }

  test('custom only → custom', () => {
    expect(resolveEffectiveKmh({ ...base, customSpeedKmh: 25 })).toBe(25)
  })

  test('range only → range midpoint', () => {
    expect(resolveEffectiveKmh({ ...base, speedMinKmh: 10, speedMaxKmh: 20 })).toBe(15)
  })

  test('both → range wins over custom', () => {
    expect(resolveEffectiveKmh({ ...base, customSpeedKmh: 25, speedMinKmh: 10, speedMaxKmh: 20 })).toBe(15)
  })

  test('neither → mode preset', () => {
    expect(resolveEffectiveKmh(base)).toBe(SPEED_MAP.running)
  })

  test('backend edge cases: reversed range, non-positive low end, zero custom, unknown mode', () => {
    expect(resolveEffectiveKmh({ ...base, speedMinKmh: 20, speedMaxKmh: 10 })).toBe(15)
    expect(resolveEffectiveKmh({ ...base, speedMinKmh: 0, speedMaxKmh: 10 })).toBeCloseTo(5.05)
    expect(resolveEffectiveKmh({ ...base, customSpeedKmh: 0 })).toBe(SPEED_MAP.running)
    expect(resolveEffectiveKmh({ ...base, moveMode: 'teleport' })).toBe(SPEED_MAP.walking)
  })
})
