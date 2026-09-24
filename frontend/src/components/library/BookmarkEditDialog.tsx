import { useCallback, useEffect, useRef, useState } from 'react'
import { MapPin, Crosshair } from 'lucide-react'
import type { BookmarkPlace, BookmarkTag } from '../../hooks/useBookmarks'
import { ICON_SIZE } from '../../lib/icons'
import { isDefaultPlace } from '../../lib/bookmarks'
import { useT } from '../../i18n'
import Modal from '../Modal'
import TagChip from '../ui/TagChip'

export interface BookmarkEditValues {
  name: string
  lat: number
  lng: number
  placeId: string
  tagIds: string[]
  note?: string
}

interface BaseProps {
  open: boolean
  onClose: () => void
  onSubmit: (values: BookmarkEditValues) => void
  places: readonly BookmarkPlace[]
  tags: readonly BookmarkTag[]
  /** Current live position (if available); enables "Use current position". */
  currentPosition: { lat: number; lng: number } | null
}

interface CreateProps extends BaseProps {
  mode: 'create'
  initial?: never
  /** Pre-fill coordinates when creating from a map right-click. */
  initialCoordinates?: { lat: number; lng: number }
}

interface EditProps extends BaseProps {
  mode: 'edit'
  initial: {
    id: string
    name: string
    lat: number
    lng: number
    placeId: string
    tagIds: string[]
    note?: string
  }
}

type Props = CreateProps | EditProps

// Accept "25.033, 121.564" pasted into the lat field and split into lat/lng.
function trySplitLatLng(s: string): [string, string] | null {
  const m = s.trim().match(/^(-?\d+(?:\.\d+)?)\s*[,\t ]\s*(-?\d+(?:\.\d+)?)\s*$/)
  return m ? [m[1], m[2]] : null
}

// Round to 6 decimals (~11cm at the equator) and strip trailing zeros so
// float-representation noise like `136.56696999999997` never leaks in.
function formatCoord(n: number): string {
  if (!Number.isFinite(n)) return ''
  return n.toFixed(6).replace(/\.?0+$/, '')
}

