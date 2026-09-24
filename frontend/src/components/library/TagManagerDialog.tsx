import { useCallback, useState } from 'react'
import { Tag as TagIcon } from 'lucide-react'
import type { BookmarkTag } from '../../hooks/useBookmarks'
import { ICON_SIZE } from '../../lib/icons'
import { getTagColor } from '../../lib/bookmarks'
import { commitTrimmedRename } from '../../lib/rename'
import { useT } from '../../i18n'
import { useToastContext } from '../../contexts/ToastContext'
import { useOptimisticOrder } from '../../hooks/useOptimisticOrder'
import Modal from '../Modal'
import ConfirmDialog from '../ui/ConfirmDialog'
import ReorderableList from '../ui/ReorderableList'
import SortableNameRow from './SortableNameRow'

interface TagManagerDialogProps {
  open: boolean
  onClose: () => void
  tags: readonly BookmarkTag[]
  /** Optional — omit to disable deletion entirely (tags-are-fixed mode). */
  onDelete?: (id: string) => void | Promise<void>
  /** Optional — omit to disable rename. */
  onRename?: (id: string, name: string) => void | Promise<void>
  onReorder?: (orderedIds: string[]) => void | Promise<void>
}

// Preset-tag ids seeded by the backend. Kept in lockstep with
// backend/services/bookmarks.py :: _PRESET_TAGS. Preset tags can be renamed
// and reordered but not deleted — the backend's _ensure_presets would
// re-seed them on the next load anyway, and deletion would silently churn
// bookmark tag lists for no user-visible gain.
const PRESET_TAG_IDS = new Set(['preset_scanner', 'preset_mushroom', 'preset_flower'])

const getTagId = (tg: BookmarkTag) => tg.id

/**
 * Manage the "tag" axis (multi-valued per bookmark: what you'll find there).
 *
 * Tags are a fixed vocabulary — the three presets (掃描器 / 菇 / 花) seeded
 * by the backend. This dialog supports rename + reorder only; creation and
 * preset-tag deletion are intentionally absent.
 */
export default function TagManagerDialog({
  open,
  onClose,
  tags,
  onDelete,
  onRename,
  onReorder,
}: TagManagerDialogProps) {
  const t = useT()
  const { showToast } = useToastContext()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<BookmarkTag | null>(null)

  // Persist failure → the hook snaps back to the props order; surface the
  // rollback so the list doesn't just silently rearrange itself.
  const handleReorderError = useCallback(() => {
    showToast(t('toast.reorder_failed'))
  }, [showToast, t])

  const {
    sensors,
    orderedItems: orderedTags,
    handleDragEnd,
  } = useOptimisticOrder(tags, getTagId, onReorder, handleReorderError)

  const commitRename = useCallback((id: string) => {
    const current = tags.find((x) => x.id === id)
    if (onRename) {
      commitTrimmedRename(editingName, current?.name, (n) => onRename(id, n))
    }
    setEditingId(null)
  }, [editingName, tags, onRename])

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      dataFc="modal.tag-manager"
      ariaLabel={t('bm.manage_tags')}
      title={
        <span className="flex items-center gap-2">
          <TagIcon width={ICON_SIZE.md} height={ICON_SIZE.md} className="text-[var(--color-accent)]" />
          {t('bm.manage_tags')}
        </span>
      }
      actions={
        <button type="button" className="action-btn" onClick={onClose}>
          {t('generic.cancel')}
        </button>
      }
    >
      <div className="flex flex-col gap-1.5 mt-2 max-h-[320px] overflow-y-auto scrollbar-thin">
        <ReorderableList
          sensors={sensors}
          onDragEnd={handleDragEnd}
          items={orderedTags.map((tg) => tg.id)}
          getLabel={(id) => orderedTags.find((tg) => tg.id === id)?.name ?? ''}
        >
            {orderedTags.map((tg) => {
              const deletable = !!onDelete && !PRESET_TAG_IDS.has(tg.id)
              return (
                <SortableNameRow
                  key={tg.id}
                  id={tg.id}
                  dotColor={getTagColor(tg)}
                  isEditing={editingId === tg.id}
                  editingName={editingName}
                  onStartEdit={() => { setEditingId(tg.id); setEditingName(tg.name) }}
                  onCommitEdit={() => commitRename(tg.id)}
                  onChangeEditingName={setEditingName}
                  onCancelEdit={() => setEditingId(null)}
                  renameLabel={t('bm.rename_tag')}
                  renamable={!!onRename}
                  onDelete={deletable ? () => setConfirmDelete(tg) : undefined}
                >
                  <div className="list-row-title flex items-center gap-1.5">
                    <span>{tg.name}</span>
                  </div>
                </SortableNameRow>
              )
            })}
        </ReorderableList>
      </div>

      <ConfirmDialog
        open={!!confirmDelete}
        title={t('bm.tag_delete_title')}
        description={confirmDelete ? t('bm.tag_delete_confirm', { name: confirmDelete.name }) : undefined}
        confirmLabel={t('generic.delete')}
        cancelLabel={t('generic.cancel')}
        tone="danger"
        onConfirm={async () => {
          if (confirmDelete && onDelete) await onDelete(confirmDelete.id)
          setConfirmDelete(null)
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </Modal>
  )
}
