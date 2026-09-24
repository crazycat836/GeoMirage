import React, { createContext, useContext, useState, useCallback, useMemo } from 'react'
import { useBookmarks, type Bookmark, type BookmarkPlace, type BookmarkTag } from '../hooks/useBookmarks'
import * as api from '../services/api'
import { useToastContext } from './ToastContext'
import { useT } from '../i18n'
import { useSerializedReorder } from '../hooks/useSerializedReorder'
import { validateBookmarkImport } from '../lib/bookmark_helpers'

interface AddBmDialog {
  lat: number
  lng: number
}

interface BookmarkContextValue {
  // From useBookmarks
  bookmarks: Bookmark[]
  places: BookmarkPlace[]
  tags: BookmarkTag[]
  /** True while a bookmark-store fetch is in flight (initial load + refreshes).
   *  Panels use it to show a loading state instead of a premature "empty". */
  loading: boolean
  createBookmark: (bm: Omit<Bookmark, 'id'>) => Promise<Bookmark>
  createBookmarksBulk: (
    items: Array<{ lat: number; lng: number; name?: string }>,
    placeId?: string,
  ) => Promise<{ created: number; failed: number }>
  updateBookmark: (id: string, data: Partial<Bookmark>) => Promise<Bookmark>
  touchBookmark: (id: string) => void
  deleteBookmark: (id: string) => Promise<void>
  deleteBookmarksBatch: (ids: string[]) => Promise<number>
  moveBookmarks: (ids: string[], placeId: string) => Promise<void>
  tagBookmarks: (ids: string[], add?: string[], remove?: string[]) => Promise<void>
  createPlace: (place: Omit<BookmarkPlace, 'id'>) => Promise<BookmarkPlace>
  updatePlace: (id: string, data: Partial<BookmarkPlace>) => Promise<BookmarkPlace>
  deletePlace: (id: string) => Promise<void>
  reorderPlaces: (orderedIds: string[]) => Promise<void>
  createTag: (tag: Omit<BookmarkTag, 'id'>) => Promise<BookmarkTag>
  updateTag: (id: string, data: Partial<BookmarkTag>) => Promise<BookmarkTag>
  deleteTag: (id: string) => Promise<void>
  reorderTags: (orderedIds: string[]) => Promise<void>
  refresh: () => Promise<void>

  // Add bookmark dialog
  addBmDialog: AddBmDialog | null
  setAddBmDialog: React.Dispatch<React.SetStateAction<AddBmDialog | null>>
  handleAddBookmark: (lat: number, lng: number) => void

  // Bookmark import/export
  handleBookmarkImport: (file: File) => Promise<void>
  handleBookmarkExport: () => Promise<void>
  /** True while an import round-trip is in flight (drives the busy/disabled
   *  state on the Import button). */
  importingBookmarks: boolean

  // Reorder
  handleBookmarksReorder: (orderedIds: string[]) => Promise<void>
}

const BookmarkContext = createContext<BookmarkContextValue | null>(null)

