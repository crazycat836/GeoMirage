import React from 'react'
import { Crosshair, MapPin, X, Star, Dices, Repeat, GripVertical, Wand2 } from 'lucide-react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { haversineM } from '../../../lib/geo'
import { formatCoordCardinal, formatDistanceM } from '../../../lib/format'
import { useDragReorder } from '../../../hooks/useDragReorder'
import { MIN_WAYPOINTS_FOR_OPTIMIZE } from '../../../lib/constants'
import { useT } from '../../../i18n'
import ReorderableList from '../../ui/ReorderableList'
import type { ChainPoint } from '../../WaypointChain'

const FOOTER_BTN_CLASS =
  'flex-1 h-8 rounded-lg inline-flex items-center justify-center gap-1.5 text-[12px] font-medium bg-white/[0.04] border border-[var(--color-border)] text-[var(--color-text-2)] hover:bg-white/[0.08] hover:text-[var(--color-text-1)] transition-colors cursor-pointer'

interface WaypointListProps {
  points: readonly ChainPoint[]
  loop?: boolean
  onRandom?: () => void
  /** Reorder the staged points to minimise travel time (backend
   *  /api/route/optimize). Rendered only with MIN_WAYPOINTS_FOR_OPTIMIZE+
   *  points — with fewer
   *  there is nothing to reorder. */
  onOptimize?: () => void
  onRemove?: (id: string) => void
  onBookmark?: (id: string) => void
  /** Reorder the stops (index >= 1; the start stays fixed). Receives the new
   *  order of stop ids ('wp-<originalIndex>'). When omitted, rows aren't
   *  draggable. */
  onReorder?: (orderedStopIds: string[]) => void
}

