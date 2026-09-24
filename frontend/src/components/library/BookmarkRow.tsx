import React from 'react'
import {
  Bookmark as BookmarkIcon, Check, Pencil, StickyNote, Trash2,
} from 'lucide-react'
import type { Bookmark, BookmarkPlace, BookmarkTag } from '../../hooks/useBookmarks'
import { useT } from '../../i18n'
import { ICON_SIZE } from '../../lib/icons'
import { formatCoordDegrees } from '../../lib/format'
import ListRow from '../ui/ListRow'
import KebabMenu, { type KebabMenuItem } from '../ui/KebabMenu'
import InlineRenameInput, { INLINE_RENAME_HEIGHT_PX } from '../ui/InlineRenameInput'
import { getPlaceColor, getTagColor } from '../../lib/bookmarks'

/** Width / left-offset (px) of the accent stripe marking the active row. */
const ACTIVE_INDICATOR_STRIPE_PX = 2

interface BookmarkRowProps {
  bookmark: Bookmark
  placeMap: Map<string, BookmarkPlace>
  tagMap: Map<string, BookmarkTag>
  /** i18n-aware place display name (resolves "Default" / "Uncategorized"). */
  displayPlace: (name: string) => string

  /** Selection mode: leading area becomes a checkbox; click toggles selection. */
  selectionMode: boolean
  checked: boolean
  onToggleSelected: (id: string) => void

  /** Inline rename: orchestrator owns the editing id + draft string. */
  isInlineEditing: boolean
  inlineEditName: string
  onInlineEditChange: (next: string) => void
  onInlineEditCommit: (id: string) => void
  onInlineEditCancel: () => void
  onStartInlineEdit: (b: Bookmark) => void

  /** Lat/lng matches the active map position; row gets an accent stripe. */
  isActive: boolean
  /** Show the copy-confirmation Check flash next to the title. */
  isCopied: boolean

  /** Teleport to the bookmark. Takes the bookmark so the parent can pass
   *  one stable callback to every row. */
  onActivate: (b: Bookmark) => void
  onEdit: (b: Bookmark) => void
  onDelete: (b: Bookmark) => void
  /** Lazy menu builder so the kebab can compute place-move targets per row. */
  rowMenuItems: (b: Bookmark) => KebabMenuItem[]
}

/**
 * One bookmark row in the library list. Pure presentation: orchestrator owns
 * selection / inline-edit / copied state and forwards user intent through
 * callbacks. The row composes `ListRow` and overlays an accent stripe when
 * the bookmark coordinates match the currently-loaded map position.
 */
function BookmarkRowImpl({
  bookmark: b,
  placeMap, tagMap, displayPlace,
  selectionMode, checked, onToggleSelected,
  isInlineEditing, inlineEditName,
  onInlineEditChange, onInlineEditCommit, onInlineEditCancel, onStartInlineEdit,
  isActive, isCopied,
  onActivate, onEdit, onDelete, rowMenuItems,
}: BookmarkRowProps) {
  const t = useT()
  const place = placeMap.get(b.place_id || '')
  const placeName = place?.name || ''
  const placeColor = place ? getPlaceColor(placeName) : 'var(--color-text-3)'
  const bookmarkTags = (b.tags ?? [])
    .map((id) => tagMap.get(id))
    .filter((tg): tg is BookmarkTag => !!tg)

  const leading = selectionMode ? (
    <SelectionTile checked={checked} />
  ) : (
    <PlaceTile color={placeColor} />
  )

  const titleNode = isInlineEditing ? (
    <InlineRenameInput
      value={inlineEditName}
      onChange={onInlineEditChange}
      onCommit={() => onInlineEditCommit(b.id)}
      onCancel={onInlineEditCancel}
      className="search-input w-full"
      style={{ height: INLINE_RENAME_HEIGHT_PX }}
    />
  ) : (
    <>
      <span className="truncate">{b.name}</span>
      {isCopied && (
        <span className="text-[10px] text-[var(--color-success-text)]">
          <Check width={ICON_SIZE.xs} height={ICON_SIZE.xs} />
        </span>
      )}
      {b.note && (
        <StickyNote
          width={ICON_SIZE.xs}
          height={ICON_SIZE.xs}
          className="text-[var(--color-text-3)] opacity-60 shrink-0"
          aria-label={t('bm.has_note')}
        />
      )}
    </>
  )

  const subtitleNode = (
    <span className="inline-flex items-center gap-1.5 min-w-0">
      {place && (
        <span
          className="inline-block uppercase"
          style={{
            padding: '1px 5px',
            background: 'rgba(255,255,255,0.05)',
            borderRadius: '3px',
            fontFamily: 'Geist, ui-sans-serif, system-ui, -apple-system, sans-serif',
            fontSize: '9.5px',
            color: 'var(--color-text-2)',
            fontWeight: 500,
            letterSpacing: '0.03em',
            lineHeight: 1.4,
          }}
        >
          {displayPlace(placeName)}
        </span>
      )}
      {bookmarkTags.map((tag) => (
        <span
          key={tag.id}
          style={{
            padding: '1px 6px',
            background: `color-mix(in srgb, ${getTagColor(tag)} 22%, transparent)`,
            borderRadius: '3px',
            fontSize: '10px',
            color: 'var(--color-text-1)',
            fontWeight: 500,
            lineHeight: 1.4,
            border: `1px solid color-mix(in srgb, ${getTagColor(tag)} 40%, transparent)`,
          }}
        >
          {tag.name}
        </span>
      ))}
      <span className="font-mono truncate">
        {formatCoordDegrees(b)}
      </span>
      {b.country_code && (
        <>
          <span className="text-[var(--color-text-3)] opacity-50">·</span>
          <img
            src={`https://flagcdn.com/w40/${b.country_code}.png`}
            alt={b.country_code.toUpperCase()}
            width={14}
            height={10}
            className="rounded-[2px] shadow-[0_0_0_1px_rgba(255,255,255,0.08)] shrink-0"
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
          />
          {b.country && <span className="truncate max-w-[80px]">{b.country}</span>}
        </>
      )}
    </span>
  )

  const trailing = selectionMode ? undefined : (
    <span className="inline-flex items-center gap-1">
      <HoverAction
        onClick={(e) => { e.stopPropagation(); onEdit(b) }}
        label={t('bm.edit')}
      >
        <Pencil width={ICON_SIZE.xs} height={ICON_SIZE.xs} />
      </HoverAction>
      <HoverAction
        onClick={(e) => { e.stopPropagation(); onDelete(b) }}
        label={t('generic.delete')}
        danger
      >
        <Trash2 width={ICON_SIZE.xs} height={ICON_SIZE.xs} />
      </HoverAction>
      <KebabMenu
        items={() => rowMenuItems(b)}
        ariaLabel={t('bm.bookmark_actions')}
      />
    </span>
  )

  return (
    <div className="relative">
      {isActive && (
        <span
          aria-hidden="true"
          className="absolute top-[14px] bottom-[14px] rounded-[2px]"
          style={{
            left: ACTIVE_INDICATOR_STRIPE_PX,
            width: ACTIVE_INDICATOR_STRIPE_PX,
            background: 'var(--color-accent)',
          }}
        />
      )}
      <ListRow
        as="button"
        density="compact"
        className={['group', isActive ? 'pl-4' : ''].join(' ')}
        selected={(selectionMode && checked) || isActive}
        onClick={() => {
          if (selectionMode) onToggleSelected(b.id)
          else if (!isInlineEditing) onActivate(b)
        }}
        onDoubleClick={(e) => {
          if (selectionMode) return
          e.preventDefault()
          onStartInlineEdit(b)
        }}
        onContextMenu={(e) => {
          if (selectionMode || isInlineEditing) return
          e.preventDefault()
          const kebab = (e.currentTarget as HTMLElement)
            .querySelector<HTMLButtonElement>('.list-row-trailing .kebab-btn')
          kebab?.click()
        }}
        aria-label={b.name}
        aria-pressed={selectionMode ? checked : undefined}
        leading={leading}
        title={titleNode}
        subtitle={subtitleNode}
        trailing={trailing}
      />
    </div>
  )
}

