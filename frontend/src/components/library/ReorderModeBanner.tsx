import { ArrowUpDown } from 'lucide-react'
import { useT } from '../../i18n'
import { ICON_SIZE } from '../../lib/icons'

/**
 * Fixed banner shown while a library list is in reorder mode. Every drop is
 * saved as it happens, so leaving is "Done", not "Cancel".
 */
export default function ReorderModeBanner({ onDone }: { onDone: () => void }) {
  const t = useT()
  return (
    <div
      role="status"
      className="flex items-center gap-2 px-2 py-1 rounded-md bg-[var(--color-surface-2)]"
    >
      <ArrowUpDown width={ICON_SIZE.xs} height={ICON_SIZE.xs} className="shrink-0 text-[var(--color-text-3)]" />
      <span className="text-[11px] flex-1">{t('panel.reorder_banner')}</span>
      <button type="button" className="action-btn primary text-[11px]" onClick={onDone}>
        {t('generic.done')}
      </button>
    </div>
  )
}