// Unified Add / Edit bookmark dialog.
// - In create mode with a live position, the "Use current position" toggle
//   is ON by default so the coordinate fields lock to live lat/lng.
// - Toggle OFF to hand-type custom coords.
// - In edit mode the toggle is hidden; user always edits explicit coords.
// - Dual-axis taxonomy: one "place" (where) + many "tags" (what).
export default function BookmarkEditDialog(props: Props) {
  const t = useT()
  const { open, onClose, onSubmit, places, tags, currentPosition, mode } = props
  const initial = (mode === 'edit' ? props.initial : undefined)
  const initialCoordinates = (mode === 'create' ? props.initialCoordinates : undefined)

  const firstPlace = places[0]?.id ?? 'default'

  const [name, setName] = useState('')
  const [useCurrent, setUseCurrent] = useState(true)
  const [latStr, setLatStr] = useState('')
  const [lngStr, setLngStr] = useState('')
  const [placeId, setPlaceId] = useState<string>(firstPlace)
  const [tagIds, setTagIds] = useState<string[]>([])
  const [note, setNote] = useState('')

  const nameRef = useRef<HTMLInputElement>(null)
  const wasOpenRef = useRef(false)
  // Edge-detector for the "use current position" toggle. Re-snapshot from
  // `currentPosition` only on the OFF→ON transition.
  const prevUseCurrentRef = useRef(true)

  // Initialize form state once per open transition. Deliberately ignore
  // `currentPosition` / `initial` / `firstPlace` after the dialog is
  // already open — otherwise a live position update mid-edit would clobber
  // what the user has typed.
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      wasOpenRef.current = true
      if (initial) {
        setName(initial.name)
        setUseCurrent(false)
        setLatStr(formatCoord(initial.lat))
        setLngStr(formatCoord(initial.lng))
        setPlaceId(initial.placeId || firstPlace)
        setTagIds([...initial.tagIds])
        setNote(initial.note ?? '')
        prevUseCurrentRef.current = false
      } else {
        setName('')
        if (initialCoordinates) {
          setUseCurrent(false)
          setLatStr(formatCoord(initialCoordinates.lat))
          setLngStr(formatCoord(initialCoordinates.lng))
          prevUseCurrentRef.current = false
        } else {
          const canUseCurrent = !!currentPosition
          setUseCurrent(canUseCurrent)
          setLatStr(canUseCurrent ? formatCoord(currentPosition!.lat) : '')
          setLngStr(canUseCurrent ? formatCoord(currentPosition!.lng) : '')
          prevUseCurrentRef.current = canUseCurrent
        }
        setPlaceId(firstPlace)
        setTagIds([])
        setNote('')
      }
      const f = setTimeout(() => nameRef.current?.focus(), 60)
      return () => clearTimeout(f)
    }
    if (!open) wasOpenRef.current = false
  }, [open, initial, firstPlace, currentPosition])

  // Snapshot — not live-track — the coord when the user toggles
  // "Use current position" ON. If we tracked live, a running simulation
  // (WS position_update at ~10Hz) would move the saved coord hundreds of
  // metres between dialog-open and pressing "Add".
  useEffect(() => {
    if (mode === 'edit') return
    const wasOn = prevUseCurrentRef.current
    prevUseCurrentRef.current = useCurrent
    if (!wasOn && useCurrent && currentPosition) {
      setLatStr(formatCoord(currentPosition.lat))
      setLngStr(formatCoord(currentPosition.lng))
    }
  }, [useCurrent, currentPosition, mode])

  const effectiveLat = parseFloat(latStr)
  const effectiveLng = parseFloat(lngStr)
  const latValid = Number.isFinite(effectiveLat) && effectiveLat >= -90 && effectiveLat <= 90
  const lngValid = Number.isFinite(effectiveLng) && effectiveLng >= -180 && effectiveLng <= 180
  const canSubmit = name.trim().length > 0 && latValid && lngValid

  const toggleTag = useCallback((tagId: string) => {
    setTagIds((prev) =>
      prev.includes(tagId) ? prev.filter((t) => t !== tagId) : [...prev, tagId],
    )
  }, [])

  const submit = useCallback(() => {
    if (!canSubmit) return
    onSubmit({
      name: name.trim(),
      lat: effectiveLat,
      lng: effectiveLng,
      placeId,
      tagIds,
      note: note.trim() || undefined,
    })
  }, [canSubmit, name, effectiveLat, effectiveLng, placeId, tagIds, note, onSubmit])

  const title = mode === 'edit' ? t('bm.edit') : t('bm.add')
  const submitLabel = mode === 'edit' ? t('generic.save') : t('generic.add')

  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel={typeof title === 'string' ? title : undefined}
      dataFc="modal.bookmark-edit"
      dialogStyle={{ width: 380 }}
      title={
        <span className="flex items-center gap-2">
          <MapPin width={ICON_SIZE.md} height={ICON_SIZE.md} className="text-[var(--color-accent)]" />
          {title}
        </span>
      }
      actions={
        <>
          <button type="button" className="action-btn" onClick={onClose}>
            {t('generic.cancel')}
          </button>
          <button
            type="button"
            className="action-btn primary"
            disabled={!canSubmit}
            onClick={submit}
          >
            {submitLabel}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3 mt-2">
          {/* Name */}
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] text-[var(--color-text-3)]">{t('bm.name_label')}</span>
            <input
              ref={nameRef}
              type="text"
              className="search-input"
              value={name}
              placeholder={t('bm.name_placeholder')}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit() }}
              style={{ paddingLeft: 10 }}
            />
          </label>

          {/* Use current position toggle — create mode only */}
          {mode === 'create' && (
            <label className="flex items-center gap-2 text-[12px] text-[var(--color-text-2)] cursor-pointer select-none">
              <input
                type="checkbox"
                checked={useCurrent}
                disabled={!currentPosition}
                onChange={(e) => setUseCurrent(e.target.checked)}
                className="accent-[var(--color-accent)]"
              />
              <Crosshair width={ICON_SIZE.sm} height={ICON_SIZE.sm} className="text-[var(--color-text-3)]" />
              <span>{t('bm.use_current_position')}</span>
              {!currentPosition && (
                <span className="text-[10px] text-[var(--color-danger-text)] ml-auto">
                  {t('bm.no_position')}
                </span>
              )}
            </label>
          )}

          {/* Lat / Lng */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] text-[var(--color-text-3)]">
              {t('panel.coord_lat')} / {t('panel.coord_lng')}
            </span>
            <div className="flex gap-2">
              <input
                type="text"
                inputMode="decimal"
                className="search-input font-mono"
                value={latStr}
                disabled={useCurrent}
                placeholder={t('bm.latlng_placeholder')}
                onChange={(e) => {
                  const v = e.target.value
                  const split = trySplitLatLng(v)
                  if (split) { setLatStr(split[0]); setLngStr(split[1]) }
                  else setLatStr(v)
                }}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit() }}
                style={{ flex: 1, paddingLeft: 10 }}
              />
              <input
                type="text"
                inputMode="decimal"
                className="search-input font-mono"
                value={lngStr}
                disabled={useCurrent}
                placeholder={t('bm.lng_placeholder')}
                onChange={(e) => setLngStr(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit() }}
                style={{ flex: 1, paddingLeft: 10 }}
              />
            </div>
          </div>

          {/* Place — single-axis "where" */}
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] text-[var(--color-text-3)]">{t('bm.place_label')}</span>
            <select
              value={placeId}
              onChange={(e) => setPlaceId(e.target.value)}
              className="search-input"
              style={{ paddingLeft: 10 }}
            >
              {places.map((p) => (
                <option key={p.id} value={p.id}>
                  {isDefaultPlace(p.name) ? t('bm.default') : p.name}
                </option>
              ))}
            </select>
          </label>

          {/* Tags — multi-axis "what" */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] text-[var(--color-text-3)]">{t('bm.tags_label')}</span>
            <div className="flex flex-wrap gap-1.5">
              {tags.length === 0 && (
                <span className="text-[11px] text-[var(--color-text-3)] italic">—</span>
              )}
              {tags.map((tag) => (
                <TagChip
                  key={tag.id}
                  tag={tag}
                  selected={tagIds.includes(tag.id)}
                  onToggle={() => toggleTag(tag.id)}
                />
              ))}
            </div>
          </div>

          {/* Note — optional */}
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] text-[var(--color-text-3)]">{t('bm.note')}</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              className="search-input"
              style={{ paddingLeft: 10, resize: 'vertical', minHeight: 52 }}
              placeholder="—"
            />
          </label>
        </div>
    </Modal>
  )
}