// Memoized so the parent's per-render scroll / search / selection-mode
// state changes don't repaint every row when the row's own props are
// referentially stable. The parent passes useMemo-derived placeMap /
// tagMap / displayPlace + useCallback handlers, so memo's default
// shallow compare suffices.
const BookmarkRow = React.memo(BookmarkRowImpl)
export default BookmarkRow

interface SelectionTileProps {
  checked: boolean
}

function SelectionTile({ checked }: SelectionTileProps) {
  return (
    <span
      aria-hidden="true"
      className="w-9 h-9 rounded-[10px] border flex items-center justify-center shrink-0"
      style={{
        borderColor: checked ? 'var(--color-accent)' : 'var(--color-border-strong)',
        background: checked ? 'var(--color-accent)' : 'rgba(255,255,255,0.02)',
      }}
    >
      {checked && (
        <Check width={ICON_SIZE.sm} height={ICON_SIZE.sm} className="text-white" strokeWidth={3} />
      )}
    </span>
  )
}

interface PlaceTileProps {
  color: string
}

function PlaceTile({ color }: PlaceTileProps) {
  return (
    <span
      aria-hidden="true"
      className="w-9 h-9 rounded-[10px] grid place-items-center shrink-0"
      style={{
        background: `linear-gradient(135deg, color-mix(in srgb, ${color} 22%, transparent), color-mix(in srgb, ${color} 6%, transparent))`,
        border: `1px solid color-mix(in srgb, ${color} 32%, transparent)`,
        color,
      }}
    >
      <BookmarkIcon width={ICON_SIZE.md} height={ICON_SIZE.md} strokeWidth={2} />
    </span>
  )
}

interface HoverActionProps {
  onClick: (e: React.MouseEvent) => void
  label: string
  danger?: boolean
  children: React.ReactNode
}

function HoverAction({ onClick, label, danger, children }: HoverActionProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={[
        'w-7 h-7 rounded-[7px] grid place-items-center shrink-0',
        'border border-[var(--color-border)] bg-white/[0.04]',
        'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
        'translate-x-1 group-hover:translate-x-0 focus-visible:translate-x-0',
        'transition-[opacity,transform,background,color,border-color] duration-150',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]',
        danger
          ? 'text-[var(--color-text-3)] hover:text-[var(--color-danger-text)] hover:bg-[var(--color-danger-dim)] hover:border-[rgba(255,71,87,0.3)]'
          : 'text-[var(--color-text-3)] hover:text-[var(--color-text-1)] hover:bg-white/[0.1]',
      ].join(' ')}
    >
      {children}
    </button>
  )
}
