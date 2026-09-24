import { Star, MapPin, Crosshair } from 'lucide-react'
import { useSimDerived } from '../../../contexts/SimDerivedContext'
import { useBookmarkContext } from '../../../contexts/BookmarkContext'
import { SimMode } from '../../../hooks/useSimulation'
import { useT } from '../../../i18n'
import { formatCoordCardinal } from '../../../lib/format'

type LatLng = { lat: number; lng: number }

interface DockRouteCardProps {
  mode: SimMode
}

// Mode-specific origin/destination card. Only rendered for
// Teleport (dest only) and Navigate (origin + dest). Origin is the
// live `currentPos`; destination is the user-set marker. Star button
// pins either point to bookmarks.
export default function DockRouteCard({ mode }: DockRouteCardProps) {
  const t = useT()
  const { currentPos, destPos } = useSimDerived()
  const { handleAddBookmark } = useBookmarkContext()
  const showOrigin = mode === SimMode.Navigate
  return (
    <div
      className={[
        'flex flex-col overflow-hidden',
        'bg-white/[0.03] border border-[var(--color-border)] rounded-xl',
      ].join(' ')}
    >
      {showOrigin && (
        <DockRoutePoint
          tone="origin"
          label={t('teleport.my_location')}
          coord={currentPos}
          placeholder={t('teleport.no_position')}
          onBookmark={handleAddBookmark}
        />
      )}
      <DockRoutePoint
        tone="dest"
        label={t('teleport.destination')}
        coord={destPos}
        placeholder={t('teleport.add_destination')}
        onBookmark={handleAddBookmark}
      />
    </div>
  )
}

interface DockRoutePointProps {
  tone: 'origin' | 'dest'
  label: string
  coord: LatLng | null
  placeholder: string
  onBookmark: (lat: number, lng: number) => void
}

function DockRoutePoint({ tone, label, coord, placeholder, onBookmark }: DockRoutePointProps) {
  const t = useT()
  const empty = !coord
  const icPalette = tone === 'origin'
    ? { bg: 'var(--color-origin-dim)', bd: 'var(--color-origin-border)', fg: 'var(--color-origin-text)' }
    : empty
      ? { bg: 'var(--color-surface-ghost)', bd: 'var(--color-border-strong)', fg: 'var(--color-text-3)' }
      : { bg: 'var(--color-accent-dim)', bd: 'var(--color-accent-glow)', fg: 'var(--color-accent-strong)' }

  return (
    <div
      className="grid items-center gap-3 px-3.5 py-2.5 relative"
      style={{ gridTemplateColumns: '28px 1fr auto' }}
    >
      {/* Dotted connector between origin and dest */}
      <span
        aria-hidden="true"
        className="absolute left-[27px] -top-[9px] w-[2px] h-[18px] pointer-events-none"
        style={{
          background: 'repeating-linear-gradient(to bottom, var(--color-border-strong) 0 3px, transparent 3px 6px)',
          display: tone === 'dest' ? 'block' : 'none',
        }}
      />
      <span
        className="w-7 h-7 rounded-lg grid place-items-center shrink-0"
        style={{
          background: icPalette.bg,
          border: `1px ${empty && tone === 'dest' ? 'dashed' : 'solid'} ${icPalette.bd}`,
          color: icPalette.fg,
        }}
        aria-hidden="true"
      >
        {tone === 'origin'
          ? <Crosshair className="w-3.5 h-3.5" />
          : <MapPin className="w-3.5 h-3.5" />}
      </span>

      <div className="min-w-0">
        <div className="text-[11px] uppercase tracking-[0.04em] font-medium text-[var(--color-text-3)]">
          {label}
        </div>
        <div
          className={[
            'mt-0.5 text-[12px]',
            empty
              ? 'text-[var(--color-text-3)] italic'
              : 'font-mono text-[var(--color-text-1)]',
          ].join(' ')}
        >
          {empty
            ? placeholder
            : formatCoordCardinal(coord)}
        </div>
      </div>

      {coord && (
        <button
          type="button"
          onClick={() => onBookmark(coord.lat, coord.lng)}
          className={[
            'w-7 h-7 rounded-[7px] grid place-items-center',
            'text-[var(--color-text-3)]',
            'hover:text-[var(--color-device-paused)] hover:bg-[rgba(255,182,39,0.08)]',
            'transition-colors duration-150 cursor-pointer',
          ].join(' ')}
          aria-label={t('shell.bookmark_save')}
          title={t('shell.bookmark_save')}
        >
          <Star className="w-[13px] h-[13px]" />
        </button>
      )}
    </div>
  )
}
