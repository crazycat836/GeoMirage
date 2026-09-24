import React from 'react'
import {
  Clock, ListTree, Tag as TagIconLucide, Trash2, X,
} from 'lucide-react'
import { useT } from '../../i18n'
import { ICON_SIZE } from '../../lib/icons'
import type { BookmarkTag } from '../../hooks/useBookmarks'
import SearchField from '../ui/SearchField'
import ChipFilterBar, { type Chip } from '../ui/ChipFilterBar'
import KebabMenu, { type KebabMenuItem } from '../ui/KebabMenu'
import TagChip from '../ui/TagChip'

export type SortMode = 'recent' | 'by_place'

interface BookmarksToolbarProps {
  /** Live search text — controlled. */
  search: string
  onSearchChange: (next: string) => void

  /** Place chip selection (single). `__all__` shows everything. */
  placeChips: Chip<string>[]
  activePlaceId: string
  onActivePlaceChange: (id: string) => void
  placeChipsVisibleCap: number
  hasPlaces: boolean

  /** Tag filter (multi-select, AND). */
  tags: BookmarkTag[]
  activeTagIds: Set<string>
  onToggleTag: (id: string) => void
  onClearTags: () => void

  /** Sort toggle — shown only when there are bookmarks and not searching. */
  sortMode: SortMode
  onSortModeChange: (next: SortMode) => void
  hasBookmarks: boolean

  /** Selection-mode batch bar (count + clear + delete + exit). */
  selectionMode: boolean
  selectedCount: number
  onClearSelection: () => void
  onConfirmBatchDelete: () => void
  onExitSelection: () => void

  /** Header kebab menu (add custom, bulk import, toggle selection). */
  headerMenuItems: KebabMenuItem[]
}

/**
 * Top controls of the bookmarks panel: search field + header kebab,
 * place chips, tag filter row, sort toggle, and the batch-selection bar.
 *
 * State is owned by the orchestrator; this component is purely presentational
 * and forwards user intent through callbacks.
 */
export default function BookmarksToolbar(props: BookmarksToolbarProps) {
  const t = useT()
  const {
    search, onSearchChange,
    placeChips, activePlaceId, onActivePlaceChange, placeChipsVisibleCap, hasPlaces,
    tags, activeTagIds, onToggleTag, onClearTags,
    sortMode, onSortModeChange, hasBookmarks,
    selectionMode, selectedCount, onClearSelection, onConfirmBatchDelete, onExitSelection,
    headerMenuItems,
  } = props

  const searching = search.trim().length > 0

  return (
    <>
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <SearchField
            value={search}
            onChange={onSearchChange}
            placeholder={t('bm.search_placeholder')}
            clearLabel={t('bm.search_clear')}
          />
        </div>
        <KebabMenu items={headerMenuItems} ariaLabel={t('bm.bookmark_actions_aria')} />
      </div>

      {/* Place chip filter — hidden while searching. Primary axis. */}
      {!searching && hasPlaces && (
        <ChipFilterBar
          chips={placeChips}
          activeId={activePlaceId}
          onChange={onActivePlaceChange}
          ariaLabel={t('bm.place_filter_aria')}
          moreLabel={t('generic.more')}
          visibleCap={placeChipsVisibleCap}
        />
      )}

      {/* Tag chip filter — secondary axis, multi-select, AND. Hidden while
          searching (search already looks inside tag names). */}
      {!searching && tags.length > 0 && (
        <TagFilterRow
          tags={tags}
          activeTagIds={activeTagIds}
          onToggleTag={onToggleTag}
          onClearTags={onClearTags}
        />
      )}

      {/* Sort toggle. `by_place` preserves the sectioned view when no filter
          is applied; `recent` always flattens the list. Hidden for empty. */}
      {hasBookmarks && !searching && (
        <div className="flex items-center gap-1 text-[11px]">
          <span className="text-[var(--color-text-3)] mr-1">{t('generic.sort')}:</span>
          <SortChip
            active={sortMode === 'by_place'}
            onClick={() => onSortModeChange('by_place')}
            icon={<ListTree width={12} height={12} />}
            label={t('bm.sort_by_place')}
          />
          <SortChip
            active={sortMode === 'recent'}
            onClick={() => onSortModeChange('recent')}
            icon={<Clock width={12} height={12} />}
            label={t('bm.sort_recent')}
          />
        </div>
      )}

      {selectionMode && (
        <BatchBar
          selectedCount={selectedCount}
          onClearSelection={onClearSelection}
          onConfirmBatchDelete={onConfirmBatchDelete}
          onExitSelection={onExitSelection}
        />
      )}
    </>
  )
}

