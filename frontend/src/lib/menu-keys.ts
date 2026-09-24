import type React from 'react'

const MENU_ITEM_SELECTOR = '[role="menuitem"]:not([disabled])'

function menuItems(menu: HTMLElement | null): HTMLElement[] {
  return Array.from(menu?.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR) ?? [])
}

/** Focus the first enabled `role="menuitem"` inside *menu*. */
export function focusFirstMenuItem(menu: HTMLElement | null): void {
  menuItems(menu)[0]?.focus()
}

/**
 * Roving focus for `role="menu"` popups: ArrowDown / ArrowUp cycle the
 * enabled menu items (wrapping), Home / End jump to the ends. Attach as
 * the menu container's `onKeyDown`.
 */
export function handleMenuArrowKeys(e: React.KeyboardEvent, menu: HTMLElement | null): void {
  const items = menuItems(menu)
  if (items.length === 0) return
  const idx = items.indexOf(document.activeElement as HTMLElement)
  let next: HTMLElement | undefined
  if (e.key === 'ArrowDown') next = items[(idx + 1) % items.length]
  else if (e.key === 'ArrowUp') next = items[(idx - 1 + items.length) % items.length]
  else if (e.key === 'Home') next = items[0]
  else if (e.key === 'End') next = items[items.length - 1]
  if (!next) return
  e.preventDefault()
  next.focus()
}