export function BookmarkProvider({ children }: { children: React.ReactNode }) {
  const t = useT()
  const { showToast } = useToastContext()
  const bm = useBookmarks()

  const [addBmDialog, setAddBmDialog] = useState<AddBmDialog | null>(null)
  const [importingBookmarks, setImportingBookmarks] = useState(false)

  const handleAddBookmark = useCallback((lat: number, lng: number) => {
    setAddBmDialog({ lat, lng })
  }, [])

  const handleBookmarkImport = useCallback(async (file: File) => {
    setImportingBookmarks(true)
    try {
      const text = await file.text()
      const data = JSON.parse(text)
      validateBookmarkImport(data)
      const res = await api.importBookmarks(data)
      await bm.refresh()
      // 0 imported is a no-op, not a failure — say so neutrally instead of
      // "Imported 0 entries", which reads like something went wrong.
      showToast(res.imported > 0
        ? t('bm.import_success', { n: res.imported })
        : t('bm.import_none'))
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'unknown'
      showToast(t('bm.import_failed', { error: message }))
    } finally {
      setImportingBookmarks(false)
    }
  }, [bm.refresh, showToast, t])

  // Stable handler; latest bm.refresh is picked up via the hook's internal
  // ref. See useSerializedReorder for the in-flight/queue rationale.
  const handleBookmarksReorder = useSerializedReorder(
    api.reorderBookmarks, bm.refresh, 'reorderBookmarks failed',
  )

  const handleBookmarkExport = useCallback(async () => {
    try {
      await api.downloadBookmarksExport('bookmarks.json')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : ''
      showToast(t('toast.export_failed', { msg: message }))
    }
  }, [showToast, t])

  const createBookmarksBulk = useCallback(
    async (
      items: Array<{ lat: number; lng: number; name?: string }>,
      placeId?: string,
    ): Promise<{ created: number; failed: number }> => {
      if (items.length === 0) return { created: 0, failed: 0 }
      const targetPlace = (placeId && bm.places.some((p) => p.id === placeId))
        ? placeId
        : 'default'
      const defaultName = t('bm.default_name')
      // Call `api.createBookmark` directly (not `bm.createBookmark`) so
      // each POST doesn't trigger its own `refresh()` — a 50-row
      // import would otherwise fire 50 full GET /bookmarks round-trips.
      const results = await Promise.allSettled(
        items.map((it, idx) => api.createBookmark({
          name: (it.name || '').trim() || `${defaultName} ${idx + 1}`,
          lat: it.lat,
          lng: it.lng,
          place_id: targetPlace,
          tags: [],
        })),
      )
      let created = 0
      let failed = 0
      for (const r of results) {
        if (r.status === 'fulfilled') created++
        else failed++
      }
      if (created > 0) {
        await bm.refresh()
        showToast(t('toast.bookmarks_bulk_ok', { n: created }))
      }
      if (failed > 0) showToast(t('toast.bookmarks_bulk_partial', { n: failed }))
      return { created, failed }
    },
    [bm.places, bm.refresh, showToast, t],
  )

  // Memoize so consumers don't re-render on every provider re-render.
  // Keys on the individual members (not `bm` itself, which useBookmarks
  // rebuilds each render); each member is a useCallback / stable state value,
  // so the value identity only changes when something real does.
  const value: BookmarkContextValue = useMemo(() => ({
    bookmarks: bm.bookmarks,
    places: bm.places,
    tags: bm.tags,
    loading: bm.loading,
    createBookmark: bm.createBookmark,
    createBookmarksBulk,
    updateBookmark: bm.updateBookmark,
    touchBookmark: bm.touchBookmark,
    deleteBookmark: bm.deleteBookmark,
    deleteBookmarksBatch: bm.deleteBookmarksBatch,
    moveBookmarks: bm.moveBookmarks,
    tagBookmarks: bm.tagBookmarks,
    createPlace: bm.createPlace,
    updatePlace: bm.updatePlace,
    deletePlace: bm.deletePlace,
    reorderPlaces: bm.reorderPlaces,
    createTag: bm.createTag,
    updateTag: bm.updateTag,
    deleteTag: bm.deleteTag,
    reorderTags: bm.reorderTags,
    refresh: bm.refresh,

    addBmDialog,
    setAddBmDialog,
    handleAddBookmark,

    handleBookmarkImport,
    handleBookmarkExport,
    importingBookmarks,

    handleBookmarksReorder,
  }), [
    bm.bookmarks, bm.places, bm.tags, bm.loading,
    bm.createBookmark, bm.updateBookmark, bm.touchBookmark, bm.deleteBookmark,
    bm.deleteBookmarksBatch, bm.moveBookmarks, bm.tagBookmarks,
    bm.createPlace, bm.updatePlace, bm.deletePlace, bm.reorderPlaces,
    bm.createTag, bm.updateTag, bm.deleteTag, bm.reorderTags, bm.refresh,
    createBookmarksBulk,
    addBmDialog, setAddBmDialog, handleAddBookmark,
    handleBookmarkImport, handleBookmarkExport, importingBookmarks,
    handleBookmarksReorder,
  ])

  return (
    <BookmarkContext.Provider value={value}>
      {children}
    </BookmarkContext.Provider>
  )
}

export function useBookmarkContext() {
  const ctx = useContext(BookmarkContext)
  if (!ctx) throw new Error('useBookmarkContext must be used within BookmarkProvider')
  return ctx
}
