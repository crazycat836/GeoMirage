import { useCallback, useState } from 'react'
import { Plus, Pencil, Trash2, Check, X, GripVertical } from 'lucide-react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import Modal from '../Modal'
import ConfirmDialog from '../ui/ConfirmDialog'
import ListRow from '../ui/ListRow'
import InlineRenameInput, { INLINE_RENAME_HEIGHT_PX } from '../ui/InlineRenameInput'
import ReorderableList from '../ui/ReorderableList'
import { ICON_SIZE } from '../../lib/icons'
import { commitTrimmedRename } from '../../lib/rename'
import { useDragReorder } from '../../hooks/useDragReorder'
import { useT } from '../../i18n'
import type { RouteCategory } from '../../services/api'

interface RouteCategoryManagerDialogProps {
  open: boolean
  onClose: () => void
  categories: readonly RouteCategory[]
  defaultColor: string
  onCreate: (name: string, color: string) => Promise<void>
  onRename: (id: string, name: string) => Promise<void>
  onRecolor: (id: string, color: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onReorder: (orderedIds: string[]) => Promise<void>
}

// "default" is the immutable preset bucket — its name belongs to the
// schema and the backend rejects delete attempts, so the UI hides the
// destructive controls for it rather than letting the user discover the
// 400 from the API.
const DEFAULT_CATEGORY_ID = 'default'

const getCategoryId = (c: RouteCategory) => c.id

export default function RouteCategoryManagerDialog(props: RouteCategoryManagerDialogProps) {
  const t = useT()
  const { open, onClose, categories, defaultColor } = props

  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState(defaultColor)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<RouteCategory | null>(null)

  const { sensors, handleDragEnd } = useDragReorder(
    categories,
    getCategoryId,
    props.onReorder,
  )

  const handleCreate = useCallback(async () => {
    const name = newName.trim()
    if (!name) return
    await props.onCreate(name, newColor)
    setNewName('')
    setNewColor(defaultColor)
  }, [newName, newColor, props, defaultColor])

  const commitRename = useCallback((id: string, currentName: string) => {
    setEditingId(null)
    commitTrimmedRename(editingName, currentName, (next) => props.onRename(id, next))
  }, [editingName, props])

  return (
    <>
      <Modal open={open} onClose={onClose} title={t('panel.route_category_manage')} dataFc="modal.route-category-manager">
        <div className="flex flex-col gap-3 p-4 min-w-[320px]">
          {/* New category form */}
          <div className="flex items-center gap-2">
            <input
              type="text"
              className="seg-input flex-1 text-xs"
              placeholder={t('panel.route_category_new')}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) void handleCreate()
              }}
            />
            <input
              type="color"
              className="w-8 h-8 rounded border border-[var(--color-border)] cursor-pointer"
              value={newColor}
              onChange={(e) => setNewColor(e.target.value)}
              aria-label={t('generic.color')}
            />
            <button
              type="button"
              className="action-btn primary text-[11px]"
              disabled={!newName.trim()}
              onClick={() => void handleCreate()}
            >
              <Plus width={ICON_SIZE.xs} height={ICON_SIZE.xs} />
            </button>
          </div>

          {/* Category list with drag-reorder. The preset "default" row
              participates in the visual list (so users see what's there)
              but its rename / delete / drag controls are disabled. */}
          <ReorderableList
            sensors={sensors}
            onDragEnd={handleDragEnd}
            items={categories.map((c) => c.id)}
            getLabel={(id) => categories.find((c) => c.id === id)?.name ?? ''}
          >
              <div className="flex flex-col gap-1.5 max-h-[340px] overflow-auto">
                {categories.map((cat) => (
                  <SortableCategoryRow
                    key={cat.id}
                    category={cat}
                    isEditing={editingId === cat.id}
                    editingName={editingName}
                    onEditStart={() => { setEditingId(cat.id); setEditingName(cat.name) }}
                    onEditChange={setEditingName}
                    onEditCommit={() => commitRename(cat.id, cat.name)}
                    onEditCancel={() => setEditingId(null)}
                    onRecolor={(c) => void props.onRecolor(cat.id, c)}
                    onDeleteRequest={() => setConfirmDelete(cat)}
                  />
                ))}
              </div>
          </ReorderableList>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!confirmDelete}
        title={t('panel.route_category_delete_title')}
        description={confirmDelete ? t('panel.route_category_delete_confirm', { name: confirmDelete.name }) : undefined}
        confirmLabel={t('generic.delete')}
        cancelLabel={t('generic.cancel')}
        tone="danger"
        onConfirm={async () => {
          if (confirmDelete) await props.onDelete(confirmDelete.id)
          setConfirmDelete(null)
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </>
  )
}

