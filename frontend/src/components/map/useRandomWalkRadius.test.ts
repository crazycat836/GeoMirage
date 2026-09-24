// @vitest-environment jsdom
/**
 * The random-walk radius circle is created once and updated in place, and
 * while a walk is running it stays on the start point the backend picks
 * targets around instead of following the device.
 */
import { renderHook, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type L from 'leaflet'
import type { Position } from './types'

interface FakeCircle {
  center: [number, number]
  radius: number
  onMap: boolean
}

const circles: FakeCircle[] = []

vi.mock('leaflet', () => {
  const circle = (center: [number, number], opts: { radius: number }) => {
    const c = {
      center,
      radius: opts.radius,
      onMap: false,
      addTo() { c.onMap = true; return c },
      remove() { c.onMap = false; return c },
      setLatLng(ll: [number, number]) { c.center = ll; return c },
      setRadius(r: number) { c.radius = r; return c },
    }
    circles.push(c)
    return c
  }
  return { default: { circle }, circle }
})

import { useRandomWalkRadius } from './useRandomWalkRadius'

afterEach(() => {
  cleanup()
  circles.length = 0
})

const mapRef = { current: {} as L.Map }

type Props = { r: number | null; p: Position | null; pin: boolean }

function setup(initial: Props) {
  return renderHook(
    ({ r, p, pin }: Props) => useRandomWalkRadius(mapRef, r, p, pin),
    { initialProps: initial },
  )
}

describe('useRandomWalkRadius', () => {
  it('creates the circle once and moves it with the position when not pinned', () => {
    const { rerender } = setup({ r: 500, p: { lat: 25, lng: 121 }, pin: false })
    for (let i = 1; i <= 5; i++) rerender({ r: 500, p: { lat: 25 + i * 1e-3, lng: 121 }, pin: false })
    expect(circles).toHaveLength(1)
    expect(circles[0].onMap).toBe(true)
    expect(circles[0].center).toEqual([25.005, 121])
  })

  it('keeps the start point as the centre while a walk is running', () => {
    const { rerender } = setup({ r: 500, p: { lat: 25, lng: 121 }, pin: false })
    rerender({ r: 500, p: { lat: 25, lng: 121 }, pin: true })
    for (let i = 1; i <= 5; i++) rerender({ r: 500, p: { lat: 25 + i * 1e-3, lng: 121 }, pin: true })
    expect(circles).toHaveLength(1)
    expect(circles[0].center).toEqual([25, 121])

    // Walk ends: back to following the device.
    rerender({ r: 500, p: { lat: 25.006, lng: 121 }, pin: false })
    expect(circles[0].center).toEqual([25.006, 121])
  })

  it('removes the circle when hidden and on unmount', () => {
    const { rerender, unmount } = setup({ r: 500, p: { lat: 25, lng: 121 }, pin: false })
    rerender({ r: null, p: { lat: 25, lng: 121 }, pin: false })
    expect(circles[0].onMap).toBe(false)
    rerender({ r: 300, p: { lat: 25, lng: 121 }, pin: false })
    expect(circles).toHaveLength(2)
    unmount()
    expect(circles[1].onMap).toBe(false)
  })
})
