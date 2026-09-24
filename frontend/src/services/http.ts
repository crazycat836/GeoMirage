/**
 * Transport core for the API client. Holds the retry/timeout policy,
 * session-token cache, and the standard response-envelope unwrapping that
 * every per-domain module (deviceApi, locationApi, bookmarkApi, routeApi,
 * geocodeApi, systemApi) builds on. App code should import from the
 * `services/api` barrel rather than this module.
 */
import { STORAGE_KEYS } from '../lib/storage-keys'
import {
  API_BASE,
  REQUEST_TIMEOUT_MS,
  RETRY_BACKOFF_INITIAL_MS,
  RETRY_BACKOFF_MAX_MS,
  RETRY_BACKOFF_STEP_MS,
} from '../lib/constants'
import { devWarn } from '../lib/dev-log'
import { STRINGS } from '../i18n/strings'

/** Envelope used by most action endpoints (connect, teleport, etc.). */
export interface StatusResponse {
  status: string
  [key: string]: unknown
}

const API = API_BASE

// Connection-refused means backend isn't up yet, retry with backoff —
// but ONLY for GETs. Other HTTP errors (4xx/5xx) are real errors and
// propagate immediately.
//
// Non-GET requests (POST/PUT/PATCH/DELETE) are never retried: a connection
// reset after the body was sent leaves us unable to tell whether the backend
// already applied the action, and replaying it could double-apply a
// teleport/connect/save/import. They fail fast on the first error instead.
//
// Each attempt is bounded by REQUEST_TIMEOUT_MS via an AbortController so a
// backend that accepts the socket but never answers can't hang the call
// forever. A timeout is treated differently from connection-refused: it is
// NOT retried either, for the same non-idempotency reason.
/** Per-call override of the GET retry count and per-attempt timeout. Used by
 *  user-initiated calls that should fail fast (e.g. a manual device scan)
 *  instead of riding out ~25 s of retries. */
export interface RetryPolicy {
  maxAttempts?: number
  timeoutMs?: number
}

async function fetchWithRetry(url: string, opts: RequestInit, policy?: RetryPolicy): Promise<Response> {
  const maxAttempts = policy?.maxAttempts ?? 15
  const timeoutMs = policy?.timeoutMs ?? REQUEST_TIMEOUT_MS
  // `fetch` defaults to GET when no method is given.
  const isRetryable = (opts.method ?? 'GET').toUpperCase() === 'GET'
  let lastErr: unknown
  for (let i = 0; i < maxAttempts; i++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await fetch(url, { ...opts, signal: controller.signal })
    } catch (e) {
      lastErr = e
      // Our own timeout fired: surface it immediately rather than retrying.
      if (e instanceof DOMException && e.name === 'AbortError') {
        throw new Error('Request timed out')
      }
      // Non-idempotent request: the backend may already have received the
      // body, so replaying is unsafe. Surface the original error as-is.
      if (!isRetryable) throw e
      const delay = Math.min(
        RETRY_BACKOFF_INITIAL_MS + i * RETRY_BACKOFF_STEP_MS,
        RETRY_BACKOFF_MAX_MS,
      )
      await new Promise((r) => setTimeout(r, delay))
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastErr ?? new Error('fetch failed')
}

// Latched once when localStorage throws so the navigator-language fallback
// path doesn't silently hide a sandboxed-storage misconfiguration in dev.
//
// Test isolation: this module-level latch persists across `currentLang()`
// calls within a single Vitest module run; tests that need to assert the
// warning fires more than once should reset module state via vi.resetModules()
// between cases.
let warnedLocalStorage = false

function currentLang(): 'zh' | 'en' {
  try {
    const v = localStorage.getItem(STORAGE_KEYS.lang)
    if (v === 'en' || v === 'zh') return v
  } catch (e) {
    if (!warnedLocalStorage) {
      warnedLocalStorage = true
      devWarn('[http.currentLang] localStorage unavailable, falling back to navigator.language', e)
    }
  }
  return (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('zh')) ? 'zh' : 'en'
}

/** Structured error returned in the response envelope. */
interface EnvelopeError {
  code?: string
  message?: string
}

/**
 * Error thrown for non-ok responses that carried the standard envelope.
 *
 * Keeps the localized human-readable text on `.message` (so existing
 * `err.message` toasts keep working) while preserving the machine-readable
 * contract callers branch on:
 *
 * - `code` — the backend `ErrorCode` value (see backend/api/_errors.py),
 *   e.g. `'route_name_conflict'` for the 409 route-save conflict.
 * - `detail` — the raw envelope `error` payload as shipped on the wire,
 *   including any extras the endpoint attached (`existing_id`,
 *   `existing_created_at`, …) flattened in by `http_err(**extra)`.
 *
 * BookmarkContext's overwrite/save-as-new dialog depends on both.
 */
export class ApiError extends Error {
  readonly code: string | undefined
  /** Raw envelope `error` payload (`{code, message, ...extras}`). */
  readonly detail: Record<string, unknown> | undefined

  constructor(
    message: string,
    code: string | undefined,
    detail: Record<string, unknown> | undefined,
  ) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.detail = detail
  }
}

