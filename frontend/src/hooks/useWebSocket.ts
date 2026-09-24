import { useState, useEffect, useRef, useCallback } from 'react'
import { WS_BASE } from '../lib/constants'

export interface WsMessage {
  type: string
  // Intentionally `unknown` — callers must narrow the payload via
  // a type-guard or equivalent check before reading fields. The server
  // emits ~24 event types (see backend/api/websocket.py); there is no
  // single shape that fits them all.
  data: unknown
}

const WS_URL = WS_BASE
const RECONNECT_INTERVAL = 3000
const MAX_RECONNECT_INTERVAL = 30000
// Backend closes with this code when the auth frame is rejected
// (backend/api/websocket.py `_WS_AUTH_FAIL_CODE`).
const WS_AUTH_FAIL_CODE = 4001

/**
 * WebSocket hook using a subscribe-callback pattern for message delivery.
 *
 * **Why not useState<WsMessage>?** The previous implementation stored each
 * incoming message in a single `lastMessage` useState and let consumers
 * react via `useEffect(..., [lastMessage])`. When two messages arrived in
 * the same microtask (e.g. a stop+route_path pair during mode-switch),
 * React 18 auto-batching coalesced the setStates: the intermediate message
 * was overwritten before the effect fired, so its branch never ran. That
 * dropped events like `state_change(idle)` and left stale route polylines
 * on the map (see issue #5). Subscriber callbacks run synchronously on
 * every onmessage, so no batching can drop a message.
 */
export function useWebSocket() {
  const [connected, setConnected] = useState(false)
  // True after the backend rejected our auth frame (close code 4001), until
  // a later socket is accepted. Usually means the token on disk belongs to a
  // different backend than the one holding the port.
  const [authFailed, setAuthFailed] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const subscribersRef = useRef<Set<(m: WsMessage) => void>>(new Set())
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectDelay = useRef(RECONNECT_INTERVAL)
  const mountedRef = useRef(true)
  // Tracks whether the *current* socket has yielded a server frame yet.
  // We only flip `connected → true` after the server speaks, not after we
  // optimistically send the auth frame — otherwise a half-broken backend
  // (TCP accepts but never replies) would still show "connected" to the UI.
  // Reset on every connect() so each new socket re-proves itself.
  const firstMessageReceivedRef = useRef(false)

  const cleanup = useCallback(() => {
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current)
      reconnectTimer.current = null
    }
  }, [])

  const connect = useCallback(() => {
    if (!mountedRef.current) return
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return

    // Per-socket reset — last connection's "we got a frame" must not count
    // for this one.
    firstMessageReceivedRef.current = false

    try {
      const ws = new WebSocket(WS_URL)
      wsRef.current = ws

      ws.onopen = async () => {
        if (!mountedRef.current) {
          ws.close()
          return
        }
        // Send the auth frame first. In dev mode the token resolves to
        // an empty string and the backend shortcuts the check; in
        // packaged mode the preload bridge resolves it via the
        // `session:get-token` IPC handshake (kept off `process.argv`).
        const bridge = (globalThis as unknown as {
          geoMirage?: { getSessionToken?: () => Promise<unknown> }
        }).geoMirage
        let token = ''
        if (bridge && typeof bridge.getSessionToken === 'function') {
          try {
            const value = await bridge.getSessionToken()
            if (typeof value === 'string') token = value
          } catch {
            // Fall through with empty token; the backend will close the
            // socket and scheduleReconnect() handles the retry.
          }
        }
        // The socket may have been torn down (unmount or remote close)
        // while we awaited the token. Don't send into a dead socket.
        if (!mountedRef.current || ws.readyState !== WebSocket.OPEN) return
        try {
          ws.send(JSON.stringify({ type: 'auth', token }))
        } catch {
          // If the auth frame can't be sent the socket will close shortly
          // anyway; scheduleReconnect() handles the retry.
        }
        // NB: `connected` is intentionally NOT set here. We wait for the
        // backend's first response (initial-state push: cooldown_update +
        // device_snapshot, fired from _send_initial_state) so the UI can
        // distinguish "TCP open" from "live and serving". The backoff is
        // reset there too: a TCP open that the backend then rejects must
        // not snap the retry interval back to 3s.
      }

      ws.onmessage = (event) => {
        if (!mountedRef.current) return
        // Flip `connected → true` on the first server frame after open.
        // We do this before parsing so even an unparseable payload
        // (which proves the peer is alive) flips the state correctly.
        if (!firstMessageReceivedRef.current) {
          firstMessageReceivedRef.current = true
          reconnectDelay.current = RECONNECT_INTERVAL
          setConnected(true)
          setAuthFailed(false)
        }
        try {
          const msg: WsMessage = JSON.parse(event.data)
          // Fan out synchronously: no state, no batching, no drops.
          subscribersRef.current.forEach((fn) => {
            try { fn(msg) } catch { /* subscriber errors shouldn't kill the stream */ }
          })
        } catch {
          // ignore malformed messages
        }
      }

      ws.onclose = (event?: CloseEvent) => {
        if (!mountedRef.current) return
        setConnected(false)
        firstMessageReceivedRef.current = false
        wsRef.current = null
        if (event?.code === WS_AUTH_FAIL_CODE) {
          // Retrying every few seconds cannot fix a token mismatch. Keep a
          // slow retry (a restarted backend writes a new token that the
          // Electron bridge re-reads) and let the UI say why.
          setAuthFailed(true)
          reconnectDelay.current = MAX_RECONNECT_INTERVAL
        }
        scheduleReconnect()
      }

      ws.onerror = () => {
        ws.close()
      }
    } catch {
      scheduleReconnect()
    }
  }, [])

  const scheduleReconnect = useCallback(() => {
    cleanup()
    if (!mountedRef.current) return
    reconnectTimer.current = setTimeout(() => {
      reconnectDelay.current = Math.min(
        reconnectDelay.current * 1.5,
        MAX_RECONNECT_INTERVAL,
      )
      connect()
    }, reconnectDelay.current)
  }, [connect, cleanup])

  const sendMessage = useCallback((type: string, data: Record<string, unknown> = {}) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type, data }))
    }
  }, [])

  /**
   * Subscribe to every incoming WebSocket message. Returns an unsubscribe
   * function. Safe to call from useEffect — stable identity across renders.
   */
  const subscribe = useCallback((fn: (m: WsMessage) => void) => {
    subscribersRef.current.add(fn)
    return () => { subscribersRef.current.delete(fn) }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    connect()
    return () => {
      mountedRef.current = false
      cleanup()
      if (wsRef.current) {
        wsRef.current.onclose = null
        wsRef.current.close()
        wsRef.current = null
      }
      setConnected(false)
    }
  }, [connect, cleanup])

  return { connected, authFailed, subscribe, sendMessage }
}
