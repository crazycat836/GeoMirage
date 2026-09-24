/**
 * Bookmark endpoints (`/api/bookmarks/*`): bookmarks plus their two
 * grouping axes — places ("where") and tags ("what") — and import/export.
 */
import type { Bookmark, BookmarkPlace, BookmarkTag } from '../types/bookmarks'
import { request, downloadAuthed, type StatusResponse } from './http'

/** Store envelope returned by `/api/bookmarks`. */
export interface BookmarkStore {
  places: BookmarkPlace[]
  tags: BookmarkTag[]
  bookmarks: Bookmark[]
}

// Bookmarks
export const getBookmarks = () => request<BookmarkStore>('GET', '/api/bookmarks')
export const createBookmark = (bm: Omit<Bookmark, 'id'>) => request<Bookmark>('POST', '/api/bookmarks', bm)
export const updateBookmark = (id: string, bm: Partial<Bookmark>) => request<Bookmark>('PUT', `/api/bookmarks/${id}`, bm)
export const touchBookmark = (id: string) => request<Bookmark>('POST', `/api/bookmarks/${id}/touch`)
export const deleteBookmark = (id: string) => request<StatusResponse>('DELETE', `/api/bookmarks/${id}`)
export const deleteBookmarksBatch = (ids: string[]) =>
  request<{ deleted: number; requested: number }>('POST', '/api/bookmarks/batch-delete', { ids })
export const backfillBookmarkFlags = () =>
  request<{ filled: number }>('POST', '/api/bookmarks/backfill-flags')
export const moveBookmarks = (ids: string[], placeId: string) =>
  request<{ moved: number }>('POST', '/api/bookmarks/move', { bookmark_ids: ids, target_place_id: placeId })
export const tagBookmarks = (ids: string[], add: string[] = [], remove: string[] = []) =>
  request<{ tagged: number }>('POST', '/api/bookmarks/tag', {
    bookmark_ids: ids,
    tag_ids_add: add,
    tag_ids_remove: remove,
  })
export const reorderBookmarks = (orderedIds: string[]) =>
  request<{ reordered: number }>('POST', '/api/bookmarks/reorder', { ordered_ids: orderedIds })

// Places (single-axis, "where")
export const getPlaces = () => request<BookmarkPlace[]>('GET', '/api/bookmarks/places')
export const createPlace = (p: Omit<BookmarkPlace, 'id'>) => request<BookmarkPlace>('POST', '/api/bookmarks/places', p)
export const updatePlace = (id: string, p: Partial<BookmarkPlace>) => request<BookmarkPlace>('PUT', `/api/bookmarks/places/${id}`, p)
export const deletePlace = (id: string) => request<StatusResponse>('DELETE', `/api/bookmarks/places/${id}`)
export const reorderPlaces = (orderedIds: string[]) =>
  request<{ reordered: number }>('POST', '/api/bookmarks/places/reorder', { ordered_ids: orderedIds })

// Tags (multi-axis, "what")
export const getTags = () => request<BookmarkTag[]>('GET', '/api/bookmarks/tags')
export const createTag = (t: Omit<BookmarkTag, 'id'>) => request<BookmarkTag>('POST', '/api/bookmarks/tags', t)
export const updateTag = (id: string, t: Partial<BookmarkTag>) => request<BookmarkTag>('PUT', `/api/bookmarks/tags/${id}`, t)
export const deleteTag = (id: string) => request<StatusResponse>('DELETE', `/api/bookmarks/tags/${id}`)
export const reorderTags = (orderedIds: string[]) =>
  request<{ reordered: number }>('POST', '/api/bookmarks/tags/reorder', { ordered_ids: orderedIds })

// Import / export
export const downloadBookmarksExport = (filename: string) =>
  downloadAuthed('/api/bookmarks/export', filename)
/** Import outcome. `invalid` rows were skipped; `index` is 0-based into the
 *  file's `axis` array, `reason` is 'missing' | 'out_of_range' | 'invalid'. */
export interface BookmarkImportResult {
  imported: number
  skipped_duplicates: number
  invalid: { axis: string; index: number; field: string; reason: string }[]
}
export const importBookmarks = (data: BookmarkStore) =>
  request<BookmarkImportResult>('POST', '/api/bookmarks/import', data)
