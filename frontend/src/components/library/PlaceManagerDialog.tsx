import { useCallback, useState } from 'react'
import { MapPin, Plus } from 'lucide-react'
import type { BookmarkPlace } from '../../hooks/useBookmarks'
import { ICON_SIZE } from '../../lib/icons'
import { getPlaceColor, isDefaultPlace } from '../../lib/bookmarks'
import { commitTrimmedRename } from '../../lib/rename'
import { useT } from '../../i18n'
import { useToastContext } from '../../contexts/ToastContext'
import { useOptimisticOrder } from '../../hooks/useOptimisticOrder'
import Modal from '../Modal'
import ConfirmDialog from '../ui/ConfirmDialog'
import ReorderableList from '../ui/ReorderableList'
import SortableNameRow from './SortableNameRow'

interface PlaceManagerDialogProps {
  open: boolean
  onClose: () => void
  places: readonly BookmarkPlace[]
  onAdd: (name: string) => void | Promise<void>
  onDelete: (id: string) => void | Promise<void>
  onRename?: (id: string, name: string) => void | Promise<void>
  onReorder?: (orderedIds: string[]) => void | Promise<void>
}

const isDefault = (p: BookmarkPlace) =>
  p.id === 'default' || isDefaultPlace(p.name)

const getPlaceId = (p: BookmarkPlace) => p.id

/**
 * Manage the "place" axis (single-valued per bookmark: where the bookmark
 * is located). Mirrors the Tag manager but for places; the two are kept
 * structurally identical (via SortableNameRow + useOptimisticOrder) so
 * the mental model stays consistent.
 */
export default function PlaceManagerDialog({
  open,
  onClose,
  places,
  onAdd,
  onDelete,
  onRename,
  onReorder,
}: PlaceManagerDialogProps) {
  const t = useT()
  const { showToast } = useToastContext()
  const [newName, setNewName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<BookmarkPlace | null>(null)

  // Persist failure → the hook snaps back to the props order; surface the
  // rollback so the list doesn't just silently rearrange itself.
  const handleReorderError = useCallback(() => {
    showToast(t('toast.reorder_failed'))
  }, [showToast, t])

  const {
    sensors,
    orderedItems: orderedPlaces,
    handleDragEnd,
  } = useOptimisticOrder(places, getPlaceId, onReorder, handleReorderError)

  const commitAdd = useCallback(() => {
    const n = newName.trim()
    if (!n) return
    void onAdd(n)
    setNewName('')
  }, [newName, onAdd])

  const commitRename = useCallback((id: string) => {
    const current = places.find((p) => p.id === id)
    if (onRename) {
      commitTrimmedRename(editingName, current?.name, (n) => onRename(id, n))
    }
    setEditingId(null)
  }, [editingName, places, onRename])

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      dataFc="modal.place-manager"
      ariaLabel={t('bm.manage_places')}
      title={
        <span className="flex items-center gap-2">
          <MapPin width={ICON_SIZE.md} height={ICON_SIZE.md} className="text-[var(--color-accent)]" />
          {t('bm.manage_places')}
        </span>
      }
      actions={
        <button type="button" className="action-btn" onClick={onClose}>
          {t('generic.done')}
        </button>
      }
    >
      <div className="flex flex-col gap-1.5 mt-2 max-h-[320px] overflow-y-auto scrollbar-thin">
        <ReorderableList
          sensors={sensors}
          onDragEnd={handleDragEnd}
          items={orderedPlaces.map((p) => p.id)}
          getLabel={(id) => {
            const place = orderedPlaces.find((p) => p.id === id)
            if (!place) return ''
            return isDefault(place) ? t('bm.default') : place.name
          }}
        >
            {orderedPlaces.map((place) => {
              const editable = !isDefault(place) && !!onRename
              const deletable = !isDefault(place)
              const displayName = isDefault(place) ? t('bm.default') : place.name
              return (
                <SortableNameRow
                  key={place.id}
                  id={place.id}
                  dragDisabled={isDefault(place)}
                  dotColor={getPlaceColor(place.name)}
                  isEditing={editingId === place.id}
                  editingName={editingName}
                  onStartEdit={() => { setEditingId(place.id); setEditingName(place.name) }}
                  onCommitEdit={() => commitRename(place.id)}
                  onChangeEditingName={setEditingName}
                  onCancelEdit={() => setEditingId(null)}
                  renameLabel={t('bm.rename_category')}
                  renamable={editable}
                  onDelete={deletable ? () => setConfirmDelete(place) : undefined}
                >
                  <div className="list-row-title">{displayName}</div>
                </SortableNameRow>
              )
            })}
        </ReorderableList>
      </div>

      <div className="flex gap-2 mt-3">
        <input
          type="text"
          className="search-input flex-1"
          placeholder={t('bm.place_add_placeholder')}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) commitAdd() }}
          style={{ paddingLeft: 10 }}
        />
        <button
          type="button"
          className="action-btn primary"
          disabled={!newName.trim()}
          onClick={commitAdd}
        >
          <Plus width={ICON_SIZE.sm} height={ICON_SIZE.sm} />
          {t('bm.new_category')}
        </button>
      </div>

      <ConfirmDialog
        open={!!confirmDelete}
        title={t('bm.place_delete_title')}
        description={confirmDelete ? t('bm.place_delete_confirm', { name: confirmDelete.name }) : undefined}
        confirmLabel={t('generic.delete')}
        cancelLabel={t('generic.cancel')}
        tone="danger"
        onConfirm={async () => {
          if (confirmDelete) await onDelete(confirmDelete.id)
          setConfirmDelete(null)
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </Modal>
  )
}
