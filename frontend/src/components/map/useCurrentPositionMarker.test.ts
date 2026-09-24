// @vitest-environment jsdom
/**
 * The current-position marker must not get a new icon on every position
 * update: `setIcon` rewrites the div's innerHTML and restarts the 2.5 s
 * pulse animation, so it may only run when the synced/unsynced state flips.
 */
import { renderHook, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type L from 'leaflet'
import type { Position } from './types'

interface FakeMarker {
  latlng: unknown
  iconHtml: string
  setIcon: ReturnType<typeof vi.fn>
  setLatLng: ReturnType<typeof vi.fn>
  setTooltipContent: ReturnType<typeof vi.fn>
}

const markers: FakeMarker[] = []

vi.mock('leaflet', () => {
  const divIcon = (opts: { html: string }) => ({ html: opts.html })
  const marker = (latlng: unknown, opts: { icon: { html: string } }) => {
    const m: FakeMarker & Record<string, unknown> = {
      latlng,
      iconHtml: opts.icon.html,
      setIcon: vi.fn((icon: { html: string }) => { m.iconHtml = icon.html; return m }),
      setLatLng: vi.fn((ll: unknown) => { m.latlng = ll; return m }),
      setTooltipContent: vi.fn(() => m),
      addTo: () => m,
      bindTooltip: () => m,
      remove: () => m,
    }
    markers.push(m)
    return m
  }
  return { default: { divIcon, marker }, divIcon, marker }
})

import { useCurrentPositionMarker } from './useCurrentPositionMarker'

afterEach(() => {
  cleanup()
  markers.length = 0
})

const mapRef = { current: { setView: vi.fn(), getZoom: () => 16 } as unknown as L.Map }

function setup(pos: Position, unsynced = false) {
  return renderHook(
    ({ p, u }) => useCurrentPositionMarker(mapRef, p, u),
    { initialProps: { p: pos as Position | null, u: unsynced } },
  )
}

describe('useCurrentPositionMarker', () => {
  it('moves the marker on position updates without replacing its icon', () => {
    const { rerender } = setup({ lat: 25, lng: 121 })
    expect(markers).toHaveLength(1)
    for (let i = 1; i <= 5; i++) rerender({ p: { lat: 25 + i * 1e-4, lng: 121 }, u: false })
    const m = markers[0]
    expect(markers).toHaveLength(1)
    expect(m.setLatLng).toHaveBeenCalledTimes(5)
    expect(m.setTooltipContent).toHaveBeenCalledTimes(5)
    expect(m.setIcon).not.toHaveBeenCalled()
  })

  it('swaps the icon only when the unsynced state flips', () => {
    const { rerender } = setup({ lat: 25, lng: 121 }, true)
    const m = markers[0]
    expect(m.iconHtml).toContain('map-pin-current--unsynced')

    rerender({ p: { lat: 25.0001, lng: 121 }, u: false })
    expect(m.setIcon).toHaveBeenCalledTimes(1)
    expect(m.iconHtml).not.toContain('--unsynced')

    rerender({ p: { lat: 25.0002, lng: 121 }, u: false })
    expect(m.setIcon).toHaveBeenCalledTimes(1)
  })
})
