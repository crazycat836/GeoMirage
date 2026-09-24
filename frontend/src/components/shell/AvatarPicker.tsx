import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Upload, Trash2, Check } from 'lucide-react'
import { useAvatarContext, type AvatarKind } from '../../contexts/AvatarContext'
import { AVATAR_PRESETS } from '../../lib/avatars'
import { useT } from '../../i18n'
import type { StringKey } from '../../i18n/strings'
import { useModalDismiss } from '../../hooks/useModalDismiss'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import { useInitialFocus } from '../../hooks/useInitialFocus'

interface AvatarPickerProps {
  anchor: DOMRect | null
  onClose: () => void
}

function AvatarPicker({ anchor, onClose }: AvatarPickerProps) {
  const t = useT()
  const { current, customDataUrl, applyPreset, applyCustom, uploadCustom, clearCustom } = useAvatarContext()
  // Staged selection — user picks/uploads first, then Save commits. Prevents
  // accidental "apply" while they're comparing options.
  const [staged, setStaged] = useState<AvatarKind>(current)
  const [error, setError] = useState<string>('')
  const fileRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => { setStaged(current) }, [current])

  // Dismiss on outside click.
  useEffect(() => {
    const onDown = (e: Event) => {
      const target = e.target as Element | null
      if (target && menuRef.current?.contains(target)) return
      onClose()
    }
    const tid = setTimeout(() => {
      document.addEventListener('pointerdown', onDown)
    }, 0)
    return () => {
      clearTimeout(tid)
      document.removeEventListener('pointerdown', onDown)
    }
  }, [onClose])

  // Esc on the shared layer stack (closes the picker, not the Settings
  // popover behind it), focus moves in on open, Tab stays inside, and focus
  // returns to the Settings row on close.
  const open = anchor != null
  useModalDismiss({ open, onDismiss: onClose })
  useFocusTrap(menuRef, open)
  useInitialFocus(open, menuRef)

  if (!anchor) return null

  // Position above the trigger, right-aligned so the picker hugs the status bar.
  const top = Math.max(8, anchor.top - 12 - 260)
  const left = Math.max(8, Math.min(window.innerWidth - 288, anchor.left + anchor.width / 2 - 140))

  const handleUpload = async (file: File) => {
    setError('')
    try {
      await uploadCustom(file)
      setStaged({ kind: 'custom' })
    } catch (e: unknown) {
      const code = e instanceof Error ? e.message : 'unknown'
      if (code === 'not-an-image') setError(t('avatar.err_not_image'))
      else if (code === 'too-large') setError(t('avatar.err_too_large'))
      else setError(t('avatar.err_generic'))
    }
  }

  const handleSave = () => {
    if (staged.kind === 'custom') {
      if (!applyCustom()) {
        setError(t('avatar.err_no_custom'))
        return
      }
    } else {
      applyPreset(staged.key)
    }
    onClose()
  }

  const isStaged = (k: AvatarKind): boolean => {
    if (k.kind === 'custom') return staged.kind === 'custom'
    return staged.kind === 'preset' && staged.key === k.key
  }

  return createPortal(
    <div
      data-fc="popover.avatar-picker"
      ref={menuRef}
      role="dialog"
      aria-modal="true"
      aria-label={t('avatar.picker_title')}
      data-avatar-picker
      style={{
        position: 'fixed',
        top,
        left,
        width: 280,
        zIndex: 'var(--z-dropdown)',
        background: 'var(--color-surface-1)',
        border: '1px solid var(--color-border-strong)',
        borderRadius: 12,
        padding: 12,
        boxShadow: 'var(--shadow-lg)',
        color: 'var(--color-text-1)',
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
        {t('avatar.picker_title')}
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 6,
          marginBottom: 8,
        }}
      >
        {AVATAR_PRESETS.map((p) => {
          const active = isStaged({ kind: 'preset', key: p.key })
          const Icon = p.Icon
          return (
            <button
              key={p.key}
              type="button"
              onClick={() => { setStaged({ kind: 'preset', key: p.key }); setError('') }}
              aria-pressed={active}
              title={t(p.labelKey as StringKey)}
              style={{
                position: 'relative',
                aspectRatio: '1 / 1',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: active ? 'var(--color-accent-dim)' : 'var(--color-surface-2)',
                border: `1px solid ${active ? 'var(--color-accent)' : 'var(--color-border)'}`,
                borderRadius: 10,
                color: active ? 'var(--color-accent)' : 'var(--color-text-2)',
                cursor: 'pointer',
                transition: 'all 150ms ease',
              }}
            >
              <Icon size={28} strokeWidth={2} />
              {active && (
                <Check
                  size={12}
                  style={{ position: 'absolute', top: 4, right: 4, color: 'var(--color-accent)' }}
                />
              )}
            </button>
          )
        })}
      </div>

      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-3)', marginBottom: 6 }}>
        {t('avatar.custom_label')}
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: 8,
          background: staged.kind === 'custom' ? 'var(--color-accent-dim)' : 'var(--color-surface-2)',
          border: `1px solid ${staged.kind === 'custom' ? 'var(--color-accent)' : 'var(--color-border)'}`,
          borderRadius: 10,
          marginBottom: 8,
        }}
      >
        <div
          role="button"
          tabIndex={0}
          onClick={() => {
            if (customDataUrl) {
              setStaged({ kind: 'custom' })
              setError('')
            } else {
              fileRef.current?.click()
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              if (customDataUrl) setStaged({ kind: 'custom' })
              else fileRef.current?.click()
            }
          }}
          style={{
            width: 44,
            height: 44,
            borderRadius: 8,
            background: 'var(--color-surface-1)',
            border: '1px dashed var(--color-border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
            cursor: 'pointer',
          }}
          aria-label={t('avatar.custom_preview')}
        >
          {customDataUrl ? (
            <img src={customDataUrl} alt="" width={40} height={40} style={{ objectFit: 'cover', borderRadius: 6 }} />
          ) : (
            <Upload size={16} color="var(--color-text-3)" />
          )}
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <button
            type="button"
            className="action-btn"
            style={{ fontSize: 11, padding: '3px 8px' }}
            onClick={() => fileRef.current?.click()}
          >
            <Upload size={12} />
            {customDataUrl ? t('avatar.replace_upload') : t('avatar.upload')}
          </button>
          {customDataUrl && (
            <button
              type="button"
              className="action-btn"
              style={{ fontSize: 11, padding: '3px 8px', color: 'var(--color-danger)' }}
              onClick={() => { clearCustom(); setError(''); setStaged({ kind: 'preset', key: AVATAR_PRESETS[0].key }) }}
            >
              <Trash2 size={12} />
              {t('avatar.clear_custom')}
            </button>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          style={{ display: 'none' }}
          onChange={async (e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) await handleUpload(f)
          }}
        />
      </div>

      {error && (
        <div style={{ fontSize: 11, color: 'var(--color-danger)', marginBottom: 8 }}>{error}</div>
      )}

      <div style={{ display: 'flex', gap: 6 }}>
        <button className="action-btn primary" style={{ flex: 1, fontSize: 12 }} onClick={handleSave}>
          {t('generic.save')}
        </button>
        <button className="action-btn" style={{ fontSize: 12 }} onClick={onClose}>
          {t('generic.cancel')}
        </button>
      </div>
    </div>,
    document.body,
  )
}

export default AvatarPicker