/** Standard `{success, data, error, meta}` envelope per
 * `~/.claude/rules/common/patterns.md`. Every JSON response from the
 * backend is wrapped in this shape; `request()` unwraps `data` so
 * callers see only the inner type they asked for. */
interface ApiEnvelope<T> {
  success: boolean
  data: T | null
  error: EnvelopeError | null
  meta?: { total?: number; page?: number; limit?: number } | null
}

function isEnvelope(body: unknown): body is ApiEnvelope<unknown> {
  return (
    body !== null &&
    typeof body === 'object' &&
    'success' in body &&
    'data' in body &&
    'error' in body
  )
}

function formatError(error: unknown, fallback: string): string {
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const e = error as EnvelopeError
    if (e.code) {
      // Look up `err.<code>` in the central translation table — single
      // source of truth for both UI strings and backend-error messages.
      const key = `err.${e.code}` as keyof typeof STRINGS
      const entry = STRINGS[key] as { zh?: string; en?: string } | undefined
      if (entry) {
        return entry[currentLang()] ?? entry.zh ?? entry.en ?? fallback
      }
    }
    if (e.message) return e.message
  }
  return fallback
}

/**
 * Throw a structured `ApiError` from a non-ok response. The localized
 * message goes on `.message`; the envelope's machine-readable `code` and
 * raw `error` payload ride along so callers can branch on them (e.g. the
 * 409 route_name_conflict overwrite dialog). Falls back to a plain Error
 * with the bare HTTP status when no envelope is present. Reads the body
 * once; always throws (hence `Promise<never>`).
 */
async function throwEnvelopeError(res: Response): Promise<never> {
  const parsed: unknown = await res.json().catch(() => null)
  if (isEnvelope(parsed)) {
    const detail = (parsed.error && typeof parsed.error === 'object')
      ? parsed.error as Record<string, unknown>
      : undefined
    const code = typeof detail?.code === 'string' ? detail.code : undefined
    throw new ApiError(formatError(parsed.error, res.statusText), code, detail)
  }
  // Backend should always emit the envelope; this branch only fires if a
  // proxy / dev-server intercepts the response and returns its own body.
  throw new Error(res.statusText || `HTTP ${res.status}`)
}

/**
 * Unwrap a JSON envelope response's `data`. Throws the structured error on
 * a non-ok status, or a "missing envelope" error on a 200 with a non-API
 * body (proxy hit or backend older than this client). Reads the body at
 * most once per call.
 */
export async function unwrapEnvelope<T>(res: Response): Promise<T> {
  if (!res.ok) return throwEnvelopeError(res)
  const parsed: unknown = await res.json().catch(() => null)
  if (!isEnvelope(parsed) || parsed.success !== true) {
    throw new Error('Malformed API response (missing envelope)')
  }
  return parsed.data as T
}

/**
 * Read the session auth token. In the packaged Electron build the token
 * is held by the main process and fetched once via the
 * `session:get-token` IPC handshake (see frontend/electron/preload.js
 * and frontend/electron/main.js). The bridge exposes it as the async
 * `window.geoMirage.getSessionToken()`. In Vite dev mode the
 * backend is expected to run with GEOMIRAGE_DEV_NOAUTH=1, so when
 * the bridge is absent we resolve to an empty string — empty token is
 * accepted by the dev backend.
 *
 * The first call performs the IPC round-trip; subsequent calls return
 * the cached promise so the token isn't refetched on every request.
 * The cache is invalidated on a 401 response (see `authedFetch`) so a
 * rotated session token is picked up automatically without a reload.
 */
// Test isolation: this cache is a module-level singleton. Tests that need
// to exercise multiple bridge states must reset it via vi.resetModules() or
// `invalidateAuthToken()` (used in production by the 401 handler) between cases.
let authTokenPromise: Promise<string> | null = null

