import React, { createContext, useContext, useState, useCallback, useEffect, useMemo } from 'react'
import * as api from '../services/api'
import type { SavedRoute, RouteCategory, RouteConflictPolicy } from '../services/api'
import { useToastContext } from './ToastContext'
import { useConnectEpoch } from './WebSocketContext'
import { useT } from '../i18n'
import { devLog } from '../lib/dev-log'
import { useSerializedReorder } from '../hooks/useSerializedReorder'
import {
  parseConflictExtras,
  safeFilenameStem,
  validateRoutesImport,
  type SaveRouteResult,
} from '../lib/bookmark_helpers'

// Re-export so route consumers (`RoutesPanel`, etc.) can import
// `SaveRouteResult` alongside the hook.
export type { SaveRouteResult }

interface RouteLibraryContextValue {
  // Saved routes
  savedRoutes: readonly SavedRoute[]
  /** True until the initial saved-routes fetch settles — panels use it to
   *  show a loading state instead of a premature "empty". */
  routesLoading: boolean
  refreshRoutes: () => Promise<void>
  handleRouteLoad: (id: string) => {
    waypoints: { lat: number; lng: number }[]
    profile?: string
    name: string
  } | null
  handleRouteSave: (
    name: string,
    waypoints: { lat: number; lng: number }[],
    moveMode: string,
    options?: {
      categoryId?: string
      onConflict?: RouteConflictPolicy
    },
  ) => Promise<SaveRouteResult>
  handleRouteRename: (id: string, name: string) => Promise<void>
  handleRouteDelete: (id: string) => Promise<void>
  handleRoutesBatchDelete: (ids: string[]) => Promise<void>
  handleRoutesMoveToCategory: (ids: string[], targetCategoryId: string) => Promise<void>
  handleRoutesReorder: (orderedIds: string[]) => Promise<void>

  // Route categories
  routeCategories: readonly RouteCategory[]
  handleRouteCategoryCreate: (name: string, color: string) => Promise<RouteCategory | null>
  handleRouteCategoryUpdate: (id: string, patch: { name?: string; color?: string }) => Promise<void>
  handleRouteCategoryDelete: (id: string) => Promise<void>
  handleRouteCategoriesReorder: (orderedIds: string[]) => Promise<void>

  // GPX
  handleGpxImport: (file: File) => Promise<void>
  handleGpxExport: (id: string) => Promise<void>

  // Bulk route import/export
  handleRoutesImportAll: (file: File) => Promise<void>
  handleRoutesExportAll: () => Promise<void>
}

const RouteLibraryContext = createContext<RouteLibraryContextValue | null>(null)

