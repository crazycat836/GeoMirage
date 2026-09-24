import React, { useCallback, useId, useRef } from 'react'
import Modal from '../Modal'

interface ConfirmDialogProps {
  open: boolean
  title: React.ReactNode
  description?: React.ReactNode
  confirmLabel: string
  cancelLabel: string
  /** 'danger' styles the confirm button red — used for destructive actions. */
  tone?: 'default' | 'danger'
  onConfirm: () => void | Promise<void>
  onCancel: () => void
  /** Block outside-click / ESC dismissal while confirming (e.g. mid-repair). */
  busy?: boolean
}

// Accessible replacement for window.confirm().
// Built on the shared Modal (Esc, focus trap, initial focus, focus restore).
export default function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  tone = 'default',
  onConfirm,
  onCancel,
  busy = false,
}: ConfirmDialogProps) {
  const descId = useId()
  const confirmRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  const handleConfirm = useCallback(() => {
    void onConfirm()
  }, [onConfirm])

  return (
    <Modal
      open={open}
      onClose={onCancel}
      busy={busy}
      role="alertdialog"
      title={title}
      ariaDescribedBy={description != null ? descId : undefined}
      // Danger dialogs focus Cancel so a reflexive Enter can't trigger the
      // destructive action; the default tone keeps Confirm as the target.
      initialFocusRef={tone === 'danger' ? cancelRef : confirmRef}
      dataFc="modal.confirm"
      actions={
        <>
          <button
            ref={cancelRef}
            type="button"
            className="action-btn"
            onClick={onCancel}
            disabled={busy}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={tone === 'danger' ? 'action-btn danger' : 'action-btn primary'}
            onClick={handleConfirm}
            disabled={busy}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      {description != null && (
        <div className="modal-body" id={descId}>{description}</div>
      )}
    </Modal>
  )
}
