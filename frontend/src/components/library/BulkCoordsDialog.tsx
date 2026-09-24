import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useT } from '../../i18n'
import { useBookmarkContext } from '../../contexts/BookmarkContext'
import { parseBulkCoords, type ParsedCoord } from '../../lib/parseBulkCoords'
import Modal from '../Modal'

export type BulkMode = 'bookmarks' | 'waypoints'

interface BulkCoordsDialogProps {
  open: boolean
  /** `bookmarks` mode shows the place picker + "Name" hint; `waypoints`
   *  hides both and the confirmed list flows into the active route. */
  mode: BulkMode
  onCancel: () => void
  /** Called with the parsed list when the user hits Import. Async so
   *  callers can fan out to createBookmark / setWaypoints without
   *  closing the dialog prematurely. */
  onConfirm: (items: ParsedCoord[], placeId?: string) => Promise<void> | void
}

/**
 * Bulk-paste modal for importing multiple coordinates at once.
 *
 * Built on the existing `modal-*` CSS tokens (same surface as
 * `ConfirmDialog`) so it inherits the fork's glass / spacing / radius
 * language without introducing a new design pattern.
 */
export default function BulkCoordsDialog({ open, mode, onCancel, onConfirm }: BulkCoordsDialogProps) {
  const t = useT()
  const { places } = useBookmarkContext()

  const [text, setText] = useState('')
  const [placeId, setPlaceId] = useState<string>('default')
  const [busy, setBusy] = useState(false)
  const [errorsOpen, setErrorsOpen] = useState(false)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const summaryId = useId()

  const parsed = useMemo(() => parseBulkCoords(text), [text])

  // Reset body when the dialog closes so a subsequent open starts clean.
  useEffect(() => {
    if (open) return
    setText('')
    setErrorsOpen(false)
    setBusy(false)
  }, [open])

  const handleConfirm = async () => {
    if (parsed.ok.length === 0 || busy) return
    setBusy(true)
    try {
      await onConfirm(parsed.ok, mode === 'bookmarks' ? placeId : undefined)
    } finally {
      setBusy(false)
    }
  }

  const validCount = parsed.ok.length
  const errorCount = parsed.errors.length

  return (
    <Modal
      open={open}
      onClose={onCancel}
      busy={busy}
      title={t('bulk.title')}
      ariaDescribedBy={summaryId}
      initialFocusRef={textareaRef}
      dataFc="modal.bulk-coords"
      actions={
        <>
          <button
            type="button"
            className="action-btn"
            onClick={onCancel}
            disabled={busy}
          >
            {t('generic.cancel')}
          </button>
          <button
            type="button"
            className="action-btn primary"
            onClick={handleConfirm}
            disabled={validCount === 0 || busy}
          >
            {busy
              ? t('bulk.importing')
              : t('bulk.import_with_count', { n: validCount })}
          </button>
        </>
      }
    >
      <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <p className="text-[12px] text-[var(--color-text-3)]">
          {t('bulk.hint')}
        </p>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={busy}
          placeholder={mode === 'bookmarks' ? t('bulk.placeholder_bookmark') : t('bulk.placeholder_waypoint')}
          rows={10}
          className="search-input w-full font-mono text-[12px]"
          style={{
            resize: 'vertical',
            minHeight: 140,
            padding: 10,
            background: 'var(--color-surface-2)',
            border: '1px solid var(--color-border-subtle)',
            color: 'var(--color-text-1)',
          }}
          spellCheck={false}
          aria-label={t('bulk.textarea_aria')}
        />
        <div
          id={summaryId}
          className="text-[12px] flex items-center gap-3"
          aria-live="polite"
          aria-atomic="true"
        >
          <span style={{ color: validCount > 0 ? 'var(--color-success-text)' : 'var(--color-text-3)' }}>
            {t('bulk.summary_valid', { n: validCount })}
          </span>
          {errorCount > 0 && (
            <button
              type="button"
              onClick={() => setErrorsOpen((v) => !v)}
              className="text-[var(--color-error-text)] underline underline-offset-2 cursor-pointer bg-transparent border-0 p-0"
            >
              {errorsOpen
                ? t('bulk.summary_errors_hide', { n: errorCount })
                : t('bulk.summary_errors_show', { n: errorCount })}
            </button>
          )}
        </div>
        {errorsOpen && errorCount > 0 && (
          <ul
            className="text-[11px] font-mono max-h-32 overflow-y-auto flex flex-col gap-0.5 bg-[var(--color-danger-dim)] border border-[var(--color-danger)]/30 rounded-md text-[var(--color-text-2)]"
            style={{ padding: '6px 8px' }}
          >
            {parsed.errors.slice(0, 50).map((err) => (
              <li key={`${err.line}-${err.reason}`}>
                <span className="text-[var(--color-error-text)]">L{err.line}</span>
                {' · '}
                <span className="text-[var(--color-text-3)]">[{err.reason}]</span>
                {' · '}
                <span className="truncate">{err.raw}</span>
              </li>
            ))}
            {parsed.errors.length > 50 && (
              <li className="text-[var(--color-text-3)]">
                {t('bulk.errors_truncated', { n: parsed.errors.length - 50 })}
              </li>
            )}
          </ul>
        )}
        {mode === 'bookmarks' && (
          <label className="text-[12px] flex items-center gap-2">
            <span className="text-[var(--color-text-3)] shrink-0">{t('bm.place_label')}</span>
            <select
              value={placeId}
              onChange={(e) => setPlaceId(e.target.value)}
              disabled={busy}
              className="flex-1"
              style={{
                padding: '6px 8px',
                background: 'var(--color-surface-2)',
                color: 'var(--color-text-1)',
                border: '1px solid var(--color-border)',
                borderRadius: 4,
                fontSize: 12,
              }}
            >
              {places.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
        )}
      </div>
    </Modal>
  )
}
