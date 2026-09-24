import { useCallback, useMemo, useState } from 'react'
import {
  Route as RouteIcon, Save, Pencil, Trash2, FileUp, Upload, Download,
  Folder, FolderInput, GripVertical, ListTree, X,
} from 'lucide-react'
import { useRouteLibrary } from '../../contexts/RouteLibraryContext'
import { useSimActions, useSimState } from '../../contexts/SimContext'
import { useToastContext } from '../../contexts/ToastContext'
import { useT } from '../../i18n'
import { ICON_SIZE } from '../../lib/icons'
import { pickFile } from '../../lib/fileIo'
import ListRow from '../ui/ListRow'
import KebabMenu, { type KebabMenuItem } from '../ui/KebabMenu'
import EmptyState from '../ui/EmptyState'
import ConfirmDialog from '../ui/ConfirmDialog'
import SearchField from '../ui/SearchField'
import ChipFilterBar, { type Chip } from '../ui/ChipFilterBar'
import RouteCategoryManagerDialog from './RouteCategoryManagerDialog'
import InlineRenameInput, { INLINE_RENAME_HEIGHT_PX } from '../ui/InlineRenameInput'
import SortableHandleRow from '../ui/SortableHandleRow'
import ReorderableList from '../ui/ReorderableList'
import { commitTrimmedRename } from '../../lib/rename'
import { useDragReorder } from '../../hooks/useDragReorder'
import { useReorderMode } from '../../hooks/useReorderMode'
import { useSelectionSet } from '../../hooks/useSelectionSet'
import type { SavedRoute } from '../../services/api'
import { ACCENT_HEX, LIBRARY_CHIPS_VISIBLE_CAP } from '../../lib/constants'

interface RoutesPanelProps {
  onRouteLoaded: () => void
}

type SortMode = 'default' | 'name' | 'created' | 'updated'

const ALL_ID = '__all__' as const
// Hex (not a CSS var) because it seeds an <input type="color"> value.
const DEFAULT_CATEGORY_COLOR = ACCENT_HEX

const getRouteId = (r: SavedRoute) => r.id

