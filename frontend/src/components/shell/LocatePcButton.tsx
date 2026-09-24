import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Locate, LocateFixed, MapPin, Navigation, Compass, Loader2, AlertTriangle, RefreshCw, Monitor,
} from 'lucide-react'
import ConfirmDialog from '../ui/ConfirmDialog'
import { usePcLocation, type PcLocationErrorCode } from '../../hooks/usePcLocation'
import { useSimActions, useSimState } from '../../contexts/SimContext'
import { useSimDerived } from '../../contexts/SimDerivedContext'
import { useT } from '../../i18n'
import { useModalDismiss } from '../../hooks/useModalDismiss'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import { useInitialFocus } from '../../hooks/useInitialFocus'

interface LocatePcButtonProps {
  /** Pan the map camera to a coordinate without touching the virtual GPS. */
  onFlyToCoordinate: (lat: number, lng: number, zoom?: number) => void
  /** Signals the parent that a PC location is (or no longer is) active so
   *  a map marker can be drawn. Fired with the coord after a fly-only and
   *  with null on teleport / refresh to wipe the stale pin. */
  onPcLocated?: (coord: { lat: number; lng: number } | null) => void
}

const LOCATE_ZOOM = 16
const POPOVER_WIDTH = 280
const POPOVER_GAP = 8
const VIEWPORT_EDGE_PADDING = 8
// Desktop geolocation is usually Wi-Fi/IP based; warn before teleporting to a
// fix this coarse so the user doesn't silently land hundreds of metres off.
const POOR_ACCURACY_M = 500

function errorLabelKey(code: PcLocationErrorCode): string {
  switch (code) {
    case 'permission_denied': return 'locate.error_permission'
    case 'unavailable':       return 'locate.error_unavailable'
    case 'timeout':           return 'locate.error_timeout'
    case 'insecure':          return 'locate.error_insecure'
    case 'unsupported':       return 'locate.error_unsupported'
  }
}

const PRIMARY_BTN = [
  'w-full h-9 inline-flex items-center justify-center gap-1.5 rounded-lg',
  'text-[13px] font-semibold cursor-pointer',
  'bg-[var(--color-accent)] text-[var(--color-surface-0)]',
  'hover:opacity-90 transition-opacity',
  'disabled:opacity-50 disabled:cursor-default',
].join(' ')

const SECONDARY_BTN = [
  'w-full h-9 inline-flex items-center justify-center gap-1.5 rounded-lg',
  'text-[13px] font-medium cursor-pointer',
  'border border-[var(--color-border)] text-[var(--color-text-2)]',
  'hover:bg-[var(--color-surface-hover)] hover:border-[var(--color-border-strong)] transition-colors',
  'disabled:opacity-50 disabled:cursor-default',
].join(' ')

