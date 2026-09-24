import { useState, useCallback, useEffect, useRef } from 'react'
import * as api from '../services/api'
import { devLog } from '../lib/dev-log'
import { needsFlagBackfill } from '../lib/bookmark_helpers'
import type { Bookmark, BookmarkPlace, BookmarkTag } from '../types/bookmarks'

// Domain models live in types/bookmarks.ts (neutral module shared with the
// services layer); re-exported here so existing consumer imports keep working.
export type { Bookmark, BookmarkPlace, BookmarkTag } from '../types/bookmarks'

export function useBookmarks() {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [places, setPlaces] = useState<BookmarkPlace[]>([])
  const [tags, setTags] = useState<BookmarkTag[]>([])
  // Starts true so the pre-first-fetch render reads as "loading", not
  // "loaded and empty" — the mount effect kicks off refresh() right away.
  const [loading, setLoading] = useState(true)
  const mountedRef = useRef(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [store, ps, ts] = await Promise.all([
        api.getBookmarks(),
        api.getPlaces(),
        api.getTags(),
      ])
      if (!mountedRef.current) return
      // /api/bookmarks now returns the full store envelope; older shape
      // support kept only for resilience against transient stale backends.
      const bms = Array.isArray(store) ? store : store.bookmarks ?? []
      setBookmarks(bms)
      setPlaces(Array.isArray(ps) ? ps : [])
      setTags(Array.isArray(ts) ? ts : [])
    } catch (err) {
      devLog('Failed to load bookmarks:', err)
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  const backfilledRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    refresh()
    return () => {
      mountedRef.current = false
    }
  }, [refresh])

  // Lazily enrich legacy rows that were created before country_code/country
  // existed. Runs at most once per session so we don't hammer Nominatim.
  useEffect(() => {
    if (backfilledRef.current) return
    if (loading) return
    if (bookmarks.length === 0) return
    if (!needsFlagBackfill(bookmarks)) return
    backfilledRef.current = true
    api.backfillBookmarkFlags()
      .then((res) => {
        if (!mountedRef.current) return
        if (res?.filled && res.filled > 0) refresh()
      })
      .catch(() => {
        // Swallow — backfill is best-effort and not user-facing.
      })
  }, [bookmarks, loading, refresh])

  // ── Bookmark mutations ────────────────────────────────
  const createBookmark = useCallback(
    async (bm: Omit<Bookmark, 'id'>) => {
      const created = await api.createBookmark(bm)
      await refresh()
      return created
    },
    [refresh],
  )

  const deleteBookmark = useCallback(async (id: string) => {
    await api.deleteBookmark(id)
    setBookmarks((prev) => prev.filter((b) => b.id !== id))
  }, [])

  const deleteBookmarksBatch = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return 0
    const res = await api.deleteBookmarksBatch(ids)
    const doomed = new Set(ids)
    setBookmarks((prev) => prev.filter((b) => !doomed.has(b.id)))
    return res?.deleted ?? ids.length
  }, [])

  const backfillFlags = useCallback(async () => {
    try {
      const res = await api.backfillBookmarkFlags()
      if (res?.filled && res.filled > 0) {
        await refresh()
      }
      return res?.filled ?? 0
    } catch {
      return 0
    }
  }, [refresh])

  const updateBookmark = useCallback(
    async (id: string, data: Partial<Bookmark>) => {
      const updated = await api.updateBookmark(id, data)
      await refresh()
      return updated
    },
    [refresh],
  )

  // Fire-and-forget usage tick. Optimistically bumps `last_used_at` so the
  // "Recent" sort reflects the click immediately without a full list refetch.
  //
  // Format must match Python's `datetime.now(timezone.utc).isoformat()` on
  // the backend (microsecond precision + literal `+00:00`), because the
  // "Recent" sort compares timestamps as plain strings — `Z` vs `+00:00`
  // would break lexicographic ordering at the second-and-below boundary.
  const touchBookmark = useCallback((id: string) => {
    const now = new Date().toISOString().replace('Z', '000+00:00')
    setBookmarks((prev) =>
      prev.map((b) => (b.id === id ? { ...b, last_used_at: now } : b)),
    )
    api.touchBookmark(id).catch((err) => {
      devLog('touchBookmark failed:', err)
    })
  }, [])

  const moveBookmarks = useCallback(
    async (ids: string[], placeId: string) => {
      await api.moveBookmarks(ids, placeId)
      await refresh()
    },
    [refresh],
  )

  const tagBookmarks = useCallback(
    async (ids: string[], add: string[] = [], remove: string[] = []) => {
      await api.tagBookmarks(ids, add, remove)
      await refresh()
    },
    [refresh],
  )

  // ── Place mutations ───────────────────────────────────
  const createPlace = useCallback(
    async (place: Omit<BookmarkPlace, 'id'>) => {
      const created = await api.createPlace(place)
      await refresh()
      return created
    },
    [refresh],
  )

  const deletePlace = useCallback(
    async (id: string) => {
      await api.deletePlace(id)
      await refresh()
    },
    [refresh],
  )

  const updatePlace = useCallback(
    async (id: string, data: Partial<BookmarkPlace>) => {
      const updated = await api.updatePlace(id, data)
      await refresh()
      return updated
    },
    [refresh],
  )

  const reorderPlaces = useCallback(
    async (orderedIds: string[]) => {
      await api.reorderPlaces(orderedIds)
      await refresh()
    },
    [refresh],
  )

  // ── Tag mutations ─────────────────────────────────────
  const createTag = useCallback(
    async (tag: Omit<BookmarkTag, 'id'>) => {
      const created = await api.createTag(tag)
      await refresh()
      return created
    },
    [refresh],
  )

  const deleteTag = useCallback(
    async (id: string) => {
      await api.deleteTag(id)
      await refresh()
    },
    [refresh],
  )

  const updateTag = useCallback(
    async (id: string, data: Partial<BookmarkTag>) => {
      const updated = await api.updateTag(id, data)
      await refresh()
      return updated
    },
    [refresh],
  )

  const reorderTags = useCallback(
    async (orderedIds: string[]) => {
      await api.reorderTags(orderedIds)
      await refresh()
    },
    [refresh],
  )

  return {
    bookmarks,
    places,
    tags,
    loading,
    createBookmark,
    updateBookmark,
    touchBookmark,
    deleteBookmark,
    deleteBookmarksBatch,
    backfillFlags,
    moveBookmarks,
    tagBookmarks,
    createPlace,
    updatePlace,
    deletePlace,
    reorderPlaces,
    createTag,
    updateTag,
    deleteTag,
    reorderTags,
    refresh,
  }
}
