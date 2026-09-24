import { useCallback, useEffect, useState } from 'react'
import { Route as RouteIcon, Save } from 'lucide-react'
import { useRouteLibrary } from '../../contexts/RouteLibraryContext'
import { useSimState } from '../../contexts/SimContext'
import { useToastContext } from '../../contexts/ToastContext'
import { useT } from '../../i18n'
import { ICON_SIZE } from '../../lib/icons'
import Modal from '../Modal'
import RouteOverwriteDialog from './RouteOverwriteDialog'

interface SaveRouteDialogProps {
  open: boolean
  onClose: () => void
}

// Snapshot captured when a same-name conflict is raised, so picking
// "Overwrite" later re-saves exactly what the user saw (mode/waypoints
// can't drift while the confirm prompt is up because the dialog owns them).
interface OverwriteState {
  name: string
  waypoints: { lat: number; lng: number }[]
  moveMode: string
  categoryId: string
  existingCreatedAt: string | null
}

/**
 * Quick "save the current route" dialog launched from the map's right-click
 * menu. Mirrors the RoutesPanel save flow (name + category + same-name
 * overwrite prompt) but inline, so a route just plotted on the map can be
 * banked without opening the Library drawer.
 */
export default function SaveRouteDialog({ open, onClose }: SaveRouteDialogProps) {
  const t = useT()
  const routeLib = useRouteLibrary()
  const { waypoints: simWaypoints, moveMode: simMoveMode } = useSimState()
  const { showToast } = useToastContext()

  const [name, setName] = useState('')
  const [categoryId, setCategoryId] = useState('default')
  const [busy, setBusy] = useState(false)
  const [overwrite, setOverwrite] = useState<OverwriteState | null>(null)

  const waypointsCount = simWaypoints.length

  // Reset transient fields each time the dialog opens.
  useEffect(() => {
    if (!open) return
    setName('')
    setCategoryId('default')
    setBusy(false)
    setOverwrite(null)
  }, [open])

  const saveDisabled = busy || !name.trim() || waypointsCount === 0

  const handleSave = useCallback(async () => {
    const trimmed = name.trim()
    if (!trimmed || simWaypoints.length === 0) return
    const waypoints = simWaypoints.map((w) => ({ lat: w.lat, lng: w.lng }))
    const moveMode = simMoveMode
    setBusy(true)
    // Try `reject` first so a same-name match surfaces the overwrite
    // prompt instead of silently creating a duplicate.
    const result = await routeLib.handleRouteSave(trimmed, waypoints, moveMode, {
      categoryId,
      onConflict: 'reject',
    })
    setBusy(false)
    if (result.kind === 'created' || result.kind === 'overwritten') {
      onClose()
      return
    }
    if (result.kind === 'conflict') {
      setOverwrite({ name: trimmed, waypoints, moveMode, categoryId, existingCreatedAt: result.existingCreatedAt })
    }
    // 'error' — the context already surfaced a toast.
  }, [name, simWaypoints, simMoveMode, routeLib, categoryId, onClose])

  const resolveOverwrite = useCallback(async (policy: 'overwrite' | 'new') => {
    if (!overwrite) return
    const { name: pendingName, waypoints, moveMode, categoryId: pendingCat } = overwrite
    setOverwrite(null)
    setBusy(true)
    const result = await routeLib.handleRouteSave(pendingName, waypoints, moveMode, {
      categoryId: pendingCat,
      onConflict: policy,
    })
    setBusy(false)
    if (result.kind === 'overwritten') showToast(t('toast.route_overwritten', { name: pendingName }))
    if (result.kind !== 'error') onClose()
  }, [overwrite, routeLib, showToast, t, onClose])

  return (
    <>
      <Modal
        open={open && !overwrite}
        onClose={onClose}
        dataFc="modal.save-route"
        busy={busy}
        title={
          <span className="inline-flex items-center gap-2">
            <RouteIcon width={ICON_SIZE.md} height={ICON_SIZE.md} className="text-[var(--color-accent)]" />
            {t('route.quick_save')}
          </span>
        }
        actions={
          <>
            <button type="button" className="action-btn" onClick={onClose} disabled={busy}>
              {t('generic.cancel')}
            </button>
            <button
              type="button"
              className="action-btn primary"
              onClick={() => void handleSave()}
              disabled={saveDisabled}
              title={saveDisabled && waypointsCount === 0 ? t('toast.route_need_waypoint') : t('route.quick_save')}
            >
              <Save width={ICON_SIZE.xs} height={ICON_SIZE.xs} />
              {t('generic.save')}
            </button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <input
            autoFocus
            type="text"
            className="seg-input w-full"
            placeholder={t('panel.route_name')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void handleSave() }}
          />
          {routeLib.routeCategories.length > 1 && (
            <select
              className="seg-input w-full"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              aria-label={t('panel.route_category_manage')}
            >
              {routeLib.routeCategories.map((cat) => (
                <option key={cat.id} value={cat.id}>{cat.name}</option>
              ))}
            </select>
          )}
          <span className="text-[10px] text-[var(--color-text-3)] leading-snug">
            {t('panel.route_save_hint', { n: waypointsCount })}
          </span>
        </div>
      </Modal>

      {/* Same-name conflict — Cancel / Save as new / Overwrite, matching RoutesPanel.
          Cancel drops back to this dialog with the typed name intact. */}
      {overwrite && (
        <RouteOverwriteDialog
          name={overwrite.name}
          existingCreatedAt={overwrite.existingCreatedAt}
          onResolve={(policy) => void resolveOverwrite(policy)}
          onCancel={() => setOverwrite(null)}
        />
      )}
    </>
  )
}