export default function LocatePcButton({ onFlyToCoordinate, onPcLocated }: LocatePcButtonProps) {
  const t = useT()
  const { handleTeleport } = useSimActions()
  const { status } = useSimState()
  const { isRunning, isPaused } = useSimDerived()
  const { coord, loading, error, request } = usePcLocation()

  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const open = anchor != null

  const needsConfirm = isRunning || isPaused
  const [pendingTeleport, setPendingTeleport] = useState<{ lat: number; lng: number } | null>(null)

  const openPopover = useCallback(() => {
    if (!triggerRef.current) return
    setAnchor(triggerRef.current.getBoundingClientRect())
    // First open with nothing cached kicks off a fetch; the hook dedups
    // in-flight requests so reopening a cached fix won't re-prompt.
    if (!coord && !loading && !error) void request()
  }, [coord, loading, error, request])

  const closePopover = useCallback(() => setAnchor(null), [])

  useEffect(() => {
    if (!open) return
    const reposition = () => {
      if (triggerRef.current) setAnchor(triggerRef.current.getBoundingClientRect())
    }
    const onDown = (e: Event) => {
      const target = e.target as Element | null
      if (target && (panelRef.current?.contains(target) || triggerRef.current?.contains(target))) return
      if (pendingTeleport) return
      closePopover()
    }
    const tid = setTimeout(() => {
      document.addEventListener('pointerdown', onDown)
    }, 0)
    window.addEventListener('resize', reposition)
    return () => {
      clearTimeout(tid)
      document.removeEventListener('pointerdown', onDown)
      window.removeEventListener('resize', reposition)
    }
  }, [open, closePopover, pendingTeleport])

  // Esc on the shared layer stack (the teleport ConfirmDialog sits above
  // and takes the first Esc), focus moves in on open, Tab stays inside, and
  // focus returns to the trigger on close.
  useModalDismiss({ open, onDismiss: closePopover })
  useFocusTrap(panelRef, open)
  useInitialFocus(open, panelRef)

  const handleFlyOnly = useCallback(() => {
    if (!coord) return
    onFlyToCoordinate(coord.lat, coord.lng, LOCATE_ZOOM)
    onPcLocated?.({ lat: coord.lat, lng: coord.lng })
    closePopover()
  }, [coord, onFlyToCoordinate, onPcLocated, closePopover])

  const handleFlyAndTeleport = useCallback(() => {
    if (!coord) return
    if (needsConfirm) {
      setPendingTeleport({ lat: coord.lat, lng: coord.lng })
      return
    }
    onFlyToCoordinate(coord.lat, coord.lng, LOCATE_ZOOM)
    onPcLocated?.(null)
    handleTeleport(coord.lat, coord.lng)
    closePopover()
  }, [coord, needsConfirm, onFlyToCoordinate, onPcLocated, handleTeleport, closePopover])

  // Keep the existing fix visible while re-fetching (refreshing sub-state)
  // so the popover layout doesn't collapse to a bare spinner.
  const handleRefresh = useCallback(() => {
    onPcLocated?.(null)
    void request()
  }, [onPcLocated, request])

  const handleConfirmTeleport = useCallback(() => {
    if (!pendingTeleport) return
    const { lat, lng } = pendingTeleport
    onFlyToCoordinate(lat, lng, LOCATE_ZOOM)
    onPcLocated?.(null)
    handleTeleport(lat, lng)
    setPendingTeleport(null)
    closePopover()
  }, [pendingTeleport, onFlyToCoordinate, onPcLocated, handleTeleport, closePopover])

  const isRefreshing = loading && !!coord
  const TriggerIcon = loading ? Loader2 : (coord ? LocateFixed : Locate)
  const label = t('locate.button_label')

  let posStyle: React.CSSProperties = {}
  if (anchor) {
    const viewportW = window.innerWidth
    const right = Math.max(VIEWPORT_EDGE_PADDING, viewportW - anchor.right)
    const top = anchor.bottom + POPOVER_GAP
    const left = Math.max(VIEWPORT_EDGE_PADDING, viewportW - right - POPOVER_WIDTH)
    posStyle = { width: POPOVER_WIDTH, left, top, transformOrigin: 'top right' }
  }

  const ageSeconds = coord ? Math.max(0, Math.round((Date.now() - coord.timestamp) / 1000)) : 0

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? closePopover() : openPopover())}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={label}
        className={[
          'glass-pill w-11 h-11 grid place-items-center',
          'text-[var(--color-text-1)]',
          'hover:bg-[var(--color-surface-hover)] hover:border-[var(--color-border-strong)]',
          'active:scale-95',
          'transition-[transform,background,border-color] duration-150 cursor-pointer',
          'focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] outline-none',
          open ? 'ring-2 ring-[var(--color-border-focus)] border-[var(--color-border-strong)]' : '',
        ].join(' ')}
      >
        <TriggerIcon className={['w-[18px] h-[18px]', loading ? 'animate-spin' : ''].join(' ')} aria-hidden="true" />
      </button>

      {open && createPortal(
        <div
          ref={panelRef}
          role="dialog"
          aria-label={label}
          data-fc="popover.locate-pc"
          className="surface-popup fixed z-[var(--z-dropdown)] overflow-hidden rounded-2xl anim-scale-in-tl text-[var(--color-text-1)]"
          style={posStyle}
        >
          <div className="flex items-center gap-2 px-4 pt-3.5 pb-2.5">
            <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-3)]">
              <Monitor className="w-3.5 h-3.5" aria-hidden="true" />
              {t('locate.section')}
            </span>
          </div>

          <div className="px-4 pb-4">
            {/* Initial fetch — no cached fix yet */}
            {loading && !coord && (
              <div className="flex items-center gap-2.5 py-3.5 text-[13px] text-[var(--color-text-2)]">
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                {t('locate.loading')}
              </div>
            )}

            {/* Error (takes precedence over a stale fix) */}
            {error && (
              <>
                <div className="flex items-start gap-2 px-2.5 py-2 mb-2.5 rounded-lg bg-[var(--color-danger-dim)] border border-[var(--color-danger)]/30 text-[12px] leading-snug text-[var(--color-danger-text)]">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
                  <div>
                    {t(errorLabelKey(error.code) as Parameters<typeof t>[0])}
                    {error.code === 'permission_denied' && (
                      <span className="block mt-0.5 text-[var(--color-text-3)]">{t('locate.error_permission_hint')}</span>
                    )}
                  </div>
                </div>
                <button type="button" className={SECONDARY_BTN} onClick={() => { void request() }}>
                  <Compass className="w-[15px] h-[15px]" aria-hidden="true" />
                  {t('generic.retry')}
                </button>
              </>
            )}

            {/* Idle — nothing fetched, no error */}
            {!loading && !error && !coord && (
              <>
                <p className="text-[11.5px] leading-snug text-[var(--color-text-3)] mb-3">{t('locate.popover_hint')}</p>
                <button type="button" className={PRIMARY_BTN} onClick={() => { void request() }}>
                  <Locate className="w-[15px] h-[15px]" aria-hidden="true" />
                  {t('locate.fetch')}
                </button>
              </>
            )}

            {/* Ready / refreshing — a fix is available */}
            {!error && coord && (
              <>
                <div className="flex items-center gap-2 px-2.5 h-9 mb-2.5 rounded-lg bg-[var(--color-surface-ghost)] border border-[var(--color-border-subtle)]">
                  <span className={['text-[12px]', isRefreshing ? 'text-[var(--color-text-3)]' : 'text-[var(--color-text-2)]'].join(' ')}>
                    {isRefreshing
                      ? t('locate.loading')
                      : t('locate.accuracy', { m: Math.round(coord.accuracy), s: ageSeconds })}
                  </span>
                  <button
                    type="button"
                    onClick={handleRefresh}
                    disabled={isRefreshing}
                    title={t('locate.refresh')}
                    aria-label={t('locate.refresh')}
                    className="ml-auto w-7 h-7 grid place-items-center rounded-md text-[var(--color-text-2)] hover:text-[var(--color-accent-strong)] hover:bg-[var(--color-accent-dim)] transition-colors cursor-pointer disabled:cursor-default"
                  >
                    <RefreshCw className={['w-[15px] h-[15px]', isRefreshing ? 'animate-spin' : ''].join(' ')} aria-hidden="true" />
                  </button>
                </div>

                {coord.accuracy > POOR_ACCURACY_M && (
                  <div className="flex items-start gap-1.5 px-2.5 py-2 mb-2.5 rounded-lg bg-[var(--color-warning-dim)] border border-[var(--color-warning)]/30 text-[11px] leading-snug text-[var(--color-warning-text)]">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden="true" />
                    {t('locate.poor_accuracy')}
                  </div>
                )}

                <button type="button" className={PRIMARY_BTN} onClick={handleFlyAndTeleport} disabled={isRefreshing}>
                  <Navigation className="w-[15px] h-[15px]" aria-hidden="true" />
                  {t('locate.fly_and_teleport')}
                </button>
                <button type="button" className={`${SECONDARY_BTN} mt-2`} onClick={handleFlyOnly} disabled={isRefreshing}>
                  <MapPin className="w-[15px] h-[15px]" aria-hidden="true" />
                  {t('locate.fly_only')}
                </button>
              </>
            )}
          </div>
        </div>,
        document.body,
      )}

      <ConfirmDialog
        open={pendingTeleport != null}
        tone="danger"
        title={t('locate.confirm_teleport_title')}
        description={pendingTeleport
          ? t('locate.confirm_teleport_body', {
              state: status?.state ?? '-',
              lat: pendingTeleport.lat.toFixed(5),
              lng: pendingTeleport.lng.toFixed(5),
            })
          : ''}
        confirmLabel={t('locate.confirm_teleport')}
        cancelLabel={t('generic.cancel')}
        onConfirm={handleConfirmTeleport}
        onCancel={() => setPendingTeleport(null)}
      />
    </>
  )
}
