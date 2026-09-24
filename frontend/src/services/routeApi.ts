/**
 * Saved-route endpoints (`/api/route/*`): routes, categories, drag-reorder,
 * GPX import/export, and bulk JSON import/export.
 */
import { API_BASE } from '../lib/constants'
import { request, authedFetch, unwrapEnvelope, downloadAuthed, type StatusResponse } from './http'

/** Stored route payload shared by RoutesPanel and the library flows. */
export interface SavedRoute {
  id: string
  name: string
  waypoints: { lat: number; lng: number }[]
  created_at?: string
  /** OSRM profile / movement mode (e.g. "foot", "car"). Sent by
   *  `saveRoute` and stored by the backend. */
  profile?: string
  /** Added in route-store v1; legacy rows back-fill to "default". */
  category_id?: string
  /** Mirrors created_at on first save; bumped on rename/move/overwrite. */
  updated_at?: string
  /** Explicit drag-reorder position; legacy rows default to 0. */
  sort_order?: number
}

/** Route bucket — mirrors BookmarkPlace shape on purpose so the
 *  category-strip component can be shared. */
export interface RouteCategory {
  id: string
  name: string
  color: string
  sort_order: number
  created_at: string
}

/** Saved-route conflict policy mirroring backend `ConflictPolicy`. */
export type RouteConflictPolicy = 'new' | 'overwrite' | 'reject'

// Routes
export const getSavedRoutes = () => request<SavedRoute[]>('GET', '/api/route/saved')
export const saveRoute = (
  route: Omit<SavedRoute, 'id' | 'created_at' | 'updated_at' | 'sort_order'>,
  onConflict: RouteConflictPolicy = 'new',
) => request<SavedRoute>('POST', `/api/route/saved?on_conflict=${onConflict}`, route)
export const deleteRoute = (id: string) => request<StatusResponse>('DELETE', `/api/route/saved/${id}`)
export const renameRoute = (id: string, name: string) => request<SavedRoute>('PATCH', `/api/route/saved/${id}`, { name })
export const batchDeleteRoutes = (routeIds: string[]) =>
  request<{ deleted: number }>('POST', '/api/route/saved/batch-delete', { route_ids: routeIds })
export const moveRoutesToCategory = (routeIds: string[], targetCategoryId: string) =>
  request<{ moved: number }>('POST', '/api/route/saved/move', {
    route_ids: routeIds, target_category_id: targetCategoryId,
  })

// Route categories (v0.2.133)
export const getRouteCategories = () =>
  request<RouteCategory[]>('GET', '/api/route/saved/categories')
export const createRouteCategory = (name: string, color: string) =>
  request<RouteCategory>('POST', '/api/route/saved/categories', { name, color })
export const updateRouteCategory = (id: string, patch: { name?: string; color?: string }) =>
  request<RouteCategory>('PUT', `/api/route/saved/categories/${id}`, patch)
export const deleteRouteCategory = (id: string) =>
  request<StatusResponse>('DELETE', `/api/route/saved/categories/${id}`)

// Waypoint-order optimization (OSRM /table + nearest-neighbor + 2-opt).
// `closed` optimises a round trip back to waypoint 0 (Loop mode).
export const optimizeRoute = (
  waypoints: { lat: number; lng: number }[],
  profile: string,
  closed: boolean,
) =>
  request<{ order: number[]; waypoints: { lat: number; lng: number }[]; total_seconds: number }>(
    'POST', '/api/route/optimize', { waypoints, profile, closed },
  )

// Drag-reorder
export const reorderRoutes = (orderedIds: string[]) =>
  request<{ reordered: number }>('POST', '/api/route/saved/reorder', { ordered_ids: orderedIds })
export const reorderRouteCategories = (orderedIds: string[]) =>
  request<{ reordered: number }>(
    'POST', '/api/route/saved/categories/reorder', { ordered_ids: orderedIds },
  )

// GPX import/export
export async function importGpx(file: File): Promise<{ status: string; id: string; points: number }> {
  // Rebuild FormData per attempt — `authedFetch` may retry on 401 and
  // a consumed body cannot be replayed safely.
  const res = await authedFetch(`${API_BASE}/api/route/gpx/import`, (headers) => {
    const form = new FormData()
    form.append('file', file)
    return { method: 'POST', body: form, headers }
  })
  return unwrapEnvelope<{ status: string; id: string; points: number }>(res)
}

export const downloadGpx = (routeId: string, filename: string) =>
  downloadAuthed(`/api/route/gpx/export/${encodeURIComponent(routeId)}`, filename)

// Bulk JSON export / import for saved routes
export const downloadAllRoutes = (filename: string) =>
  downloadAuthed('/api/route/saved/export', filename)

/** Body of an export file. `version` / `categories` are missing from
 *  older exports; the backend still accepts those. */
export interface RoutesImportPayload {
  version?: number
  categories?: RouteCategory[]
  routes: SavedRoute[]
}

export const importAllRoutes = (data: RoutesImportPayload) =>
  request<{ imported: number }>('POST', '/api/route/saved/import', data)
