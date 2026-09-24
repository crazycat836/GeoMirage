import { describe, it, expect } from 'vitest'
import { isInvoluntaryDisconnect } from './parsers'

describe('isInvoluntaryDisconnect', () => {
  it.each([
    'user',
    'forget',
    'hard_reset',
    'usb_removed_pre_wifi_fallback',
  ])('treats %s as a deliberate disconnect (no lost pill / toast)', (reason) => {
    expect(isInvoluntaryDisconnect(reason)).toBe(false)
  })

  it.each([
    'usb_removed',
    'wifi_dropped',
    'phone_locked',
    'ddi_not_mounted',
    'dvt_channel_dropped',
    undefined,
  ])('treats %s as an involuntary loss', (reason) => {
    expect(isInvoluntaryDisconnect(reason)).toBe(true)
  })
})
