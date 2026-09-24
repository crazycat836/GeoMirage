import { useId, useRef } from 'react'
import { useT } from '../../i18n'
import Modal from '../Modal'

interface RouteOverwriteDialogProps {
  name: string
  existingCreatedAt: string | null
  /** Resolve with the chosen same-name policy. */
  onResolve: (policy: 'overwrite' | 'new') => void
  /** Back out without saving; Esc and backdrop clicks land here too. */
  onCancel: () => void
}

/**
 * Same-name route conflict prompt shared by RoutesPanel and SaveRouteDialog:
 * Cancel / Save as new / Overwrite. Dismissing (Esc, backdrop) cancels and
 * saves nothing. Focus starts on "Save as new" so a reflexive Enter never
 * overwrites the existing route.
 */
export default function RouteOverwriteDialog({ name, existingCreatedAt, onResolve, onCancel }: RouteOverwriteDialogProps) {
  const t = useT()
  const saveNewRef = useRef<HTMLButtonElement>(null)
  const descId = useId()

  return (
    <Modal
      open
      onClose={onCancel}
      role="alertdialog"
      title={t('panel.route_overwrite_title')}
      ariaDescribedBy={descId}
      initialFocusRef={saveNewRef}
      dataFc="modal.route-overwrite"
      actions={
        <>
          <button type="button" className="action-btn" onClick={onCancel}>
            {t('generic.cancel')}
          </button>
          <button ref={saveNewRef} type="button" className="action-btn" onClick={() => onResolve('new')}>
            {t('panel.route_save_new_btn')}
          </button>
          <button type="button" className="action-btn primary" onClick={() => onResolve('overwrite')}>
            {t('panel.route_overwrite_btn')}
          </button>
        </>
      }
    >
      <div className="modal-body" id={descId}>
        {t('panel.route_overwrite_body', { name, created: (existingCreatedAt ?? '').slice(0, 10) })}
      </div>
    </Modal>
  )
}
