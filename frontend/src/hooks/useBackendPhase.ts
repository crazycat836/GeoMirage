import { useEffect, useState } from 'react'
import type { BackendPhase } from '../lib/connectionHealth'

interface BackendPhaseBridge {
  getBackendPhase?: () => Promise<unknown>
  onBackendPhase?: (cb: (phase: unknown) => void) => () => void
}

function normalize(value: unknown): BackendPhase {
  return value === 'awaiting_auth' || value === 'starting' || value === 'exited' ? value : null
}

/**
 * The packaged backend's start-up phase, as reported by Electron main over
 * the preload bridge. Always null in dev / browser runs (no bridge).
 */
export function useBackendPhase(): BackendPhase {
  const [phase, setPhase] = useState<BackendPhase>(null)

  useEffect(() => {
    const bridge = (globalThis as unknown as { geoMirage?: BackendPhaseBridge }).geoMirage
    if (!bridge) return
    let cancelled = false
    const unsubscribe = typeof bridge.onBackendPhase === 'function'
      ? bridge.onBackendPhase((p) => { if (!cancelled) setPhase(normalize(p)) })
      : undefined
    if (typeof bridge.getBackendPhase === 'function') {
      bridge.getBackendPhase()
        .then((p) => { if (!cancelled) setPhase(normalize(p)) })
        .catch(() => { /* no phase — treat as unknown */ })
    }
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [])

  return phase
}