export default function RoutesPanel({ onRouteLoaded }: RoutesPanelProps) {
  const t = useT()
  const routeLib = useRouteLibrary()
  // `waypoints` / `moveMode` only change identity on actual user edits
  // (never on position ticks), so callbacks below can depend on them
  // directly; `setWaypoints` is a stable action.
  const { waypoints: simWaypoints, moveMode: simMoveMode } = useSimState()
  const { loadRouteWaypoints } = useSimActions()
  const { showToast } = useToastContext()

  const savedRoutes = routeLib.savedRoutes
  const routeCategories = routeLib.routeCategories
  const waypointsCount = simWaypoints.length

  // ─── State ─────────────────────────────────────────────
  const [routeName, setRouteName] = useState('')
  const [saveCategoryId, setSaveCategoryId] = useState<string>('default')
  const [editingRouteId, setEditingRouteId] = useState<string | null>(null)
  const [editingRouteName, setEditingRouteName] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<SavedRoute | null>(null)
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false)
  // ``moveMode`` is captured at the moment the conflict is raised so a
  // mode change while the dialog is open doesn't silently re-stamp the
  // overwrite with the new profile (the user picked Overwrite to keep
  // the existing row's identity, including the originally-saved profile
  // intent).
  const [overwriteDialog, setOverwriteDialog] = useState<null | {
    name: string
    waypoints: { lat: number; lng: number }[]
    categoryId: string
    moveMode: string
    existingCreatedAt: string | null
  }>(null)

  // List controls
  const [search, setSearch] = useState('')
  const [activeCategoryId, setActiveCategoryId] = useState<string>(ALL_ID)
  const [sortMode, setSortMode] = useState<SortMode>('default')
  const {
    selectionMode, selectedIds, toggleSelected,
    enterSelection: enterSelectionMode, exitSelection,
  } = useSelectionSet()

  // Dialogs
  const [categoryMgrOpen, setCategoryMgrOpen] = useState(false)

  // ─── Reorder-mode bookkeeping ─────────────────────────
  // While reorder mode is on, sort is locked to "default" and the
  // category chip to "All" so the drag sequence the user manipulates is
  // the same one persisted on drop; the snapshot is restored on exit.
  const { reorderMode, enterReorderMode, exitReorderMode, cancelReorderMode } = useReorderMode({
    takeSnapshot: () => ({ sort: sortMode, categoryId: activeCategoryId }),
    onEnter: () => {
      setSortMode('default')
      setActiveCategoryId(ALL_ID)
      exitSelection()
    },
    restore: (snapshot) => {
      setSortMode(snapshot.sort)
      setActiveCategoryId(snapshot.categoryId)
    },
  })

  // ─── Filter + sort pipeline ───────────────────────────
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const searching = q.length > 0
    return savedRoutes.filter((r) => {
      if (searching) {
        const name = r.name.toLowerCase()
        if (!name.includes(q)) return false
      } else if (activeCategoryId !== ALL_ID && (r.category_id ?? 'default') !== activeCategoryId) {
        return false
      }
      return true
    })
  }, [savedRoutes, search, activeCategoryId])

  const sorted = useMemo(() => {
    const list = [...filtered]
    switch (sortMode) {
      case 'name':
        return list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      case 'created':
        return list.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
      case 'updated':
        return list.sort((a, b) =>
          (b.updated_at ?? b.created_at ?? '').localeCompare(a.updated_at ?? a.created_at ?? ''),
        )
      case 'default':
      default:
        return list.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    }
  }, [filtered, sortMode])

  // ─── Category chip data ───────────────────────────────
  const categoryChips = useMemo<Chip<string>[]>(() => {
    const counts = new Map<string, number>()
    for (const r of savedRoutes) {
      const k = r.category_id ?? 'default'
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    const chips: Chip<string>[] = [
      { id: ALL_ID, label: t('panel.route_category_all'), count: savedRoutes.length },
    ]
    for (const cat of routeCategories) {
      chips.push({
        id: cat.id,
        label: cat.name,
        color: cat.color,
        count: counts.get(cat.id) ?? 0,
      })
    }
    return chips
  }, [savedRoutes, routeCategories, t])

  // ─── Save (with conflict handling) ────────────────────
  const handleSave = useCallback(async () => {
    const name = routeName.trim()
    if (!name || waypointsCount === 0) return
    const waypoints = simWaypoints
    const moveMode = simMoveMode
    // Always try with `on_conflict=reject` first so a same-name match
    // surfaces the overwrite dialog instead of silently double-saving.
    const result = await routeLib.handleRouteSave(name, waypoints, moveMode, {
      categoryId: saveCategoryId,
      onConflict: 'reject',
    })
    if (result.kind === 'created' || result.kind === 'overwritten') {
      setRouteName('')
      return
    }
    if (result.kind === 'conflict') {
      // Snapshot waypoints + moveMode here — the user may change either
      // (e.g. add a new pin, flip walking→driving) before they pick
      // Overwrite, and we want the second save to reflect what they
      // saw when the dialog appeared.
      setOverwriteDialog({
        name,
        waypoints,
        moveMode,
        categoryId: saveCategoryId,
        existingCreatedAt: result.existingCreatedAt,
      })
    }
    // result.kind === 'error' — toast already shown by the context
  }, [routeName, waypointsCount, simWaypoints, simMoveMode, routeLib, saveCategoryId])

  const resolveOverwrite = useCallback(async (policy: 'overwrite' | 'new') => {
    if (!overwriteDialog) return
    const { name, waypoints, moveMode, categoryId } = overwriteDialog
    setOverwriteDialog(null)
    const result = await routeLib.handleRouteSave(name, waypoints, moveMode, {
      categoryId, onConflict: policy,
    })
    if (result.kind === 'overwritten') {
      showToast(t('toast.route_overwritten', { name }))
    }
    if (result.kind !== 'error') setRouteName('')
  }, [overwriteDialog, routeLib, showToast, t])

  const handleLoad = useCallback((id: string) => {
    if (selectionMode || reorderMode) return
    const loaded = routeLib.handleRouteLoad(id)
    if (loaded) {
      // Stage into the Route (Loop) editor: switching the mode is what
      // makes the loaded route immediately startable — the app previously
      // stayed in Teleport with the waypoints invisible. The saved move
      // profile is deliberately NOT restored: the user's current speed
      // selection wins over whatever mode the route was saved under.
      loadRouteWaypoints(loaded.waypoints)
      // Load had no success feedback (every other route action toasts).
      showToast(t('toast.route_loaded', { name: loaded.name }))
      onRouteLoaded()
    }
  }, [routeLib, loadRouteWaypoints, showToast, t, onRouteLoaded, selectionMode, reorderMode])

  const commitRename = useCallback((routeId: string, currentName: string) => {
    commitTrimmedRename(editingRouteName, currentName, (next) =>
      routeLib.handleRouteRename(routeId, next))
    setEditingRouteId(null)
  }, [editingRouteName, routeLib])

  // ─── Selection mode ───────────────────────────────────
  // Selection and reorder share the leading row slot, so entering
  // selection turns reorder off (without restoring its snapshot).
  const enterSelection = useCallback(() => {
    enterSelectionMode()
    cancelReorderMode()
  }, [enterSelectionMode, cancelReorderMode])

  // ─── Reorder via dnd-kit ──────────────────────────────
  const { sensors, handleDragEnd } = useDragReorder(
    sorted,
    getRouteId,
    routeLib.handleRoutesReorder,
  )

  // ─── Header kebab — bulk + selection + reorder toggles ─
  const headerMenuItems: KebabMenuItem[] = useMemo(() => [
    {
      id: 'gpx-import',
      label: t('panel.route_gpx_import'),
      icon: <FileUp width={ICON_SIZE.sm} height={ICON_SIZE.sm} />,
      onSelect: async () => {
        const f = await pickFile('.gpx,application/gpx+xml')
        if (f) void routeLib.handleGpxImport(f)
      },
    },
    {
      id: 'import-all',
      label: t('panel.routes_import_all'),
      icon: <Upload width={ICON_SIZE.sm} height={ICON_SIZE.sm} />,
      onSelect: async () => {
        const f = await pickFile('.json,application/json')
        if (f) void routeLib.handleRoutesImportAll(f)
      },
    },
    {
      id: 'export-all',
      label: t('panel.routes_export_all'),
      icon: <Download width={ICON_SIZE.sm} height={ICON_SIZE.sm} />,
      disabled: savedRoutes.length === 0,
      onSelect: () => { void routeLib.handleRoutesExportAll() },
    },
    {
      id: 'multi-select',
      label: selectionMode ? t('generic.cancel') : t('panel.route_multi_select'),
      icon: <ListTree width={ICON_SIZE.sm} height={ICON_SIZE.sm} />,
      onSelect: () => { selectionMode ? exitSelection() : enterSelection() },
    },
    {
      id: 'reorder',
      label: reorderMode ? t('generic.cancel') : t('panel.route_reorder_mode'),
      icon: <GripVertical width={ICON_SIZE.sm} height={ICON_SIZE.sm} />,
      onSelect: () => { reorderMode ? exitReorderMode() : enterReorderMode() },
    },
    {
      id: 'manage-cats',
      label: t('panel.route_category_manage'),
      icon: <Folder width={ICON_SIZE.sm} height={ICON_SIZE.sm} />,
      onSelect: () => setCategoryMgrOpen(true),
    },
  ], [t, routeLib, savedRoutes.length, selectionMode, reorderMode, exitSelection, enterSelection, exitReorderMode, enterReorderMode])

  // ─── Row kebab — per-route actions ────────────────────
  const rowMenuItems = useCallback((route: SavedRoute): KebabMenuItem[] => {
    const items: KebabMenuItem[] = [
      {
        id: 'rename', label: t('generic.rename'),
        icon: <Pencil width={ICON_SIZE.sm} height={ICON_SIZE.sm} />,
        onSelect: () => { setEditingRouteId(route.id); setEditingRouteName(route.name) },
      },
      {
        id: 'gpx-export', label: t('route.gpx_export'),
        icon: <Download width={ICON_SIZE.sm} height={ICON_SIZE.sm} />,
        onSelect: () => { void routeLib.handleGpxExport(route.id) },
      },
      {
        id: 'delete', label: t('generic.delete'),
        icon: <Trash2 width={ICON_SIZE.sm} height={ICON_SIZE.sm} />,
        kind: 'danger',
        onSelect: () => setConfirmDelete(route),
      },
    ]
    const otherCats = routeCategories.filter((c) => c.id !== (route.category_id ?? 'default'))
    if (otherCats.length > 0) {
      items.push({ id: 'move-section', kind: 'section', label: t('panel.route_move_to') })
      otherCats.forEach((cat) => {
        items.push({
          id: `move-${cat.id}`,
          label: cat.name,
          icon: <FolderInput width={ICON_SIZE.sm} height={ICON_SIZE.sm} />,
          onSelect: () => { void routeLib.handleRoutesMoveToCategory([route.id], cat.id) },
        })
      })
    }
    return items
  }, [t, routeLib, routeCategories])

  const saveDisabled = !routeName.trim() || waypointsCount === 0
  const searching = search.trim().length > 0

  // ─── Render ───────────────────────────────────────────
  return (
    <div className="flex flex-col gap-3 p-4">
      {/* Save current route — primary action surface */}
      <div className="seg">
        <div className="seg-row">
          <input
            type="text"
            className="seg-input flex-1 text-xs"
            placeholder={t('panel.route_name')}
            value={routeName}
            onChange={(e) => setRouteName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void handleSave() }}
          />
          <select
            className="seg-input text-xs"
            value={saveCategoryId}
            onChange={(e) => setSaveCategoryId(e.target.value)}
            aria-label={t('panel.route_category_manage')}
          >
            {routeCategories.map((cat) => (
              <option key={cat.id} value={cat.id}>{cat.name}</option>
            ))}
          </select>
          <button
            type="button"
            className="action-btn primary text-[11px]"
            disabled={saveDisabled}
            onClick={() => void handleSave()}
            title={saveDisabled ? t('toast.route_need_waypoint') : t('route.quick_save')}
          >
            <Save width={ICON_SIZE.xs} height={ICON_SIZE.xs} />
            {t('generic.save')}
          </button>
          <KebabMenu items={headerMenuItems} ariaLabel={t('route.actions_aria')} />
        </div>
        <div className="seg-row seg-row-compact">
          <span className="text-[10px] text-[var(--color-text-3)]">
            {t('panel.route_save_hint', { n: waypointsCount })}
          </span>
        </div>
      </div>

      {/* Search + sort */}
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <SearchField
            value={search}
            onChange={setSearch}
            placeholder={t('panel.route_search')}
          />
        </div>
        {!reorderMode && (
          <select
            className="seg-input text-xs"
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value as SortMode)}
            aria-label={t('generic.sort')}
            title={t('generic.sort')}
          >
            <option value="default">{t('panel.route_sort_default')}</option>
            <option value="name">{t('panel.route_sort_name')}</option>
            <option value="created">{t('panel.route_sort_created')}</option>
            <option value="updated">{t('panel.route_sort_updated')}</option>
          </select>
        )}
      </div>

      {/* Category chips */}
      {routeCategories.length > 1 && !searching && (
        <ChipFilterBar
          chips={categoryChips}
          activeId={activeCategoryId}
          onChange={setActiveCategoryId}
          visibleCap={LIBRARY_CHIPS_VISIBLE_CAP}
          ariaLabel={t('panel.route_category_manage')}
          moreLabel={t('generic.confirm')}
        />
      )}

      {/* Selection-mode batch toolbar */}
      {selectionMode && (
        <div className="flex items-center gap-2 px-2 py-1 rounded-md bg-[var(--color-bg-2)]">
          <span className="text-[11px] flex-1">
            {selectedIds.size} {t('panel.route_multi_select')}
          </span>
          {routeCategories.length > 1 && (
            <select
              className="seg-input text-xs"
              value=""
              onChange={(e) => {
                const target = e.target.value
                if (!target || selectedIds.size === 0) return
                void routeLib.handleRoutesMoveToCategory(Array.from(selectedIds), target)
                exitSelection()
              }}
              aria-label={t('panel.route_move_to')}
            >
              <option value="">{t('panel.route_move_to')}</option>
              {routeCategories.map((cat) => (
                <option key={cat.id} value={cat.id}>{cat.name}</option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="action-btn danger text-[11px]"
            disabled={selectedIds.size === 0}
            onClick={() => setConfirmBatchDelete(true)}
          >
            <Trash2 width={ICON_SIZE.xs} height={ICON_SIZE.xs} />
            {t('generic.delete')}
          </button>
          <button
            type="button"
            className="action-btn text-[11px]"
            onClick={exitSelection}
            aria-label={t('generic.cancel')}
          >
            <X width={ICON_SIZE.xs} height={ICON_SIZE.xs} />
          </button>
        </div>
      )}

      {/* Route list */}
      {routeLib.routesLoading ? (
        <EmptyState loading />
      ) : sorted.length === 0 ? (
        <EmptyState
          icon={<RouteIcon width={ICON_SIZE.lg} height={ICON_SIZE.lg} />}
          title={t('panel.route_empty')}
        />
      ) : reorderMode ? (
        // Reorder mode: dnd-kit Sortable with explicit drag handles.
        <ReorderableList sensors={sensors} onDragEnd={handleDragEnd} items={sorted.map((r) => r.id)}>
            <div className="flex flex-col gap-1.5">
              {sorted.map((route) => (
                <SortableHandleRow key={route.id} id={route.id}>
                  <ListRow
                    density="compact"
                    title={<span className="truncate">{route.name}</span>}
                    aria-label={route.name}
                    leading={
                      <RouteIcon
                        width={ICON_SIZE.md}
                        height={ICON_SIZE.md}
                        className="text-[var(--color-accent)]"
                      />
                    }
                    meta={
                      <span className="font-mono opacity-75">
                        {t('route.pts_count', { n: route.waypoints.length })}
                      </span>
                    }
                  />
                </SortableHandleRow>
              ))}
            </div>
        </ReorderableList>
      ) : (
        <div className="flex flex-col gap-1.5">
          {sorted.map((route) => {
            const isEditing = editingRouteId === route.id
            const isSelected = selectedIds.has(route.id)
            const titleNode = isEditing ? (
              <InlineRenameInput
                value={editingRouteName}
                onChange={setEditingRouteName}
                onCommit={() => commitRename(route.id, route.name)}
                onCancel={() => setEditingRouteId(null)}
                className="search-input w-full"
                style={{ height: INLINE_RENAME_HEIGHT_PX }}
              />
            ) : (
              <span className="truncate">{route.name}</span>
            )

            return (
              <ListRow
                key={route.id}
                as="button"
                density="compact"
                onClick={() => {
                  if (selectionMode) toggleSelected(route.id)
                  else if (!isEditing) handleLoad(route.id)
                }}
                title={titleNode}
                aria-label={route.name}
                leading={
                  selectionMode ? (
                    <input
                      type="checkbox"
                      checked={isSelected}
                      readOnly
                      tabIndex={-1}
                      aria-hidden="true"
                    />
                  ) : (
                    <RouteIcon
                      width={ICON_SIZE.md}
                      height={ICON_SIZE.md}
                      className="text-[var(--color-accent)]"
                    />
                  )
                }
                meta={
                  <span className="font-mono opacity-75">
                    {t('route.pts_count', { n: route.waypoints.length })}
                  </span>
                }
                trailing={!selectionMode && (
                  <KebabMenu
                    items={() => rowMenuItems(route)}
                    ariaLabel={t('route.row_actions_aria')}
                  />
                )}
              />
            )
          })}
        </div>
      )}

      {/* Confirm — single delete */}
      <ConfirmDialog
        open={!!confirmDelete}
        title={t('route.delete_title')}
        description={confirmDelete ? t('panel.route_delete_confirm', { name: confirmDelete.name }) : undefined}
        confirmLabel={t('generic.delete')}
        cancelLabel={t('generic.cancel')}
        tone="danger"
        onConfirm={async () => {
          if (confirmDelete) await routeLib.handleRouteDelete(confirmDelete.id)
          setConfirmDelete(null)
        }}
        onCancel={() => setConfirmDelete(null)}
      />

      {/* Confirm — batch delete */}
      <ConfirmDialog
        open={confirmBatchDelete}
        title={t('route.delete_title')}
        description={t('panel.route_batch_delete_confirm', { n: selectedIds.size })}
        confirmLabel={t('generic.delete')}
        cancelLabel={t('generic.cancel')}
        tone="danger"
        onConfirm={async () => {
          await routeLib.handleRoutesBatchDelete(Array.from(selectedIds))
          setConfirmBatchDelete(false)
          exitSelection()
        }}
        onCancel={() => setConfirmBatchDelete(false)}
      />

      {/* Same-name overwrite dialog — three-way prompt via ConfirmDialog:
          primary action "Overwrite", secondary "Save as new" (mapped onto
          the cancel button so users on a touch device can dismiss with
          the standard close gesture and still get a sensible default). */}
      {overwriteDialog && (
        <ConfirmDialog
          open
          title={t('panel.route_overwrite_title')}
          description={t('panel.route_overwrite_body', {
            name: overwriteDialog.name,
            created: (overwriteDialog.existingCreatedAt ?? '').slice(0, 10),
          })}
          confirmLabel={t('panel.route_overwrite_btn')}
          cancelLabel={t('panel.route_save_new_btn')}
          tone="default"
          onConfirm={() => void resolveOverwrite('overwrite')}
          onCancel={() => void resolveOverwrite('new')}
        />
      )}

      {/* Category manager */}
      <RouteCategoryManagerDialog
        open={categoryMgrOpen}
        onClose={() => setCategoryMgrOpen(false)}
        categories={routeCategories}
        defaultColor={DEFAULT_CATEGORY_COLOR}
        onCreate={(name, color) => routeLib.handleRouteCategoryCreate(name, color).then(() => undefined)}
        onRename={(id, name) => routeLib.handleRouteCategoryUpdate(id, { name })}
        onRecolor={(id, color) => routeLib.handleRouteCategoryUpdate(id, { color })}
        onDelete={(id) => routeLib.handleRouteCategoryDelete(id)}
        onReorder={(ids) => routeLib.handleRouteCategoriesReorder(ids)}
      />
    </div>
  )
}
