import { describe, it, expect } from 'vitest'
import { formatBookmarkImportSummary, needsFlagBackfill } from './bookmark_helpers'
import { translate } from '../i18n'
import type { StringKey } from '../i18n/strings'

const t = (key: StringKey, vars?: Record<string, string | number>) => translate('en', key, vars)

describe('formatBookmarkImportSummary', () => {
  it('says nothing new when every row was a duplicate, with the skipped count', () => {
    expect(formatBookmarkImportSummary({ imported: 0, skipped_duplicates: 5, invalid: [] }, t))
      .toBe('Imported 0 · skipped 5 duplicate(s) · 0 invalid')
  })

  it('names the bad rows (1-based) and why', () => {
    const msg = formatBookmarkImportSummary({
      imported: 2,
      skipped_duplicates: 0,
      invalid: [
        { axis: 'bookmarks', index: 1, field: 'lat', reason: 'missing' },
        { axis: 'bookmarks', index: 2, field: 'lat', reason: 'out_of_range' },
      ],
    }, t)
    expect(msg).toBe('Imported 2 · skipped 0 duplicate(s) · 2 invalid — row 2: missing latitude; row 3: latitude out of range')
  })

  it('lists at most three bad rows', () => {
    const invalid = [0, 1, 2, 3, 4].map((i) => ({ axis: 'bookmarks', index: i, field: 'name', reason: 'invalid' }))
    const msg = formatBookmarkImportSummary({ imported: 0, skipped_duplicates: 0, invalid }, t)
    expect(msg).toContain('row 3: invalid name')
    expect(msg).not.toContain('row 4')
    expect(msg).toContain('(+2)')
  })

  it('falls back to the plain "nothing imported" line for an empty file', () => {
    expect(formatBookmarkImportSummary({ imported: 0, skipped_duplicates: 0, invalid: [] }, t))
      .toBe('No new bookmarks imported')
  })

  it('tolerates an older backend that only returns imported', () => {
    expect(formatBookmarkImportSummary({ imported: 3 }, t)).toBe('Imported 3 · skipped 0 duplicate(s) · 0 invalid')
  })
})

describe('needsFlagBackfill', () => {
  const base = { id: 'a', name: 'A', lat: 0, lng: 0, place_id: 'default', tags: [] }

  it('is true for a row with no flag that was never looked up', () => {
    expect(needsFlagBackfill([{ ...base, country_code: '' }])).toBe(true)
  })

  it('skips rows the backend already answered with "no country"', () => {
    expect(needsFlagBackfill([{ ...base, country_code: '', flag_checked: true }])).toBe(false)
  })

  it('is false when every row has a flag', () => {
    expect(needsFlagBackfill([{ ...base, country_code: 'jp' }])).toBe(false)
  })
})