export function RouteLibraryProvider({ children }: { children: React.ReactNode }) {
  const t = useT()
  const { showToast } = useToastContext()

  const [savedRoutes, setSavedRoutes] = useState<SavedRoute[]>([])
  const [routeCategories, setRouteCategories] = useState<RouteCategory[]>([])
  const [routesLoading, setRoutesLoading] = useState(true)
  const connectEpoch = useConnectEpoch()

  // Fetch on mount and again each time the WebSocket is accepted: the mount
  // fetch gives up while the backend is still starting (packaged macOS app
  // waits on the password dialog), and a restarted backend should be
  // re-read. Deliberately not keyed on `t` (a language change would
  // re-create it).
  useEffect(() => {
    api.getSavedRoutes()
      .then(setSavedRoutes)
      .catch((err) => {
        devLog('Failed to load saved routes', err)
        showToast(t('toast.routes_load_failed'))
      })
      .finally(() => setRoutesLoading(false))
    api.getRouteCategories().then(setRouteCategories).catch((err) => devLog('Failed to load route categories', err))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectEpoch])

  const handleRouteLoad = useCallback((id: string): {
    waypoints: { lat: number; lng: number }[]
    profile?: string
    name: string
  } | null => {
    const route = savedRoutes.find((r) => r.id === id)
    if (!route || !Array.isArray(route.waypoints)) return null
    // Return the saved move profile too so the caller can restore the
    // walking/driving speed the route was built with — previously dropped,
    // so a "driving" route replayed at the current (often walking) speed.
    return {
      waypoints: (route.waypoints as { lat: number; lng: number }[]).map((w) => ({
        lat: w.lat,
        lng: w.lng,
      })),
      profile: route.profile,
      name: route.name,
    }
  }, [savedRoutes])

  // Re-fetch the saved-route list and push it through state. Every
  // mutation handler below funnels through here so the cache shape +
  // sort order is identical regardless of which path triggered the
  // refresh. Errors are logged and re-thrown so callers' existing
  // try/catch blocks can surface the right toast.
  const refreshRoutes = useCallback(async () => {
    try {
      const routes = await api.getSavedRoutes()
      setSavedRoutes(routes)
    } catch (err) {
      devLog('Failed to refresh saved routes', err)
      throw err
    }
  }, [])

  // parseConflictExtras / safeFilenameStem / validateRoutesImport live in
  // lib/bookmark_helpers.ts so this provider stays focused on the
  // state-machine + handlers shape.

  const handleRouteSave = useCallback(async (
    name: string,
    waypoints: { lat: number; lng: number }[],
    moveMode: string,
    options?: { categoryId?: string; onConflict?: RouteConflictPolicy },
  ): Promise<SaveRouteResult> => {
    if (waypoints.length === 0) {
      showToast(t('toast.route_need_waypoint'))
      return { kind: 'error', message: t('toast.route_need_waypoint') }
    }
    const policy = options?.onConflict ?? 'new'
    try {
      const saved = await api.saveRoute(
        {
          name,
          waypoints,
          profile: moveMode,
          category_id: options?.categoryId ?? 'default',
        },
        policy,
      )
      await refreshRoutes()
      // "overwritten" is inferred when the caller asked for that policy
      // and the request succeeded — the backend doesn't ship the action
      // separately to keep the response shape `SavedRoute`.
      const kind = policy === 'overwrite' ? 'overwritten' : 'created'
      if (kind === 'created') showToast(t('toast.route_saved', { name }))
      return { kind, route: saved }
    } catch (err: unknown) {
      // The /api endpoint returns 409 + route_name_conflict when policy
      // is "reject" and a duplicate exists. api.ts surfaces that as an
      // ApiError carrying the envelope's `code` plus the raw error
      // payload on `.detail` (existing_id / existing_created_at).
      if (err instanceof api.ApiError && err.code === 'route_name_conflict') {
        const { existingId, existingCreatedAt } = parseConflictExtras(err)
        return { kind: 'conflict', existingId, existingCreatedAt }
      }
      const message = err instanceof Error ? err.message : ''
      showToast(t('toast.save_failed', { msg: message }))
      return { kind: 'error', message }
    }
  }, [refreshRoutes, showToast, t, parseConflictExtras])

  const handleRouteRename = useCallback(async (id: string, name: string) => {
    try {
      await api.renameRoute(id, name)
      await refreshRoutes()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('toast.rename_failed')
      showToast(message)
    }
  }, [refreshRoutes, showToast, t])

  const handleRouteDelete = useCallback(async (id: string) => {
    try {
      await api.deleteRoute(id)
      await refreshRoutes()
      showToast(t('toast.route_deleted'))
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('toast.route_delete_failed')
      showToast(message)
    }
  }, [refreshRoutes, showToast, t])

  const handleRoutesBatchDelete = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return
    try {
      const res = await api.batchDeleteRoutes(ids)
      await refreshRoutes()
      showToast(t('toast.routes_batch_deleted', { n: res.deleted }))
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : ''
      showToast(t('toast.routes_batch_delete_failed', { msg: message }))
    }
  }, [refreshRoutes, showToast, t])

  const handleRoutesMoveToCategory = useCallback(async (ids: string[], targetCategoryId: string) => {
    if (ids.length === 0) return
    try {
      const res = await api.moveRoutesToCategory(ids, targetCategoryId)
      await refreshRoutes()
      showToast(t('toast.routes_moved', { n: res.moved }))
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : ''
      showToast(t('toast.routes_move_failed', { msg: message }))
    }
  }, [refreshRoutes, showToast, t])

  // Toast on persist failure, then rethrow so useSerializedReorder's
  // devLog + refresh (rollback) still run — standardizes route reorders
  // on the rollback + toast convention the other mutation handlers use.
  const postRoutesReorder = useCallback(async (orderedIds: string[]) => {
    try {
      await api.reorderRoutes(orderedIds)
    } catch (err: unknown) {
      showToast(t('toast.reorder_failed'))
      throw err
    }
  }, [showToast, t])

  // Stable handler; latest refreshRoutes is picked up via the hook's
  // internal ref. See useSerializedReorder for the in-flight/queue rationale.
  const handleRoutesReorder = useSerializedReorder(
    postRoutesReorder, refreshRoutes, 'reorderRoutes failed',
  )

  // ── Route categories ────────────────────────────────────
  const refreshRouteCategories = useCallback(async () => {
    try {
      const cats = await api.getRouteCategories()
      setRouteCategories(cats)
    } catch (err) {
      devLog('Failed to refresh route categories', err)
    }
  }, [])

  const handleRouteCategoryCreate = useCallback(
    async (name: string, color: string): Promise<RouteCategory | null> => {
      const trimmed = name.trim()
      if (!trimmed) return null
      try {
        const cat = await api.createRouteCategory(trimmed, color)
        await refreshRouteCategories()
        return cat
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : ''
        showToast(t('toast.save_failed', { msg: message }))
        return null
      }
    },
    [refreshRouteCategories, showToast, t],
  )

  const handleRouteCategoryUpdate = useCallback(
    async (id: string, patch: { name?: string; color?: string }) => {
      try {
        await api.updateRouteCategory(id, patch)
        await refreshRouteCategories()
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : ''
        showToast(t('toast.save_failed', { msg: message }))
      }
    },
    [refreshRouteCategories, showToast, t],
  )

  const handleRouteCategoryDelete = useCallback(async (id: string) => {
    try {
      await api.deleteRouteCategory(id)
      // Routes pointing at the deleted category server-side fall back to
      // "default" — re-fetch both so the UI's local view matches.
      await Promise.all([refreshRouteCategories(), refreshRoutes()])
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : ''
      showToast(t('toast.save_failed', { msg: message }))
    }
  }, [refreshRouteCategories, refreshRoutes, showToast, t])

  const handleRouteCategoriesReorder = useCallback(async (orderedIds: string[]) => {
    try {
      await api.reorderRouteCategories(orderedIds)
      await refreshRouteCategories()
    } catch (err) {
      devLog('reorderRouteCategories failed', err)
      // Rollback (re-fetch the server order) + toast — the snap-back used
      // to be silent while every sibling mutation handler toasts.
      await refreshRouteCategories()
      showToast(t('toast.reorder_failed'))
    }
  }, [refreshRouteCategories, showToast, t])

  const handleGpxImport = useCallback(async (file: File) => {
    try {
      const res = await api.importGpx(file)
      await refreshRoutes()
      showToast(t('toast.gpx_imported', { n: res.points }))
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : ''
      showToast(t('toast.gpx_import_failed', { msg: message }))
    }
  }, [refreshRoutes, showToast, t])

  const handleGpxExport = useCallback(async (id: string) => {
    const route = savedRoutes.find((r) => r.id === id)
    const stem = safeFilenameStem(route?.name ?? '', id)
    try {
      await api.downloadGpx(id, `${stem}.gpx`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : ''
      showToast(t('toast.export_failed', { msg: message }))
    }
  }, [savedRoutes, showToast, t])

  const handleRoutesExportAll = useCallback(async () => {
    try {
      await api.downloadAllRoutes('geomirage-routes.json')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : ''
      showToast(t('toast.export_failed', { msg: message }))
    }
  }, [showToast, t])

  const handleRoutesImportAll = useCallback(async (file: File) => {
    try {
      const text = await file.text()
      const data = JSON.parse(text)
      validateRoutesImport(data)
      // Send the whole file so the backend can rebuild its categories.
      const res = await api.importAllRoutes(data)
      const routes = await api.getSavedRoutes()
      setSavedRoutes(routes)
      await refreshRouteCategories()
      showToast(t('toast.routes_imported', { n: res.imported }))
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : ''
      showToast(t('toast.routes_import_failed', { msg: message }))
    }
  }, [showToast, t, refreshRouteCategories])

  // Memoize so consumers don't re-render on every provider re-render.
  // Each member is a useCallback / stable state value, so the value
  // identity only changes when something real does.
  const value: RouteLibraryContextValue = useMemo(() => ({
    savedRoutes,
    routesLoading,
    refreshRoutes,
    handleRouteLoad,
    handleRouteSave,
    handleRouteRename,
    handleRouteDelete,
    handleRoutesBatchDelete,
    handleRoutesMoveToCategory,
    handleRoutesReorder,

    routeCategories,
    handleRouteCategoryCreate,
    handleRouteCategoryUpdate,
    handleRouteCategoryDelete,
    handleRouteCategoriesReorder,

    handleGpxImport,
    handleGpxExport,

    handleRoutesImportAll,
    handleRoutesExportAll,
  }), [
    savedRoutes, routesLoading, refreshRoutes, handleRouteLoad, handleRouteSave,
    handleRouteRename, handleRouteDelete, handleRoutesBatchDelete,
    handleRoutesMoveToCategory, handleRoutesReorder,
    routeCategories, handleRouteCategoryCreate, handleRouteCategoryUpdate,
    handleRouteCategoryDelete, handleRouteCategoriesReorder,
    handleGpxImport, handleGpxExport,
    handleRoutesImportAll, handleRoutesExportAll,
  ])

  return (
    <RouteLibraryContext.Provider value={value}>
      {children}
    </RouteLibraryContext.Provider>
  )
}

export function useRouteLibrary() {
  const ctx = useContext(RouteLibraryContext)
  if (!ctx) throw new Error('useRouteLibrary must be used within RouteLibraryProvider')
  return ctx
}
