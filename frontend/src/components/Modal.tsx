import { useCallback, useId, useRef, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useInitialFocus } from '../hooks/useInitialFocus'
import { useModalDismiss } from '../hooks/useModalDismiss'

export type ModalSize = 'sm' | 'md' | 'lg'

export interface ModalProps {
  open: boolean
  onClose: () => void
  /** Optional title rendered inside `.modal-title`. Pass JSX for icon+text rows. */
  title?: ReactNode
  children: ReactNode
  /** Optional action bar (typically Cancel + Confirm); rendered in `.modal-actions`. */
  actions?: ReactNode
  size?: ModalSize
  /** Default `true`. When `false`, backdrop clicks are ignored. */
  closeOnBackdropClick?: boolean
  /** Default `true`. When `false`, Escape key is ignored. */
  closeOnEsc?: boolean
  /** Default `true`. Wraps the dialog with Tab focus containment. */
  focusTrap?: boolean
  /** Blocks both backdrop dismiss and Escape — for in-flight async actions. */
  busy?: boolean
  /** Optional accessible label. Without it the dialog is named by its
   *  rendered `title` (string or JSX) via `aria-labelledby`. */
  ariaLabel?: string
  /** Element id used for `aria-labelledby` (when caller renders its own h-tag). */
  ariaLabelledBy?: string
  /** Element id used for `aria-describedby`. */
  ariaDescribedBy?: string
  /** Default `dialog`. Use `alertdialog` for confirm prompts. */
  role?: 'dialog' | 'alertdialog'
  /** Element to focus on open; defaults to the first focusable descendant. */
  initialFocusRef?: RefObject<HTMLElement | null>
  /** Extra class names appended to the dialog; lets callers tune width or surface. */
  dialogClassName?: string
  /** Replaces the default `.modal-dialog` surface class. Use when a caller
   *  needs a different surface treatment (e.g. `surface-popup` for the
   *  Settings → Set-Initial-Position modal). */
  surfaceClass?: string
  /** Inline style override on `.modal-dialog` — used for one-off width tweaks. */
  dialogStyle?: React.CSSProperties
  /** Forwarded to the overlay's `data-fc` attribute (analytics breadcrumbs). */
  dataFc?: string
}

const SIZE_WIDTH_PX: Record<ModalSize, number> = {
  sm: 300,
  md: 360,
  lg: 420,
}

/**
 * Reusable modal scaffold built on the existing `.modal-overlay` /
 * `.modal-dialog` / `.modal-actions` styles. Reuses `useFocusTrap` and
 * `useModalDismiss` so callers don't reimplement Tab containment, Escape
 * dismissal, or focus restoration.
 *
 * `children` is the body; the optional `actions` prop renders the trailing
 * button row. Pass `busy` to block dismissal while an async operation is
 * mid-flight (e.g. saving).
 */
export default function Modal({
  open,
  onClose,
  title,
  children,
  actions,
  size = 'md',
  closeOnBackdropClick = true,
  closeOnEsc = true,
  focusTrap = true,
  busy = false,
  ariaLabel,
  ariaLabelledBy,
  ariaDescribedBy,
  role = 'dialog',
  initialFocusRef,
  dialogClassName,
  surfaceClass = 'modal-dialog',
  dialogStyle,
  dataFc,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = useId()

  const handleBackdropClick = useCallback(() => {
    if (busy || !closeOnBackdropClick) return
    onClose()
  }, [busy, closeOnBackdropClick, onClose])

  // Disable Esc handling when caller opts out by passing `closeOnEsc=false`.
  // Implemented via a noop dismiss + busy=true so we keep focus restoration.
  useModalDismiss({
    open,
    onDismiss: closeOnEsc ? onClose : noop,
    busy: busy || !closeOnEsc,
  })
  useFocusTrap(dialogRef, open && focusTrap)
  useInitialFocus(open, dialogRef, initialFocusRef)

  if (!open) return null

  // An explicit label wins; otherwise point at the rendered title so JSX
  // titles (icon + text) still give the dialog an accessible name.
  const resolvedLabelledBy =
    ariaLabel != null ? undefined : ariaLabelledBy ?? (title != null ? titleId : undefined)
  const widthPx = SIZE_WIDTH_PX[size]
  const mergedStyle: React.CSSProperties = { width: widthPx, ...dialogStyle }
  const mergedDialogClass = dialogClassName
    ? `${surfaceClass} ${dialogClassName}`
    : surfaceClass

  return createPortal(
    <div
      data-fc={dataFc}
      className="modal-overlay anim-fade-in"
      onClick={handleBackdropClick}
    >
      <div
        ref={dialogRef}
        role={role}
        aria-modal="true"
        tabIndex={-1}
        aria-label={ariaLabel}
        aria-labelledby={resolvedLabelledBy}
        aria-describedby={ariaDescribedBy}
        className={mergedDialogClass}
        style={mergedStyle}
        onClick={(e) => e.stopPropagation()}
      >
        {title != null && <div id={titleId} className="modal-title">{title}</div>}
        {children}
        {actions != null && <div className="modal-actions">{actions}</div>}
      </div>
    </div>,
    document.body,
  )
}

function noop() {}
