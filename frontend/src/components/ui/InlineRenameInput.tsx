import React from 'react'

/** Inline rename input height — matches compact list-row baseline. */
export const INLINE_RENAME_HEIGHT_PX = 28

interface InlineRenameInputProps {
  value: string
  onChange: (next: string) => void
  /** Commit on blur and on Enter (guarded against IME composition). */
  onCommit: () => void
  /** Cancel on Escape. */
  onCancel: () => void
  className?: string
  /** Merged over the shared `paddingLeft: 8` baseline. */
  style?: React.CSSProperties
}

/**
 * The one inline-rename input: autofocus, commit on blur / Enter,
 * cancel on Escape. The `!e.nativeEvent.isComposing` guard keeps Enter
 * from committing mid-IME-composition (CJK input) — every rename site
 * must preserve it.
 */
export default function InlineRenameInput({
  value,
  onChange,
  onCommit,
  onCancel,
  className = 'search-input',
  style,
}: InlineRenameInputProps) {
  return (
    <input
      autoFocus
      type="text"
      className={className}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) onCommit()
        else if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
          // Mark the key handled so the dialog / drawer around the row
          // (useEscLayer skips defaultPrevented) doesn't close with it.
          e.preventDefault()
          onCancel()
        }
      }}
      onClick={(e) => e.stopPropagation()}
      style={{ paddingLeft: 8, ...style }}
    />
  )
}
