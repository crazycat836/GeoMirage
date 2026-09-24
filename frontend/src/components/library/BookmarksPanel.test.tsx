// @vitest-environment jsdom
/**
 * Render-count guard for the bookmark list: a position tick re-renders
 * BookmarksPanel, but a row must re-render only when its own "active"
 * flag flips. ListRow is stubbed to count renders per bookmark; it renders
 * exactly when its (memoised) BookmarkRow does.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'

const h = vi.hoisted(() => {
  const renders: Record<string, number> = {}
  let pos: { lat: number; lng: number } | null = { lat: 0, lng: 0 }
  let value: { currentPos: { lat: number; lng: number } | null } = { currentPos: pos }
  const listeners = new Set<() => void>()
  const bookmarks = [
    { id: 'a', name: 'A', lat: 25, lng: 121, place_id: 'default', tags: [] },
    { id: 'b', name: 'B', lat: 26, lng: 121, place_id: 'default', tags: [] },
    { id: 'c', name: 'C', lat: 27, lng: 121, place_id: 'default', tags: [] },
  ]
  const bmValue = {
    bookmarks,
    places: [{ id: 'default', name: 'Default' }],
    tags: [],
    loading: false,
    touchBookmark: () => {},
    handleBookmarksReorder: () => {},
  }
  return {
    renders,
    bmValue,
    toastValue: { showToast: () => {} },
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    get: () => value,
    setPos: (next: { lat: number; lng: number } | null) => {
      pos = next
      value = { currentPos: pos }
      listeners.forEach((fn) => fn())
    },
  }
})
const { renders } = h

vi.mock('../../services/usage', () => ({ useDialogUsage: () => {} }))
vi.mock('../../i18n', () => {
  const t = (k: string) => k
  return { useT: () => t }
})
vi.mock('../../contexts/ToastContext', () => ({ useToastContext: () => h.toastValue }))
vi.mock('../../contexts/BookmarkContext', () => ({ useBookmarkContext: () => h.bmValue }))
vi.mock('../../contexts/SimDerivedContext', async () => {
  const { useSyncExternalStore } = await import('react')
  return { useSimDerived: () => useSyncExternalStore(h.subscribe, h.get) }
})
vi.mock('../ui/ListRow', () => ({
  default: (props: { 'aria-label': string }) => {
    const id = props['aria-label']
    renders[id] = (renders[id] ?? 0) + 1
    return null
  },
}))
vi.mock('./BookmarksToolbar', () => ({ default: () => null }))
vi.mock('./BookmarksFooter', () => ({ default: () => null }))
vi.mock('./BookmarkEditDialog', () => ({ default: () => null }))
vi.mock('./PlaceManagerDialog', () => ({ default: () => null }))
vi.mock('./TagManagerDialog', () => ({ default: () => null }))
vi.mock('./BulkCoordsDialog', () => ({ default: () => null }))
vi.mock('../ui/ConfirmDialog', () => ({ default: () => null }))

import BookmarksPanel from './BookmarksPanel'

afterEach(() => {
  cleanup()
  for (const k of Object.keys(renders)) delete renders[k]
  h.setPos({ lat: 0, lng: 0 })
})

function tick(lat: number, lng = 121) {
  act(() => { h.setPos({ lat, lng }) })
}

describe('BookmarksPanel row render isolation', () => {
  it('does not re-render rows on a position tick that changes no active flag', () => {
    render(<BookmarksPanel onBookmarkClick={() => {}} />)
    const before = { ...renders }

    tick(10)
    tick(10.001)
    tick(10.002)

    expect(renders).toEqual(before)
  })

  it('re-renders only the rows whose active flag flips', () => {
    render(<BookmarksPanel onBookmarkClick={() => {}} />)
    const before = { ...renders }

    tick(25) // A becomes active
    expect(renders.A).toBe(before.A + 1)
    expect(renders.B).toBe(before.B)
    expect(renders.C).toBe(before.C)

    tick(26) // A inactive, B active
    expect(renders.A).toBe(before.A + 2)
    expect(renders.B).toBe(before.B + 1)
    expect(renders.C).toBe(before.C)
  })
})
