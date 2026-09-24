import { useMemo, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { ICON_SIZE } from '../../lib/icons'
import KebabMenu from './KebabMenu'

export interface Chip<Id extends string = string> {
  id: Id
  label: React.ReactNode
  color?: string
  count?: number
}

interface ChipFilterBarProps<Id extends string> {
  chips: readonly Chip<Id>[]
  activeId: Id
  onChange: (id: Id) => void
  /** Visible-chip cap before overflow becomes "More ▾". Keep small so the
      bar never wraps — default 5 works well for a 420px drawer. */
  visibleCap?: number
  ariaLabel?: string
  /** Overflow button text and aria-label — required so callers pass a
   *  translated string (there is no English fallback). */
  moreLabel: string
  className?: string
}

// Horizontal scrollable chip filter. When `chips.length > visibleCap`,
// the overflow is folded into a "More ▾" popover so the row stays tidy
// regardless of how many categories the user creates.
export default function ChipFilterBar<Id extends string>({
  chips,
  activeId,
  onChange,
  visibleCap = 5,
  ariaLabel,
  moreLabel,
  className,
}: ChipFilterBarProps<Id>) {
  const [moreOpenSignal, setMoreOpenSignal] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Slot budget when overflow exists: (visibleCap - 1) chips + 1 "More" =
  // visibleCap total slots. If the active chip would land in overflow,
  // promote it into the last visible slot and push the displaced chip
  // into the overflow bucket, so the bar stays the same width regardless
  // of which category is active.
  const { visible, overflow } = useMemo(() => {
    if (chips.length <= visibleCap) {
      return { visible: chips as readonly Chip<Id>[], overflow: [] as Chip<Id>[] }
    }
    const budget = visibleCap - 1
    const activeIdx = chips.findIndex((c) => c.id === activeId)
    if (activeIdx >= budget) {
      const promoted = chips[activeIdx]
      const visible = [...chips.slice(0, budget - 1), promoted]
      const overflow = chips.filter((_, i) => i >= budget - 1 && i !== activeIdx)
      return { visible, overflow }
    }
    return { visible: chips.slice(0, budget), overflow: chips.slice(budget) }
  }, [chips, visibleCap, activeId])

  const overflowIncludesActive = overflow.some((c) => c.id === activeId)

  return (
    <div
      ref={scrollRef}
      role="group"
      aria-label={ariaLabel}
      className={['chip-filter-bar', className].filter(Boolean).join(' ')}
    >
      {visible.map((chip) => (
        <button
          key={chip.id}
          type="button"
          className="chip-filter-chip"
          aria-pressed={chip.id === activeId}
          onClick={() => onChange(chip.id)}
        >
          {chip.color && (
            <span
              aria-hidden="true"
              className="chip-filter-dot"
              style={{ background: chip.color }}
            />
          )}
          <span>{chip.label}</span>
          {typeof chip.count === 'number' && (
            <span className="chip-filter-count">{chip.count}</span>
          )}
        </button>
      ))}
      {overflow.length > 0 && (
        <KebabMenu
          key={moreOpenSignal}
          ariaLabel={moreLabel}
          items={overflow.map((chip) => ({
            id: String(chip.id),
            label: chip.label,
            colorDot: chip.color,
            onSelect: () => {
              onChange(chip.id)
              setMoreOpenSignal((n) => n + 1)
            },
          }))}
          trigger={
            <button
              type="button"
              className="chip-filter-chip"
              aria-pressed={overflowIncludesActive}
            >
              <span>{moreLabel}</span>
              <ChevronDown width={ICON_SIZE.xs} height={ICON_SIZE.xs} aria-hidden="true" />
            </button>
          }
        />
      )}
    </div>
  )
}