// ── Sortable row ─────────────────────────────────────
// Not SortableHandleRow: the preset "default" row needs a disabled
// (greyed, non-draggable) handle, and the color swatch + rename/delete
// buttons live outside the row body — the DOM differs from the shared
// panel wrapper, and CSS depends on these exact classNames.
interface SortableCategoryRowProps {
  category: RouteCategory
  isEditing: boolean
  editingName: string
  onEditStart: () => void
  onEditChange: (next: string) => void
  onEditCommit: () => void
  onEditCancel: () => void
  onRecolor: (color: string) => void
  onDeleteRequest: () => void
}

function SortableCategoryRow(props: SortableCategoryRowProps) {
  const {
    category, isEditing, editingName, onEditStart, onEditChange,
    onEditCommit, onEditCancel, onRecolor, onDeleteRequest,
  } = props
  const t = useT()
  const isDefault = category.id === DEFAULT_CATEGORY_ID
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: category.id,
    disabled: isDefault,
  })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.55 : 1,
  }

  return (
    <div ref={setNodeRef} style={style} className="flex items-center gap-1.5">
      <button
        type="button"
        className="cursor-grab active:cursor-grabbing px-1 text-[var(--color-text-3)] hover:text-[var(--color-text-1)] disabled:opacity-30 disabled:cursor-not-allowed"
        disabled={isDefault}
        aria-label={t('generic.drag_handle')}
        {...(isDefault ? {} : attributes)}
        {...(isDefault ? {} : listeners)}
      >
        <GripVertical width={ICON_SIZE.sm} height={ICON_SIZE.sm} />
      </button>
      <input
        type="color"
        className="w-6 h-6 rounded border border-[var(--color-border)] cursor-pointer"
        value={category.color}
        onChange={(e) => onRecolor(e.target.value)}
        aria-label={t('generic.color')}
      />
      <div className="flex-1 min-w-0">
        <ListRow
          density="compact"
          title={
            isEditing ? (
              <InlineRenameInput
                value={editingName}
                onChange={onEditChange}
                onCommit={onEditCommit}
                onCancel={onEditCancel}
                className="search-input w-full"
                style={{ height: INLINE_RENAME_HEIGHT_PX }}
              />
            ) : (
              <span className="truncate">{category.name}</span>
            )
          }
          aria-label={category.name}
        />
      </div>
      <button
        type="button"
        className="action-btn text-[11px]"
        onClick={isEditing ? onEditCommit : onEditStart}
        disabled={isDefault}
        aria-label={t('generic.rename')}
      >
        {isEditing ? (
          <Check width={ICON_SIZE.xs} height={ICON_SIZE.xs} />
        ) : (
          <Pencil width={ICON_SIZE.xs} height={ICON_SIZE.xs} />
        )}
      </button>
      <button
        type="button"
        className="action-btn danger text-[11px]"
        onClick={onDeleteRequest}
        disabled={isDefault}
        aria-label={t('generic.delete')}
      >
        <Trash2 width={ICON_SIZE.xs} height={ICON_SIZE.xs} />
      </button>
      {isEditing && (
        <button
          type="button"
          className="action-btn text-[11px]"
          onClick={onEditCancel}
          aria-label={t('generic.cancel')}
        >
          <X width={ICON_SIZE.xs} height={ICON_SIZE.xs} />
        </button>
      )}
    </div>
  )
}
