import type { SavedRoute } from '../services/api'
import type { BookmarkImportResult } from '../services/bookmarkApi'
import type { StringKey } from '../i18n/strings'
import type { Bookmark } from '../types/bookmarks'

// Pure helpers + types lifted out of BookmarkContext so the provider
// stays focused on state + handler wiring.

/** Outcome of `handleRouteSave`. The panel uses this to decide whether
 *  to surface the "overwrite / save as new / cancel" dialog. */
export type SaveRouteResult =
  | { kind: 'created'; route: SavedRoute }
  | { kind: 'overwritten'; route: SavedRoute }
  | {
      kind: 'conflict'
      existingId: string | null
      existingCreatedAt: string | null
    }
  | { kind: 'error'; message: string }

/** Pull the `{existing_id, existing_created_at}` fields out of a 409
 *  conflict response so the conflict dialog can show "saved YYYY-MM-DD"
 *  without a follow-up GET. Defensive against shape drift — every field
 *  is independently checked. */
export function parseConflictExtras(err: unknown): {
  existingId: string | null
  existingCreatedAt: string | null
} {
  const fallback = { existingId: null, existingCreatedAt: null }
  if (typeof err !== 'object' || err === null) return fallback
  const detail = (err as { detail?: unknown }).detail
  if (typeof detail !== 'object' || detail === null) return fallback
  const eid = (detail as Record<string, unknown>).existing_id
  const ets = (detail as Record<string, unknown>).existing_created_at
  return {
    existingId: typeof eid === 'string' ? eid : null,
    existingCreatedAt: typeof ets === 'string' ? ets : null,
  }
}

/** Slugify a route name into a filename-safe stem. Falls back to the
 *  route id when the name has no usable characters left. */
export function safeFilenameStem(name: string, fallback: string): string {
  const cleaned = name.trim().replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_')
  return cleaned || fallback
}

/** Validate a parsed bookmark-store JSON dict has the minimum shape
 *  required for `api.importBookmarks` to accept it. Throws on failure
 *  so callers can show a unified "invalid file" toast. Runtime guard
 *  only — does not narrow the input type because `api.importBookmarks`
 *  takes the wider `BookmarkStore` shape that includes `tags`. */
export function validateBookmarkImport(data: unknown): void {
  if (
    !data ||
    typeof data !== 'object' ||
    !Array.isArray((data as { places?: unknown }).places) ||
    !Array.isArray((data as { bookmarks?: unknown }).bookmarks)
  ) {
    throw new Error('invalid file: missing places or bookmarks array')
  }
}

type Translate = (key: StringKey, vars?: Record<string, string | number>) => string

const IMPORT_REASON_KEYS: Record<string, StringKey> = {
  missing: 'bm.import_reason_missing',
  out_of_range: 'bm.import_reason_out_of_range',
}
const IMPORT_FIELD_KEYS: Record<string, StringKey> = {
  lat: 'bm.import_field_lat',
  lng: 'bm.import_field_lng',
  name: 'bm.import_field_name',
}
const IMPORT_INVALID_ROWS_SHOWN = 3

/** One-line toast for a bookmark import: imported / duplicate / invalid
 *  counts, then up to three bad bookmark rows (1-based) with the reason. */
export function formatBookmarkImportSummary(res: Partial<BookmarkImportResult>, t: Translate): string {
  const imported = res.imported ?? 0
  const skipped = res.skipped_duplicates ?? 0
  const invalid = Array.isArray(res.invalid) ? res.invalid : []
  if (imported === 0 && skipped === 0 && invalid.length === 0) return t('bm.import_none')
  let msg = t('bm.import_summary', { n: imported, dup: skipped, bad: invalid.length })
  const rows = invalid.filter((e) => e.axis === 'bookmarks')
  if (rows.length > 0) {
    const details = rows.slice(0, IMPORT_INVALID_ROWS_SHOWN).map((e) => {
      const fieldKey = IMPORT_FIELD_KEYS[e.field]
      const field = fieldKey ? t(fieldKey) : e.field
      const reason = t(IMPORT_REASON_KEYS[e.reason] ?? 'bm.import_reason_invalid', { field })
      return t('bm.import_invalid_row', { row: e.index + 1, reason })
    })
    const extra = rows.length - IMPORT_INVALID_ROWS_SHOWN
    msg += ` — ${details.join('; ')}${extra > 0 ? ` (+${extra})` : ''}`
  }
  return msg
}

/** Validate a parsed routes-bulk JSON dict has the minimum shape
 *  required for `api.importAllRoutes` to accept it. */
export function validateRoutesImport(data: unknown): void {
  if (!data || typeof data !== 'object' || !Array.isArray((data as { routes?: unknown }).routes)) {
    throw new Error('invalid file: missing routes array')
  }
}

/** Whether any bookmark still lacks a flag and hasn't been looked up yet.
 *  Rows the backend already answered with "no country" are skipped, so a
 *  bookmark in open sea doesn't trigger a backfill on every start. */
export function needsFlagBackfill(bookmarks: readonly Bookmark[]): boolean {
  return bookmarks.some((b) => !b.country_code && !b.flag_checked)
}
