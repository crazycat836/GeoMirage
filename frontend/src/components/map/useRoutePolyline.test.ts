// @vitest-environment jsdom
/**
 * The route polyline must track every new `routePath` array: a fresh
 * array with the same length / start / end (re-sent route, primary device
 * switch) keeps the line on the map, and a re-planned route that only
 * differs mid-way is redrawn.
 */
import { renderHook, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type L from 'leaflet'
import type { Position } from './types'

interface FakeLine {
  latlngs: unknown[]
  onMap: boolean
  addTo: () => FakeLine
  remove: () => FakeLine
  setLatLngs: (ll: unknown[]) => FakeLine
}

const lines: FakeLine[] = []

vi.mock('leaflet', () => {
  const polyline = (latlngs: unknown[]) => {
    const line: FakeLine = {
      latlngs,
      onMap: false,
      addTo() { line.onMap = true; return line },
      remove() { line.onMap = false; return line },
      setLatLngs(ll) { line.latlngs = ll; return line },
    }
    lines.push(line)
    return line
  }
  return { default: { polyline }, polyline }
})

import { useRoutePolyline } from './useRoutePolyline'

afterEach(() => {
  cleanup()
  lines.length = 0
})

const mapRef = { current: {} as L.Map }

function visibleLines(): FakeLine[] {
  return lines.filter((l) => l.onMap)
}

const ROUTE: Position[] = [
  { lat: 25, lng: 121 },
  { lat: 25.01, lng: 121.01 },
  { lat: 25.02, lng: 121.02 },
]

describe('useRoutePolyline', () => {
  it('keeps the route on the map when a new array with the same signature arrives', () => {
    const { rerender } = renderHook(({ path }) => useRoutePolyline(mapRef, path), {
      initialProps: { path: ROUTE },
    })
    expect(visibleLines()).toHaveLength(2)

    rerender({ path: ROUTE.map((p) => ({ ...p })) })
    expect(visibleLines()).toHaveLength(2)
  })

  it('redraws a route that only differs in the middle', () => {
    const { rerender } = renderHook(({ path }) => useRoutePolyline(mapRef, path), {
      initialProps: { path: ROUTE },
    })
    const replanned = [ROUTE[0], { lat: 24.99, lng: 121.05 }, ROUTE[2]]
    rerender({ path: replanned })

    const shown = visibleLines()
    expect(shown).toHaveLength(2)
    for (const line of shown) {
      expect(line.latlngs).toEqual(replanned.map((p) => [p.lat, p.lng]))
    }
  })

  it('removes the lines when the route clears and on unmount', () => {
    const { rerender, unmount } = renderHook(({ path }) => useRoutePolyline(mapRef, path), {
      initialProps: { path: ROUTE },
    })
    rerender({ path: [] })
    expect(visibleLines()).toHaveLength(0)

    rerender({ path: ROUTE })
    expect(visibleLines()).toHaveLength(2)
    unmount()
    expect(visibleLines()).toHaveLength(0)
  })
})