interface TagFilterRowProps {
  tags: BookmarkTag[]
  activeTagIds: Set<string>
  onToggleTag: (id: string) => void
  onClearTags: () => void
}

function TagFilterRow({ tags, activeTagIds, onToggleTag, onClearTags }: TagFilterRowProps) {
  const t = useT()
  return (
    <div
      role="toolbar"
      aria-label={t('bm.tag_filter_aria')}
      className="flex items-center gap-1.5 overflow-x-auto scrollbar-thin"
      style={{ paddingBottom: 2 }}
    >
      <TagIconLucide width={12} height={12} className="text-[var(--color-text-3)] shrink-0" />
      {tags.map((tag) => (
        <TagChip
          key={tag.id}
          tag={tag}
          selected={activeTagIds.has(tag.id)}
          onToggle={() => onToggleTag(tag.id)}
        />
      ))}
      {activeTagIds.size > 0 && (
        <button
          type="button"
          onClick={onClearTags}
          className="kebab-btn"
          aria-label={t('bm.clear_tag_filter')}
          title={t('bm.clear_tag_filter')}
          style={{ flexShrink: 0 }}
        >
          <X width={12} height={12} />
        </button>
      )}
    </div>
  )
}

interface BatchBarProps {
  selectedCount: number
  onClearSelection: () => void
  onConfirmBatchDelete: () => void
  onExitSelection: () => void
}

function BatchBar({
  selectedCount,
  onClearSelection,
  onConfirmBatchDelete,
  onExitSelection,
}: BatchBarProps) {
  const t = useT()
  const empty = selectedCount === 0
  return (
    <div className="batch-bar" role="toolbar" aria-label={t('bm.selection_toolbar')}>
      <span className="batch-bar-count">{t('bm.selected_count', { n: selectedCount })}</span>
      <button
        type="button"
        className="action-btn"
        disabled={empty}
        onClick={onClearSelection}
      >
        {t('bm.clear_selection')}
      </button>
      <button
        type="button"
        className="action-btn danger"
        disabled={empty}
        onClick={onConfirmBatchDelete}
      >
        <Trash2 width={ICON_SIZE.sm} height={ICON_SIZE.sm} />
        {t('generic.delete')}
      </button>
      <button
        type="button"
        className="kebab-btn"
        aria-label={t('bm.select_cancel')}
        title={t('bm.select_cancel')}
        onClick={onExitSelection}
      >
        <X width={ICON_SIZE.sm} height={ICON_SIZE.sm} />
      </button>
    </div>
  )
}

interface SortChipProps {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
}

function SortChip({ active, onClick, icon, label }: SortChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="inline-flex items-center gap-1"
      style={{
        padding: '2px 8px',
        borderRadius: 999,
        border: `1px solid ${active ? 'var(--color-accent)' : 'var(--color-border)'}`,
        background: active ? 'color-mix(in srgb, var(--color-accent) 20%, transparent)' : 'transparent',
        color: active ? 'var(--color-text-1)' : 'var(--color-text-3)',
        fontSize: 10.5,
        cursor: 'pointer',
        transition: 'all var(--duration-fast, 150ms) ease',
      }}
    >
      {icon}
      {label}
    </button>
  )
}
