import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MoreVertical } from 'lucide-react'
import { ICON_SIZE } from '../../lib/icons'
import { focusFirstMenuItem, handleMenuArrowKeys } from '../../lib/menu-keys'
import { useEscLayer } from '../../hooks/useModalDismiss'

type Side = 'top' | 'bottom'
type Align = 'start' | 'end'

export interface KebabMenuItem {
  id: string
  label: React.ReactNode
  /** Optional secondary line beneath the label — renders muted + smaller, not truncated. */
  hint?: React.ReactNode
  icon?: React.ReactNode
  /** 'danger' tints the item red; 'section' renders the entry as a muted label instead of a button. */
  kind?: 'default' | 'danger' | 'section'
  onSelect?: () => void
  disabled?: boolean
  /** Dot swatch on the leading edge (used for "Move to <category>"). */
  colorDot?: string
  keepOpen?: boolean
}

interface KebabMenuProps {
  items: KebabMenuItem[] | (() => KebabMenuItem[])
  ariaLabel?: string
  side?: Side
  align?: Align
  /** Override the default MoreVertical trigger (e.g. for row-level kebab). */
  trigger?: React.ReactElement<Record<string, unknown>>
  /** When true, right-click on the trigger also toggles the menu (and blocks
      the native browser menu). Useful for replacing contextmenu-style UIs. */
  openOnContextMenu?: boolean
  className?: string
  triggerSize?: number
}

// Portal-rendered popup menu. Arrow keys cycle items, Esc closes,
// click-outside dismisses. Callers can swap the trigger via `trigger`.
export default function KebabMenu({
  items,
  ariaLabel = 'More actions',
  side = 'bottom',
  align = 'end',
  trigger,
  openOnContextMenu,
  className,
  triggerSize = ICON_SIZE.sm,
}: KebabMenuProps) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  const close = useCallback(() => setOpen(false), [])

  // Compute position from the trigger rect on open.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return
    const r = triggerRef.current.getBoundingClientRect()
    const menu = menuRef.current
    const menuWidth = menu?.offsetWidth ?? 180
    const menuHeight = menu?.offsetHeight ?? 200
    let left = align === 'end' ? r.right - menuWidth : r.left
    let top = side === 'bottom' ? r.bottom + 6 : r.top - menuHeight - 6
    // Clamp to viewport with a small gutter.
    left = Math.max(8, Math.min(left, window.innerWidth - menuWidth - 8))
    top = Math.max(8, Math.min(top, window.innerHeight - menuHeight - 8))
    setPos({ left, top })
  }, [open, align, side])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null
      if (!target) return
      if (menuRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      close()
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open, close])

  // Esc goes through the shared layer stack so it closes only this menu,
  // not the dialog / drawer / settings popover it was opened from.
  const closeFromKeyboard = useCallback(() => {
    close()
    triggerRef.current?.focus()
  }, [close])
  useEscLayer(open, closeFromKeyboard)

  // Focus first actionable item when opening.
  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => focusFirstMenuItem(menuRef.current), 0)
    return () => clearTimeout(t)
  }, [open])

  const onMenuKey = (e: React.KeyboardEvent) => handleMenuArrowKeys(e, menuRef.current)

  const toggle = useCallback((e: React.MouseEvent<HTMLElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setOpen((v) => !v)
  }, [])

  const triggerElement = trigger
    ? React.cloneElement(trigger, {
        ref: (el: HTMLElement | null) => { triggerRef.current = el },
        onClick: (e: React.MouseEvent<HTMLElement>) => {
          const prev = trigger.props.onClick as ((evt: React.MouseEvent<HTMLElement>) => void) | undefined
          prev?.(e)
          toggle(e)
        },
        onContextMenu: openOnContextMenu
          ? (e: React.MouseEvent<HTMLElement>) => {
              const prev = trigger.props.onContextMenu as ((evt: React.MouseEvent<HTMLElement>) => void) | undefined
              prev?.(e)
              toggle(e)
            }
          : trigger.props.onContextMenu,
        'aria-expanded': open,
        'aria-haspopup': 'menu',
      } as Record<string, unknown>)
    : (
      <button
        ref={(el) => { triggerRef.current = el }}
        type="button"
        className={['kebab-btn', className].filter(Boolean).join(' ')}
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={ariaLabel}
      >
        <MoreVertical width={triggerSize} height={triggerSize} />
      </button>
    )

  const resolvedItems = typeof items === 'function' ? (open ? items() : []) : items

  return (
    <>
      {triggerElement}
      {open && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label={ariaLabel}
          onKeyDown={onMenuKey}
          className="surface-popup anim-fade-slide-down"
          style={{
            position: 'fixed',
            left: pos?.left ?? -9999,
            top: pos?.top ?? -9999,
            zIndex: 'var(--z-popover)',
            borderRadius: 'var(--radius-md)',
            padding: '4px 0',
            minWidth: 180,
            maxWidth: 260,
            visibility: pos ? 'visible' : 'hidden',
          }}
        >
          {resolvedItems.map((item) => {
            if (item.kind === 'section') {
              return (
                <div
                  key={item.id}
                  role="presentation"
                  className="px-3 py-1 text-[10px] uppercase tracking-wider text-[var(--color-text-3)] opacity-70"
                >
                  {item.label}
                </div>
              )
            }
            const isDanger = item.kind === 'danger'
            const hasHint = item.hint != null
            return (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                className="context-menu-item"
                disabled={item.disabled}
                style={isDanger ? { color: 'var(--color-danger-text)' } : undefined}
                onClick={(e) => {
                  e.stopPropagation()
                  item.onSelect?.()
                  if (!item.keepOpen) close()
                }}
              >
                {item.colorDot && (
                  <span
                    aria-hidden="true"
                    style={{
                      width: 8, height: 8, borderRadius: '50%',
                      background: item.colorDot, flexShrink: 0,
                    }}
                  />
                )}
                {item.icon}
                {hasHint ? (
                  <span className="flex-1 flex flex-col text-left min-w-0">
                    <span className="truncate">{item.label}</span>
                    <span className="text-[11px] text-[var(--color-text-3)] opacity-80 leading-snug">
                      {item.hint}
                    </span>
                  </span>
                ) : (
                  <span className="flex-1 text-left truncate">{item.label}</span>
                )}
              </button>
            )
          })}
        </div>,
        document.body,
      )}
    </>
  )
}
