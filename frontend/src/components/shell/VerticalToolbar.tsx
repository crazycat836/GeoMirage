import React from 'react'

/* ── Shared container ────────────────────────────────────────────────── */

interface VerticalToolbarProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode
  /** 'spaced' = padded with gaps (ModeToolbar), 'compact' = flush buttons (MapControls) */
  variant?: 'spaced' | 'compact'
}

export default function VerticalToolbar({ children, variant = 'spaced', className, ...rest }: VerticalToolbarProps) {
  return (
    <div
      {...rest}
      className={[
        'flex flex-col glass-panel',
        variant === 'spaced'
          ? 'gap-1.5 p-2'
          : 'overflow-hidden',
        className,
      ].filter(Boolean).join(' ')}
    >
      {children}
    </div>
  )
}

/* ── Shared button ───────────────────────────────────────────────────── */

interface ToolbarButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: React.ReactNode
  label: string
  /** Toggle state — only set for mode-style buttons, omit for action buttons */
  active?: boolean
  /** 'round' = 44px circle (mode buttons), 'square' = 40px flush (map controls) */
  variant?: 'round' | 'square'
  /** Accent text colour regardless of active state (e.g. recenter button) */
  accent?: boolean
}

export function ToolbarButton({
  icon,
  label,
  active,
  variant = 'round',
  accent,
  className,
  ...rest
}: ToolbarButtonProps) {
  const isToggle = active !== undefined

  // Active state uses accent-strong on accent-dim for WCAG AA contrast
  // (DESIGN.md §2 & §8a: accent-on-accent-dim fails 4.5:1).
  const colorClass = active
    ? 'bg-[var(--color-accent-dim)] text-[var(--color-accent-strong)] shadow-[0_0_12px_var(--color-accent-glow)]'
    : accent
      ? 'text-[var(--color-accent-strong)] hover:bg-[var(--color-surface-hover)]'
      : variant === 'round'
        ? 'text-[var(--color-text-2)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-1)]'
        : 'text-[var(--color-text-1)] hover:bg-[var(--color-surface-hover)]'

  return (
    <button
      {...rest}
      className={[
        'flex items-center justify-center',
        'transition-all duration-150 cursor-pointer',
        'focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] outline-none',
        'disabled:opacity-40 disabled:cursor-not-allowed',
        variant === 'round' ? 'w-11 h-11 rounded-full' : 'w-10 h-10',
        colorClass,
        className,
      ].filter(Boolean).join(' ')}
      title={rest.title ?? label}
      aria-label={label}
      {...(isToggle ? { 'aria-pressed': active } : {})}
    >
      {icon}
    </button>
  )
}

/* ── Shared divider ──────────────────────────────────────────────────── */

export function ToolbarDivider({ variant = 'spaced' }: { variant?: 'spaced' | 'compact' }) {
  return (
    <div className={['h-px bg-[var(--color-border)]', variant === 'spaced' ? 'mx-2' : ''].join(' ')} />
  )
}
