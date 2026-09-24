import React, { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { useDeviceContext } from './DeviceContext'
import { useWebSocketContext } from './WebSocketContext'
import { useBackendPhase } from '../hooks/useBackendPhase'
import {
  deriveConnectionHealth,
  OFFLINE_THRESHOLD_MS,
  type ConnectionHealth,
  type DeviceHealth,
  type HealthHint,
  type WsState,
} from '../lib/connectionHealth'

// Re-export so existing consumers don't need to change their import path.
export type { ConnectionHealth, DeviceHealth, HealthHint, WsState }

const ConnectionHealthContext = createContext<ConnectionHealth | null>(null)

export function ConnectionHealthProvider({ children }: { children: React.ReactNode }) {
  const { connected: wsConnected, authFailed: wsAuthFailed, everConnected } = useWebSocketContext()
  const backendPhase = useBackendPhase()
  const device = useDeviceContext()

  // `disconnectedAt` is React state (not a ref) so the derived memo
  // observes it through the standard data-flow path. Using a ref here
  // worked but coupled correctness to render/effect ordering — every
  // future reader of this file would need to reason about whether the
  // memo runs before or after the effect on the WS-state-change frame.
  const [disconnectedAt, setDisconnectedAt] = useState<number | null>(null)
  // Forces a re-derive once we cross the reconnecting→offline threshold
  // while WS is still down. Bumped by a single setTimeout so we don't
  // burn wakeups on a 500ms polling interval.
  const [thresholdTick, setThresholdTick] = useState(0)

  useEffect(() => {
    if (wsConnected) {
      setDisconnectedAt(null)
      return
    }
    setDisconnectedAt((prev) => prev ?? Date.now())
  }, [wsConnected])

  // Single timer: fire exactly when the offline threshold elapses.
  // Cleared if WS comes back or a new disconnect cycle starts.
  useEffect(() => {
    if (disconnectedAt == null) return
    const elapsed = Date.now() - disconnectedAt
    const remaining = OFFLINE_THRESHOLD_MS - elapsed
    if (remaining <= 0) return
    const id = setTimeout(() => setThresholdTick((n) => n + 1), remaining)
    return () => clearTimeout(id)
  }, [disconnectedAt])

  const connectedCount = device.connectedDevices.length
  const lostCount = device.lostUdids.size

  const health = useMemo<ConnectionHealth>(
    () => deriveConnectionHealth({
      wsConnected,
      wsAuthFailed,
      everConnected,
      backendPhase,
      disconnectedAt,
      now: Date.now(),
      connectedCount,
      lostCount,
    }),
    // `thresholdTick` is in the deps so the memo re-runs when the
    // setTimeout fires; its value is otherwise unused.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wsConnected, wsAuthFailed, everConnected, backendPhase, disconnectedAt, connectedCount, lostCount, thresholdTick],
  )

  return (
    <ConnectionHealthContext.Provider value={health}>
      {children}
    </ConnectionHealthContext.Provider>
  )
}

export function useConnectionHealth(): ConnectionHealth {
  const ctx = useContext(ConnectionHealthContext)
  if (!ctx) throw new Error('useConnectionHealth must be used within ConnectionHealthProvider')
  return ctx
}
