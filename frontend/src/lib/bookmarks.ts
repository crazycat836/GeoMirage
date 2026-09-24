// Shared bookmark / place helpers.
//
// The "Default" place was historically created with one of three names
// depending on which locale seeded it (legacy installs persisted the
// translated literal rather than a stable id). Code that needs to
// special-case it should use `isDefaultPlace` rather than re-asserting
// the literal-string list everywhere — keeps the leak in one place and
// makes it greppable when we eventually unify on an id.
//
// Color derivation for places and tags also lives here (a leaf utility)
// rather than inside the manager dialogs, so every consumer (rows,
// toolbar, panel) depends downward on lib/ instead of importing a pure
// function out of a dialog component.

import type { BookmarkTag } from '../hooks/useBookmarks'

const DEFAULT_PLACE_NAMES = new Set<string>(['預設', 'Default', 'Uncategorized'])

/** True iff `name` is one of the "default place" sentinel literals. */
export function isDefaultPlace(name: string): boolean {
  return DEFAULT_PLACE_NAMES.has(name)
}

/** Place name for display: the default-place sentinels are shown in the
 *  UI language, every other name as the user typed it. */
export function displayPlaceName(name: string, t: (key: 'bm.uncategorized' | 'bm.default') => string): string {
  if (!isDefaultPlace(name)) return name
  return name === 'Uncategorized' ? t('bm.uncategorized') : t('bm.default')
}

// Deterministic colour per place name. Keeps the fixed mappings that
// predate the place/tag split so existing names stay visually stable.
const PLACE_FIXED_COLORS: Record<string, string> = {
  Default: 'var(--color-cat-default)',
  Home: 'var(--color-cat-home)',
  Work: 'var(--color-cat-work)',
  Favorites: 'var(--color-cat-favorites)',
  Custom: 'var(--color-cat-custom)',
}

export function getPlaceColor(name: string): string {
  if (PLACE_FIXED_COLORS[name]) return PLACE_FIXED_COLORS[name]
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
  }
  const hue = Math.abs(hash) % 360
  return `hsl(${hue}, 60%, 55%)`
}

const TAG_FIXED_COLORS: Record<string, string> = {
  '掃描器': '#4A90E2',
  '菇': '#A855F7',
  '花': '#EC4899',
}

export function getTagColor(tag: Pick<BookmarkTag, 'name' | 'color'>): string {
  if (tag.color) return tag.color
  if (TAG_FIXED_COLORS[tag.name]) return TAG_FIXED_COLORS[tag.name]
  let hash = 0
  for (let i = 0; i < tag.name.length; i++) {
    hash = tag.name.charCodeAt(i) + ((hash << 5) - hash)
  }
  const hue = (Math.abs(hash) % 360 + 280) % 360  // bias toward purple/pink range
  return `hsl(${hue}, 58%, 60%)`
}
