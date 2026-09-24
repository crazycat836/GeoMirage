import React, { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useModalDismiss } from '../../hooks/useModalDismiss'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import { useT } from '../../i18n'
import GlassIconButton from '../ui/GlassIconButton'

interface DrawerProps {
  open: boolean
  onClose: () => void
  title: string
  /** Muted line below the title — e.g. "24 bookmarks · 4 categories". */
  subtitle?: React.ReactNode
  icon?: React.ReactNode
  side?: 'left' | 'right'
  width?: string
  /** Optional 34px glass icon buttons rendered to the left of the close button. */
  headerActions?: React.ReactNode
  /** Debug anchor for DevTools filtering via $$('[data-fc]'). */
  'data-fc'?: string
  children: React.ReactNode
}

// Deep-glass drawer derived from the redesign/Home library/device surfaces:
// rgba(15,16,20,0.96) + blur(28px) saturate(1.5). Keeps the existing
// focus trap / Esc dismissal / backdrop behaviour.
export default function Drawer({
  open,
  onClose,
  title,
  subtitle,
  icon,
  side = 'right',
  width = 'w-80',
  headerActions,
  'data-fc': dataFc,
  children,
}: DrawerProps) {
  const t = useT()
  const isLeft = side === 'left'
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = `drawer-title-${title.replace(/\s+/g, '-').toLowerCase()}`

  useModalDismiss({ open, onDismiss: onClose })
  useFocusTrap(panelRef, open)

  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => closeButtonRef.current?.focus(), 50)
    return () => clearTimeout(timer)
  }, [open])

  return createPortal(
    <>
      {/* Backdrop */}
      {open && (
        <div
          className={[
            'fixed inset-0 z-[var(--z-drawer)]',
            'bg-[rgba(8,9,13,0.55)] backdrop-blur-[4px] [-webkit-backdrop-filter:blur(4px)]',
            'transition-opacity',
          ].join(' ')}
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      {/* Panel */}
      <div
        data-fc={dataFc}
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        // Closed, the panel only slides off-screen and stays mounted; inert
        // keeps Tab and assistive tech out of it until it opens again.
        inert={!open}
        aria-hidden={open ? undefined : true}
        className={[
          'fixed inset-y-0 z-[var(--z-drawer)]',
          isLeft ? 'left-0' : 'right-0',
          width,
          // Solid deep-glass surface. Per DESIGN.md §1 no backdrop-filter
          // on full-height panels — Chrome reveals a tile-boundary seam
          // between blurred and unblurred regions of the map.
          'bg-[rgba(15,16,20,0.98)]',
          isLeft
            ? 'border-r border-[var(--color-border-strong)] shadow-[16px_0_48px_rgba(0,0,0,0.5)]'
            : 'border-l border-[var(--color-border-strong)] shadow-[-16px_0_48px_rgba(0,0,0,0.5)]',
          'flex flex-col',
          'transform transition-transform duration-[280ms] ease-[var(--ease-out-expo)]',
          open
            ? 'translate-x-0'
            : isLeft ? '-translate-x-full' : 'translate-x-full',
        ].join(' ')}
      >
        {/* Header */}
        <div className="flex items-start gap-3 px-5 pt-5 pb-4 border-b border-[var(--color-border-subtle)] shrink-0">
          {icon && (
            <span className="text-[var(--color-accent)] mt-1 shrink-0">{icon}</span>
          )}
          <div className="flex-1 min-w-0">
            <h2
              id={titleId}
              className="text-[22px] font-semibold tracking-[-0.02em] text-[var(--color-text-1)] leading-tight"
            >
              {title}
            </h2>
            {subtitle != null && (
              <div className="text-[12px] text-[var(--color-text-3)] font-medium mt-0.5 truncate">
                {subtitle}
              </div>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {headerActions}
            <GlassIconButton
              ref={closeButtonRef}
              onClick={onClose}
              label={t('panel.close')}
              icon={<X className="w-4 h-4" />}
            />
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto scrollbar-thin">
          {children}
        </div>
      </div>
    </>,
    document.body,
  )
}