export default function WaypointList({
  points,
  loop,
  onRandom,
  onOptimize,
  onRemove,
  onBookmark,
  onReorder,
}: WaypointListProps) {
  const showOptimize = onOptimize != null && points.length >= MIN_WAYPOINTS_FOR_OPTIMIZE
  const t = useT()
  const start = points[0]
  const stops = points.slice(1)
  const canReorder = !!onReorder && stops.length >= 2

  // Hooks must run unconditionally — pass null when reorder is unavailable.
  const { sensors, handleDragEnd } = useDragReorder(
    canReorder ? stops : null,
    (p) => p.id,
    (ids) => onReorder?.(ids),
  )

  return (
    <div className="flex flex-col h-full min-h-0 bg-white/[0.03] border border-[var(--color-border)] rounded-xl overflow-hidden">
      <div className="overflow-y-auto flex-1 min-h-0 scrollbar-thin">
        {points.length === 0 ? (
          // Empty state replaces the old accent "Add stop" button, which was
          // wired to a no-op and pointed nowhere. Waypoints are added by
          // clicking the map (or right-click → Add waypoint); say so here.
          <div className="h-full min-h-[96px] flex items-center justify-center px-6 py-6 text-center">
            <span className="text-[12px] text-[var(--color-text-3)] leading-relaxed">
              {t('chain.add_hint')}
            </span>
          </div>
        ) : (
          <>
            {start && (
              <StopRow
                pt={start}
                isStart
                label="Start"
                onBookmark={onBookmark}
                t={t}
              />
            )}

            {canReorder ? (
              <ReorderableList
                sensors={sensors}
                onDragEnd={handleDragEnd}
                items={stops.map((s) => s.id)}
                getLabel={(id) => t('chain.stop_n', { n: stops.findIndex((s) => s.id === id) + 1 })}
              >
                  {stops.map((pt, j) => (
                    <SortableStopRow
                      key={pt.id}
                      pt={pt}
                      label={stopLabel(points, j + 1)}
                      onRemove={onRemove}
                      reorderAria={t('chain.reorder_aria')}
                      t={t}
                    />
                  ))}
              </ReorderableList>
            ) : (
              stops.map((pt, j) => (
                <StopRow
                  key={pt.id}
                  pt={pt}
                  label={stopLabel(points, j + 1)}
                  onRemove={onRemove}
                  t={t}
                />
              ))
            )}

            {loop && (
              <div
                className="grid items-center gap-3 px-3.5 py-2.5 relative opacity-70"
                style={{ gridTemplateColumns: '28px 1fr auto' }}
              >
                <span
                  className="w-7 h-7 rounded-lg grid place-items-center text-[var(--color-text-3)] bg-white/[0.04]"
                  style={{ border: '1px dashed var(--color-border-strong)' }}
                >
                  <Repeat className="w-3.5 h-3.5" strokeWidth={2} />
                </span>
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-[11px] text-[var(--color-text-3)] uppercase tracking-[0.04em] font-medium">
                    {t('chain.loop_back')}
                  </span>
                  <span className="text-[12px] text-[var(--color-text-3)] italic">
                    {t('chain.repeats_route')}
                  </span>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {(onRandom || showOptimize) && (
        <div className="flex gap-2 px-3.5 py-2.5 border-t border-[var(--color-border-subtle)] bg-white/[0.015]">
          {onRandom && (
            <button
              type="button"
              onClick={onRandom}
              className={FOOTER_BTN_CLASS}
            >
              <Dices className="w-[11px] h-[11px]" />
              {t('chain.random_stop')}
            </button>
          )}
          {showOptimize && (
            <button
              type="button"
              onClick={onOptimize}
              title={t('chain.optimize_hint')}
              className={FOOTER_BTN_CLASS}
            >
              <Wand2 className="w-[11px] h-[11px]" />
              {t('chain.optimize_order')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ── Row primitives ────────────────────────────────────────────────────

interface StopRowProps {
  pt: ChainPoint
  label: string
  isStart?: boolean
  onRemove?: (id: string) => void
  onBookmark?: (id: string) => void
  /** Drag handle node injected by the sortable wrapper (stops only). */
  dragHandle?: React.ReactNode
  setNodeRef?: (el: HTMLElement | null) => void
  style?: React.CSSProperties
  t: ReturnType<typeof useT>
}

function StopRow({ pt, label, isStart, onRemove, onBookmark, dragHandle, setNodeRef, style }: StopRowProps) {
  const t = useT()
  return (
    <div
      ref={setNodeRef}
      className="grid items-center gap-3 px-3.5 py-2.5 relative"
      style={{ gridTemplateColumns: '28px 1fr auto', ...style }}
    >
      <span
        className="w-7 h-7 rounded-lg grid place-items-center"
        style={isStart ? {
          background: 'var(--color-origin-dim)',
          color: 'var(--color-origin-text)',
          border: '1px solid var(--color-origin-border)',
        } : {
          background: 'var(--color-accent-dim)',
          color: 'var(--color-accent-strong)',
          border: '1px solid var(--color-accent-glow)',
        }}
      >
        {isStart
          ? <Crosshair className="w-3.5 h-3.5" strokeWidth={2} />
          : <MapPin className="w-3.5 h-3.5" strokeWidth={2} />}
      </span>

      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-[11px] text-[var(--color-text-3)] uppercase tracking-[0.04em] font-medium">
          {label}
        </span>
        <span className="font-mono text-[12px] text-[var(--color-text-1)]">
          {pt.position ? formatCoordCardinal(pt.position, 4) : '—'}
        </span>
      </div>

      <div className="flex items-center gap-1">
        {isStart ? (
          <button
            type="button"
            onClick={() => onBookmark?.(pt.id)}
            className="w-7 h-7 rounded-[7px] grid place-items-center text-[var(--color-text-3)] hover:text-[var(--color-device-paused)] hover:bg-[rgba(255,182,39,0.08)] transition-colors cursor-pointer"
            title={t('chain.bookmark')}
          >
            <Star className="w-[13px] h-[13px]" strokeWidth={2} />
          </button>
        ) : onRemove ? (
          <button
            type="button"
            onClick={() => onRemove(pt.id)}
            className="w-7 h-7 rounded-[7px] grid place-items-center text-[var(--color-text-3)] hover:text-[var(--color-danger)] hover:bg-[rgba(255,71,87,0.08)] transition-colors cursor-pointer"
            title={t('chain.remove')}
          >
            <X className="w-[13px] h-[13px]" strokeWidth={2.5} />
          </button>
        ) : null}
        {dragHandle}
      </div>
    </div>
  )
}

interface SortableStopRowProps {
  pt: ChainPoint
  label: string
  onRemove?: (id: string) => void
  reorderAria: string
  t: ReturnType<typeof useT>
}

function SortableStopRow({ pt, label, onRemove, reorderAria, t }: SortableStopRowProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: pt.id })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.55 : 1,
    zIndex: isDragging ? 1 : undefined,
  }
  const handle = (
    <button
      type="button"
      ref={setActivatorNodeRef}
      aria-label={reorderAria}
      title={reorderAria}
      className="w-6 h-7 grid place-items-center text-[var(--color-text-3)] hover:text-[var(--color-text-1)] cursor-grab active:cursor-grabbing focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
      {...attributes}
      {...listeners}
    >
      <GripVertical className="w-[13px] h-[13px]" />
    </button>
  )
  return (
    <StopRow
      pt={pt}
      label={label}
      onRemove={onRemove}
      dragHandle={handle}
      setNodeRef={setNodeRef}
      style={style}
      t={t}
    />
  )
}

// ── Labels / formatting ───────────────────────────────────────────────

function stopLabel(points: readonly ChainPoint[], idx: number): string {
  const cur = points[idx]
  const nextPt = idx < points.length - 1 ? points[idx + 1] : null
  const distM = nextPt?.position && cur?.position
    ? haversineM(cur.position, nextPt.position)
    : null
  return distM != null ? `Stop ${idx} · ${formatDistanceM(distM, 1)} next` : `Stop ${idx}`
}
