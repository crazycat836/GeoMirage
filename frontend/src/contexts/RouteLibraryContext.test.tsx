// @vitest-environment jsdom
// Saved routes and categories are seeded over REST; they must be re-fetched
// each time the WebSocket is accepted so a slow backend start-up doesn't
// leave the library empty for the whole session.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/react'
import { RouteLibraryProvider } from './RouteLibraryContext'
import * as api from '../services/api'

const ws = vi.hoisted(() => ({ epoch: 0 }))
vi.mock('./WebSocketContext', () => ({ useConnectEpoch: () => ws.epoch }))
vi.mock('./ToastContext', () => ({ useToastContext: () => ({ showToast: vi.fn() }) }))
vi.mock('../i18n', () => ({ useT: () => (key: string) => key }))
vi.mock('../lib/dev-log', () => ({ devLog: vi.fn(), devWarn: vi.fn() }))
vi.mock('../services/api', () => ({
  getSavedRoutes: vi.fn().mockResolvedValue([]),
  getRouteCategories: vi.fn().mockResolvedValue([]),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  ws.epoch = 0
})

describe('RouteLibraryProvider WebSocket reconnect', () => {
  it('re-fetches routes and categories each time a socket is accepted', async () => {
    const { rerender } = render(<RouteLibraryProvider><span /></RouteLibraryProvider>)
    await waitFor(() => expect(api.getSavedRoutes).toHaveBeenCalledTimes(1))
    expect(api.getRouteCategories).toHaveBeenCalledTimes(1)

    ws.epoch = 1
    rerender(<RouteLibraryProvider><span /></RouteLibraryProvider>)
    await waitFor(() => expect(api.getSavedRoutes).toHaveBeenCalledTimes(2))
    expect(api.getRouteCategories).toHaveBeenCalledTimes(2)
  })
})
