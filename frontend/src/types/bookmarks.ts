/**
 * Bookmark domain models shared by the services layer (`services/bookmarkApi`)
 * and the hooks layer (`hooks/useBookmarks`). Lives in a neutral module so
 * neither layer has to import the other for types (the old
 * services → hooks type import created a services↔hooks cycle).
 */

// Dual-axis model:
//   place_id — single "where" (富士山, 寺廟, default)
//   tags     — multi "what"  (掃描器, 菇, 花)
export interface Bookmark {
  id: string
  name: string
  lat: number
  lng: number
  place_id: string
  tags: string[]
  note?: string
  created_at?: string
  last_used_at?: string
  // Auto-filled by the backend on create/update via reverse geocoding.
  // Empty string for legacy rows until /backfill-flags runs.
  country_code?: string
  country?: string
  // True once the backfill got a definitive "no country" answer (open sea),
  // so the lookup isn't repeated every session.
  flag_checked?: boolean
  // Explicit drag-reorder position; back-fills to 0 on legacy rows.
  sort_order?: number
}

export interface BookmarkPlace {
  id: string
  name: string
  color?: string
  sort_order?: number
}

export interface BookmarkTag {
  id: string
  name: string
  color?: string
  sort_order?: number
}
