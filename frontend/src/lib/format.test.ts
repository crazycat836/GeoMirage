import { describe, expect, test } from 'vitest'
import {
  KM_THRESHOLD_M,
  coordKey,
  formatCoord,
  formatCoordCardinal,
  formatCardinalAxis,
  formatCoordDegrees,
  formatCooldownS,
  formatCountdown,
  formatDistanceM,
  formatDurationS,
} from './format'
import { translate } from '../i18n'
import type { StringKey } from '../i18n'

const TAIPEI = { lat: 25.033, lng: 121.5654 }

describe('formatCoord', () => {
  test('joins lat/lng with comma at the given precision', () => {
    expect(formatCoord(TAIPEI, 6)).toBe('25.033000, 121.565400')
    expect(formatCoord(TAIPEI, 4)).toBe('25.0330, 121.5654')
  })

  test('defaults to 6 decimal places', () => {
    expect(formatCoord(TAIPEI)).toBe('25.033000, 121.565400')
  })

  test('keeps sign for southern/western coordinates', () => {
    expect(formatCoord({ lat: -33.8688, lng: -70.6693 }, 4)).toBe('-33.8688, -70.6693')
  })
})

describe('formatCoordCardinal', () => {
  test('renders the °N · °E style used by the dock', () => {
    expect(formatCoordCardinal(TAIPEI, 5)).toBe('25.03300°N · 121.56540°E')
    expect(formatCoordCardinal(TAIPEI, 4)).toBe('25.0330°N · 121.5654°E')
  })

  test('defaults to 5 decimal places', () => {
    expect(formatCoordCardinal(TAIPEI)).toBe('25.03300°N · 121.56540°E')
  })

  test('uses S / W with absolute values in every quadrant', () => {
    // NE, SE, NW, SW
    expect(formatCoordCardinal(TAIPEI)).toBe('25.03300°N · 121.56540°E')
    expect(formatCoordCardinal({ lat: -33.8688, lng: 151.2093 })).toBe('33.86880°S · 151.20930°E')
    expect(formatCoordCardinal({ lat: 40.7128, lng: -74.006 })).toBe('40.71280°N · 74.00600°W')
    expect(formatCoordCardinal({ lat: -34.6037, lng: -58.3816 })).toBe('34.60370°S · 58.38160°W')
  })

  test('a value that rounds to zero reads N / E', () => {
    expect(formatCoordCardinal({ lat: -0.000001, lng: -0.000001 })).toBe('0.00000°N · 0.00000°E')
  })
})

describe('formatCoordDegrees', () => {
  test('renders the °-suffixed comma style used by list rows', () => {
    expect(formatCoordDegrees(TAIPEI, 6)).toBe('25.033000°, 121.565400°')
    expect(formatCoordDegrees(TAIPEI, 4)).toBe('25.0330°, 121.5654°')
  })

  test('defaults to 6 decimal places', () => {
    expect(formatCoordDegrees(TAIPEI)).toBe('25.033000°, 121.565400°')
  })
})

describe('coordKey', () => {
  test('builds a compact signature at 7 decimal places by default', () => {
    expect(coordKey(TAIPEI)).toBe('25.0330000,121.5654000')
  })

  test('honours a custom precision', () => {
    expect(coordKey(TAIPEI, 6)).toBe('25.033000,121.565400')
  })
})

describe('formatDistanceM', () => {
  test('rounds to whole metres below the km threshold', () => {
    expect(formatDistanceM(0)).toBe('0 m')
    expect(formatDistanceM(999.4)).toBe('999 m')
  })

  test('switches to km at the threshold with 2 decimal places by default', () => {
    expect(formatDistanceM(KM_THRESHOLD_M)).toBe('1.00 km')
    expect(formatDistanceM(1234)).toBe('1.23 km')
  })

  test('supports 1-decimal km precision', () => {
    expect(formatDistanceM(1234, 1)).toBe('1.2 km')
    expect(formatDistanceM(999, 1)).toBe('999 m')
  })
})

describe('formatCountdown', () => {
  test('renders M:SS below one hour', () => {
    expect(formatCountdown(0)).toBe('0:00')
    expect(formatCountdown(59)).toBe('0:59')
    expect(formatCountdown(125)).toBe('2:05')
  })

  test('renders H:MM:SS from one hour up', () => {
    expect(formatCountdown(3600)).toBe('1:00:00')
    expect(formatCountdown(5400)).toBe('1:30:00')
    expect(formatCountdown(3725)).toBe('1:02:05')
  })

  test('rounds fractional seconds like the cooldown badge did', () => {
    expect(formatCountdown(59.6)).toBe('1:00')
  })
})

const tZh = (k: StringKey, v?: Record<string, string | number>) => translate('zh', k, v)
const tEn = (k: StringKey, v?: Record<string, string | number>) => translate('en', k, v)
const ENGLISH_UNIT = /\b(min|h|m|s)\b/

describe('formatDurationS', () => {
  test('keeps the compact English output', () => {
    expect(formatDurationS(20, tEn)).toBe('< 1 min')
    expect(formatDurationS(12 * 60, tEn)).toBe('12 min')
    expect(formatDurationS(2 * 3600, tEn)).toBe('2 h')
    expect(formatDurationS(125 * 60, tEn)).toBe('2 h 5 m')
  })

  test('uses Chinese units in the zh locale', () => {
    for (const secs of [20, 12 * 60, 2 * 3600, 125 * 60]) {
      expect(formatDurationS(secs, tZh)).not.toMatch(ENGLISH_UNIT)
    }
    expect(formatDurationS(125 * 60, tZh)).toBe('2 小時 5 分鐘')
  })
})

describe('formatCooldownS', () => {
  test('keeps the compact English output', () => {
    expect(formatCooldownS(0, tEn)).toBe('0 s')
    expect(formatCooldownS(30, tEn)).toBe('30 s')
    expect(formatCooldownS(5 * 60, tEn)).toBe('5 min')
    expect(formatCooldownS(3600, tEn)).toBe('1 h')
    expect(formatCooldownS(3600 + 5 * 60, tEn)).toBe('1 h 5 m')
  })

  test('uses Chinese units in the zh locale', () => {
    for (const secs of [0, 30, 5 * 60, 3600, 3900]) {
      expect(formatCooldownS(secs, tZh)).not.toMatch(ENGLISH_UNIT)
    }
    expect(formatCooldownS(30, tZh)).toBe('30 秒')
  })
})

describe('formatCardinalAxis', () => {
  test('splits value and hemisphere for each axis sign', () => {
    expect(formatCardinalAxis(-33.8688, 'lat', 6)).toEqual({ value: '33.868800', hemisphere: 'S' })
    expect(formatCardinalAxis(25.033, 'lat', 6)).toEqual({ value: '25.033000', hemisphere: 'N' })
    expect(formatCardinalAxis(-74.006, 'lng', 6)).toEqual({ value: '74.006000', hemisphere: 'W' })
    expect(formatCardinalAxis(151.2093, 'lng', 6)).toEqual({ value: '151.209300', hemisphere: 'E' })
  })

  test('a value that rounds to zero reads N / E', () => {
    expect(formatCardinalAxis(-0.0000001, 'lat', 6)).toEqual({ value: '0.000000', hemisphere: 'N' })
  })
})
