import type { BookmarkTag } from '../../types/bookmarks'
import { getTagColor } from '../../lib/bookmarks'

/** Percent of the tag colour mixed into the selected chip's fill. Kept
 *  low enough that `--color-text-1` stays >= 4.5:1 on top of any colour
 *  `getTagColor` can return (see TagChip.test.tsx). */
export const TAG_CHIP_SELECTED_TINT = 30

type TagLike = Pick<BookmarkTag, 'name' | 'color'>

/**
 * Colours for a toggleable tag chip. The tag colour always comes from
 * `getTagColor`, so a tag looks the same here as in BookmarkRow and
 * TagManagerDialog. Selected chips use a dark tint of the tag colour with
 * a full-colour border and light text, instead of white text on a
 * mid-brightness fill.
 */
export function tagChipColors(tag: TagLike, selected: boolean) {
  if (!selected) {
    return {
      background: 'transparent',
      borderColor: 'var(--color-border)',
      color: 'var(--color-text-2)',
    }
  }
  const c = getTagColor(tag)
  return {
    background: `color-mix(in srgb, ${c} ${TAG_CHIP_SELECTED_TINT}%, transparent)`,
    borderColor: c,
    color: 'var(--color-text-1)',
  }
}

interface TagChipProps {
  tag: TagLike
  selected: boolean
  onToggle: () => void
}

/** Toggleable tag chip shared by the bookmarks toolbar and the bookmark
 *  edit dialog. */
export default function TagChip({ tag, selected, onToggle }: TagChipProps) {
  const colors = tagChipColors(tag, selected)
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={selected}
      className="shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs cursor-pointer transition-colors duration-[var(--duration-fast)]"
      style={colors}
    >
      {tag.name}
    </button>
  )
}
