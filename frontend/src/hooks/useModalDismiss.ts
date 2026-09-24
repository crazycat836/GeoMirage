import { useEffect, useRef } from 'react'

interface UseModalDismissOptions {
  /** Whether the dialog / drawer is currently open. */
  open: boolean
  /** Called when Esc is pressed while open. */
  onDismiss: () => void
  /** When true, swallow Esc (don't dismiss). Use while a blocking
   *  async action is mid-flight — e.g. a Confirm's "busy" state. */
  busy?: boolean
}

// Stack of currently-open layers, oldest first. Only the most recently
// opened layer responds to Escape, so a nested dialog (e.g. a delete
// confirm inside the Library drawer) doesn't dismiss its parent surface
// with the same keypress.
let openLayers: readonly symbol[] = []

function pushLayer(layer: symbol): void {
  openLayers = [...openLayers, layer]
}

function removeLayer(layer: symbol): void {
  openLayers = openLayers.filter((l) => l !== layer)
}

function isTopLayer(layer: symbol): boolean {
  return openLayers[openLayers.length - 1] === layer
}

/** True while any modal-shaped surface (dialog, drawer, menu) is open.
 *  Global keyboard shortcuts check this so keys meant for the open layer
 *  don't also drive the page behind it. */
export function hasOpenLayer(): boolean {
  return openLayers.length > 0
}

/**
 * Shared keyboard-dismiss + focus-restore plumbing for modal-shaped
 * surfaces (drawers, dialogs).
 *
 * - Captures the `document.activeElement` on open so focus returns
 *   to the previous control on close.
 * - Binds Escape → `onDismiss` while open — only for the topmost open
 *   layer, so stacked surfaces dismiss one at a time.
 *
 * Focus placement inside the dialog is *not* handled here — callers
 * decide where to move focus (first tab, textarea, confirm button).
 */
export function useModalDismiss({ open, onDismiss, busy = false }: UseModalDismissOptions): void {
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const layerRef = useRef<symbol | null>(null)

  useEffect(() => {
    if (!open) return
    previousFocusRef.current = document.activeElement as HTMLElement | null
    return () => {
      previousFocusRef.current?.focus?.()
    }
  }, [open])

  // Track this surface on the layer stack for the whole time it is open.
  // Kept separate from the keydown effect so `busy` / `onDismiss` identity
  // changes don't re-push the layer (which would wrongly move it to the top).
  useEffect(() => {
    if (!open) return
    const layer = Symbol('modal-dismiss-layer')
    layerRef.current = layer
    pushLayer(layer)
    return () => {
      removeLayer(layer)
      layerRef.current = null
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || busy) return
      const layer = layerRef.current
      if (layer == null || !isTopLayer(layer)) return
      e.preventDefault()
      onDismiss()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, busy, onDismiss])
}
