import React, { createContext, useContext } from 'react'
import { useWebSocket } from '../hooks/useWebSocket'

// Single owner of the backend WebSocket connection.
//
// `useWebSocket()` opens exactly one socket, attaches reconnect logic,
// and exposes a fan-out subscriber. Putting it in a context lets every
// consumer (DeviceProvider, ConnectionHealthProvider, SimProvider)
// share the same socket without prop-drilling `subscribe` /
// `sendMessage` / `connected` through the tree.
//
// Rule: there must be exactly one `<WebSocketProvider>` mounted at any
// time. A second provider would open a second socket; the backend
// supports that, but `connected` / event ordering would diverge between
// the two contexts and consumers would silently observe inconsistent
// state.

type WsContextValue = ReturnType<typeof useWebSocket>

const WebSocketContext = createContext<WsContextValue | null>(null)

export function WebSocketProvider({ children }: { children: React.ReactNode }) {
  const ws = useWebSocket()
  return <WebSocketContext.Provider value={ws}>{children}</WebSocketContext.Provider>
}

/**
 * Bumped each time a socket is accepted (the first connect included).
 * Providers that seed state over REST put it in effect deps to re-fetch
 * after the backend comes (back) up. Returns 0 outside a provider so
 * isolated tests of those providers need no socket.
 */
export function useConnectEpoch(): number {
  return useContext(WebSocketContext)?.connectEpoch ?? 0
}

export function useWebSocketContext(): WsContextValue {
  const ctx = useContext(WebSocketContext)
  if (!ctx) throw new Error('useWebSocketContext must be used within WebSocketProvider')
  return ctx
}