function getAuthToken(): Promise<string> {
  if (authTokenPromise) return authTokenPromise
  const bridge = (globalThis as unknown as {
    geoMirage?: { getSessionToken?: () => Promise<unknown> }
  }).geoMirage
  if (!bridge || typeof bridge.getSessionToken !== 'function') {
    authTokenPromise = Promise.resolve('')
    return authTokenPromise
  }
  authTokenPromise = bridge
    .getSessionToken()
    .then((value) => (typeof value === 'string' ? value : ''))
    .catch(() => '')
  return authTokenPromise
}

/** Force the next `getAuthToken()` call to re-fetch from the bridge. */
function invalidateAuthToken(): void {
  authTokenPromise = null
}

/**
 * Issue a fetch with the current session token attached. If the server
 * answers 401 we drop the cached token, fetch a fresh one, and retry
 * exactly once. A second 401 (e.g. wrong shared secret) propagates to
 * the caller as a normal error response — no infinite retry loop.
 *
 * `buildInit` is invoked per attempt so callers that need fresh request
 * bodies / FormData per try can rebuild them. The argument receives the
 * headers object pre-populated with `X-GPS-Token` so the caller only
 * needs to layer on its own (e.g. `Content-Type`).
 */
export async function authedFetch(
  url: string,
  buildInit: (headers: Record<string, string>) => RequestInit,
  retry?: RetryPolicy,
): Promise<Response> {
  const attempt = async (): Promise<Response> => {
    const headers: Record<string, string> = {}
    const token = await getAuthToken()
    if (token) headers['X-GPS-Token'] = token
    return fetchWithRetry(url, buildInit(headers), retry)
  }
  const res = await attempt()
  if (res.status !== 401) return res
  invalidateAuthToken()
  return attempt()
}

/** Outcome of one `request()` call, as reported to the request observer. */
export interface RequestOutcome {
  method: string
  path: string
  /** HTTP status; undefined when the request never got a response. */
  status: number | undefined
  ok: boolean
  /** Backend `ErrorCode` when the call failed with an envelope error. */
  code: string | undefined
  ms: number
}

let requestObserver: ((outcome: RequestOutcome) => void) | null = null

/**
 * Register a single observer notified after every `request()` settles.
 * Used by the local usage log (`services/usage.ts`); it never sees request
 * or response bodies. Pass `null` to detach.
 */
export function setRequestObserver(fn: ((outcome: RequestOutcome) => void) | null): void {
  requestObserver = fn
}

/**
 * JSON request against the backend: attaches the session token, applies the
 * GET-only retry policy, and unwraps the standard response envelope.
 */
export async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
  retry?: RetryPolicy,
): Promise<T> {
  const started = Date.now()
  let status: number | undefined
  let code: string | undefined
  let ok = false
  try {
    const res = await authedFetch(`${API}${path}`, (headers) => {
      headers['Content-Type'] = 'application/json'
      if (extraHeaders) Object.assign(headers, extraHeaders)
      const opts: RequestInit = { method, headers }
      if (body !== undefined) opts.body = JSON.stringify(body)
      return opts
    }, retry)
    status = res.status
    const data = await unwrapEnvelope<T>(res)
    ok = true
    return data
  } catch (e) {
    if (e instanceof ApiError) code = e.code
    throw e
  } finally {
    requestObserver?.({ method, path, status, ok, code, ms: Date.now() - started })
  }
}

/**
 * Download an authenticated GET as a file. Goes through `authedFetch`
 * so the `X-GPS-Token` header is attached and stale-token retry kicks
 * in — `<a href>` / `window.open` cannot do either, so the URL-only
 * helpers we used to expose 401'd silently and the user got a blank
 * tab. The Blob URL is revoked once the click is dispatched so we
 * don't leak per-export memory.
 */
export async function downloadAuthed(path: string, filename: string): Promise<void> {
  const res = await authedFetch(`${API}${path}`, (headers) => ({ method: 'GET', headers }))
  // Error path surfaces the structured envelope (or bare status); the
  // success path reads the body as a Blob, not JSON, so we can't go
  // through unwrapEnvelope here.
  if (!res.ok) await throwEnvelopeError(res)
  const blob = await res.blob()
  const blobUrl = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = blobUrl
    a.download = filename
    a.rel = 'noopener'
    a.click()
  } finally {
    URL.revokeObjectURL(blobUrl)
  }
}
