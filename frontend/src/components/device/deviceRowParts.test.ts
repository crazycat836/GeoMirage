import { describe, it, expect } from 'vitest'
import { getDeviceRowStatus } from './deviceRowParts'

const base = {
  isConnected: false,
  unsupported: false,
  isPrimary: false,
  isLost: false,
  degraded: false,
  wasConnected: false,
}

describe('getDeviceRowStatus', () => {
  it.each([
    ['primary connected device', { isConnected: true, isPrimary: true, wasConnected: true }, 'connected'],
    ['second connected device', { isConnected: true, wasConnected: true }, 'connected_secondary'],
    ['connected device with a degraded tunnel', { isConnected: true, isPrimary: true, degraded: true }, 'reconnecting'],
    ['secondary with a degraded tunnel', { isConnected: true, degraded: true }, 'reconnecting'],
    ['device the user disconnected', { wasConnected: true }, 'not_connected'],
    ['device lost involuntarily', { isLost: true, wasConnected: true }, 'lost'],
    ['device never connected this session', {}, 'ready'],
    ['unsupported iOS', { unsupported: true, isConnected: true, isPrimary: true }, 'unsupported'],
    ['stale degraded flag on a disconnected device', { degraded: true, wasConnected: true }, 'not_connected'],
  ] as const)('%s', (_name, over, expected) => {
    expect(getDeviceRowStatus({ ...base, ...over })).toBe(expected)
  })
})
