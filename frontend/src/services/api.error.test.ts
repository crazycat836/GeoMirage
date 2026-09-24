import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ApiError, saveRoute, teleport, getStatus, connectDevice } from './api'
import { parseConflictExtras } from '../lib/bookmark_helpers'

/**
 * Regression tests for the API error contract and retry policy.
 *
 * Bug 2.1: `throwEnvelopeError` used to throw a bare `Error` with only a
 * localized message, so BookmarkContext's 409 route-name-conflict branch
 * (which keys on `err.code` / `err.detail`) could never fire and the
 * Overwrite / Save-as-new dialog was unreachable. The envelope error
 * payload must survive on the thrown `ApiError`.
 *
 * Bug 2.5: `fetchWithRetry` used to replay *every* non-abort fetch failure
 * up to 15x — including non-idempotent POSTs whose body may already have
 * reached the backend (double-save / double-teleport). Only GETs may be
 * retried; non-GET failures must fail fast.
 */

/** Wire shape emitted by backend/api/_envelope.py for a 409
 *  ROUTE_NAME_CONFLICT (see backend/api/route.py `save_route`):
 *  http_err() extras are flattened into the `error` dict. */
const CONFLICT_ENVELOPE = {
  success: false,
  data: null,
  error: {
    code: 'route_name_conflict',
    message: 'A route with that name already exists in this category',
    existing_id: 'route-123',
    existing_created_at: '2026-01-02T03:04:05Z',
  },
  meta: null,
}

function envelopeResponse(status: number, statusText: string, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
  } as unknown as Response
}

const SUCCESS_ENVELOPE = { success: true, data: { running: false }, error: null, meta: null }

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ApiError envelope contract (bug 2.1)', () => {
  it('throws ApiError carrying code and raw envelope detail on a 409 conflict', async () => {
    const fetchMock = vi.fn().mockResolvedValue(envelopeResponse(409, 'Conflict', CONFLICT_ENVELOPE))
    vi.stubGlobal('fetch', fetchMock)

    let caught: unknown
    try {
      await saveRoute(
        { name: 'Loop A', waypoints: [{ lat: 25.0, lng: 121.5 }], profile: 'foot', category_id: 'default' },
        'reject',
      )
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(ApiError)
    const apiErr = caught as ApiError
    // BookmarkContext's conflict branch keys on this code.
    expect(apiErr.code).toBe('route_name_conflict')
    // The raw envelope error payload must ride along untouched so
    // parseConflictExtras can pull the existing-route context.
    expect(apiErr.detail).toEqual(CONFLICT_ENVELOPE.error)
    // Localized message stays on .message (Error contract preserved).
    expect(apiErr).toBeInstanceOf(Error)
    expect(typeof apiErr.message).toBe('string')
    expect(apiErr.message.length).toBeGreaterThan(0)
  })

  it('parseConflictExtras fed a thrown ApiError yields the overwrite-dialog payload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(envelopeResponse(409, 'Conflict', CONFLICT_ENVELOPE)))

    let caught: unknown
    try {
      await saveRoute(
        { name: 'Loop A', waypoints: [{ lat: 25.0, lng: 121.5 }], profile: 'foot', category_id: 'default' },
        'reject',
      )
    } catch (err) {
      caught = err
    }

    // Mirrors BookmarkContext.handleRouteSave's detection branch.
    const isConflict = caught instanceof ApiError && caught.code === 'route_name_conflict'
    expect(isConflict).toBe(true)
    expect(parseConflictExtras(caught)).toEqual({
      existingId: 'route-123',
      existingCreatedAt: '2026-01-02T03:04:05Z',
    })
  })

  it('falls back to a plain Error when the response body is not an envelope', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(envelopeResponse(502, 'Bad Gateway', 'proxy says no')))

    await expect(getStatus()).rejects.toThrow('Bad Gateway')
  })
})

describe('fetchWithRetry method gating (bug 2.5)', () => {
  it('does NOT retry a POST whose fetch rejects — fails fast after one attempt', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(teleport(25.0, 121.5)).rejects.toThrow('Failed to fetch')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries a GET whose fetch rejects (boot-time backoff preserved)', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(envelopeResponse(200, 'OK', SUCCESS_ENVELOPE))
    vi.stubGlobal('fetch', fetchMock)

    await expect(getStatus()).resolves.toEqual({ running: false })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  }, 10_000)
})

describe('connect pairing error surfaces the Trust hint', () => {
  it('maps pairing_required to the unlock + Trust message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(envelopeResponse(409, 'Conflict', {
      success: false,
      data: null,
      error: { code: 'pairing_required', message: 'Unlock the iPhone and tap Trust' },
      meta: null,
    })))

    let caught: unknown
    try {
      await connectDevice('u1')
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(ApiError)
    expect((caught as ApiError).code).toBe('pairing_required')
    // Localized text from err.pairing_required (either language) names the Trust prompt.
    expect((caught as ApiError).message).toMatch(/信任這台電腦|Trust This Computer/)
  })
})
