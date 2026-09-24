import { useCallback, useEffect, useRef } from 'react'
import { devLog } from '../lib/dev-log'

/**
 * Serialized optimistic reorder with an in-flight guard. A rapid second
 * drag while the first reorder POST is still landing would otherwise race
 * — the second drag's id list is computed from the stale pre-refresh local
 * order, both POSTs hit the server back-to-back, and whichever refresh lands
 * second wins. We serialise the POST and queue the *latest* ordering on top,
 * so a burst of N drags collapses into one in-flight call plus one tail call
 * carrying the final order.
 *
 * The returned handler is unconditionally stable: `post` / `refresh` /
 * `label` are held in a render-updated ref and read fresh at the start of
 * each run, so callers can pass inline or per-render functions without
 * worrying about memoization — and the queued tail call always uses the
 * latest inputs.
 */
export function useSerializedReorder(
  post: (orderedIds: string[]) => Promise<unknown>,
  refresh: () => Promise<unknown>,
  label: string,
): (orderedIds: string[]) => Promise<void> {
  const inflightRef = useRef(false)
  const pendingRef = useRef<string[] | null>(null)
  // Latest-inputs ref, updated via effect (same pattern as the old
  // handlerRef): each run — including the queued tail run — reads the
  // current post/refresh/label instead of a stale closure.
  const ioRef = useRef({ post, refresh, label })
  useEffect(() => { ioRef.current = { post, refresh, label } })
  return useCallback(async function run(orderedIds: string[]): Promise<void> {
    if (inflightRef.current) {
      pendingRef.current = orderedIds
      return
    }
    inflightRef.current = true
    const { post, refresh, label } = ioRef.current
    try {
      await post(orderedIds)
    } catch (err) {
      devLog(label, err)
    } finally {
      // A failed refresh must not leave the guard stuck (every later drag
      // would only queue and never POST) or reject into a fire-and-forget
      // caller.
      try {
        await refresh()
      } catch (err) {
        devLog(label, err)
      }
      inflightRef.current = false
      const queued = pendingRef.current
      pendingRef.current = null
      // Named function expression: the tail call re-enters `run` itself,
      // which re-reads ioRef for the freshest post/refresh.
      if (queued) void run(queued)
    }
  }, [])
}
