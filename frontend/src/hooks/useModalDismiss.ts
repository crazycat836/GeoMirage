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
 * Put a surface on the shared Escape layer stack while *active*: Escape
 * calls *onEscape* only when this is the most recently opened layer, so
 * stacked surfaces (a menu over a dialog over a drawer) close one at a
 * time. Use it directly for popovers and menus that handle their own focus;
 * dialogs and drawers get it through `useModalDismiss`.
 *
 * Skips Escape that something else already handled (`defaultPrevented`,
 * e.g. an inline rename input cancelling itself) and Escape that closes an
 * IME candidate window (`isComposing`).
 */
export function useEscLayer(active: boolean, onEscape: () => void, busy = false): void {
  const layerRef = useRef<symbol | null>(null)

  // Track this surface on the layer stack for the whole time it is open.
  // Kept separate from the keydown effect so `busy` / `onEscape` identity
  // changes don't re-push the layer (which would wrongly move it to the top).
  useEffect(() => {
    if (!active) return
    const layer = Symbol('esc-layer')
    layerRef.current = layer
    pushLayer(layer)
    return () => {
      removeLayer(layer)
      layerRef.current = null
    }
  }, [active])

  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return
      const layer = layerRef.current
      if (layer == null || !isTopLayer(layer)) return
      e.preventDefault()
      if (!busy) onEscape()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [active, busy, onEscape])
}

/**
 * Shared keyboard-dismiss + focus-restore plumbing for modal-shaped
 * surfaces (drawers, dialogs).
 *
 * - Captures the `document.activeElement` on open so focus returns
 *   to the previous control on close.
 * - Binds Escape → `onDismiss` while open through `useEscLayer`, so
 *   stacked surfaces dismiss one at a time.
 *
 * Focus placement inside the dialog is *not* handled here — callers
 * decide where to move focus (first tab, textarea, confirm button).
 */
export function useModalDismiss({ open, onDismiss, busy = false }: UseModalDismissOptions): void {
  const previousFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    previousFocusRef.current = document.activeElement as HTMLElement | null
    return () => {
      previousFocusRef.current?.focus?.()
    }
  }, [open])

  useEscLayer(open, onDismiss, busy)
}
