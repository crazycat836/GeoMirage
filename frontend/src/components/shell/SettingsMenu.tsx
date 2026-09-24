import React, { useState, useRef, useEffect } from 'react'
import {
  RotateCcw, FileText, MapPin, Timer, Languages, Layers, Info,
  Sun, ChevronRight, UserCircle2, Wand2, Search, Wifi,
} from 'lucide-react'
import { STORAGE_KEYS } from '../../lib/storage-keys'
import { readLS, writeLS } from '../../lib/local-storage'
import { getWifiKeepalive, setWifiKeepalive } from '../../services/api'
import { devWarn } from '../../lib/dev-log'
import { formatCountdown } from '../../lib/format'
import { useSimActions } from '../../contexts/SimContext'
import { useSimOverview } from '../../contexts/SimDerivedContext'
import { useSimSettings } from '../../contexts/SimSettingsContext'
import { useDeviceContext } from '../../contexts/DeviceContext'
import { useAvatarContext } from '../../contexts/AvatarContext'
import { useToastContext } from '../../contexts/ToastContext'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import { useI18n, useT, type Lang } from '../../i18n'
import AvatarPicker from './AvatarPicker'
import SetInitialPositionDialog from './SetInitialPositionDialog'
import GoldDittoDialog from './GoldDittoDialog'
import GooglePlacesKeyRow from './GooglePlacesKeyRow'
import SectionHeader from '../ui/SectionHeader'
import Toggle from '../ui/Toggle'
import KebabMenu, { type KebabMenuItem } from '../ui/KebabMenu'
import { AVATAR_PRESETS } from '../../lib/avatars'
import pkg from '../../../package.json'
import { FOCUSABLE_SELECTOR } from '../../hooks/useFocusTrap'

const APP_VERSION = pkg.version

const LAYER_OPTIONS = [
  { key: 'osm', label: 'OSM' },
  { key: 'carto', label: 'Carto' },
  { key: 'esri', label: 'ESRI' },
] as const

// Address-search providers. Brand names render verbatim (no translation).
// 'photon' is the default keyless backend; 'google' additionally needs the
// API key from GooglePlacesKeyRow.
const SEARCH_PROVIDERS = [
  { key: 'nominatim', label: 'Nominatim' },
  { key: 'photon', label: 'Photon' },
  { key: 'google', label: 'Google' },
] as const

const DEFAULT_SEARCH_PROVIDER = 'photon'

function readSearchProvider(): string {
  const v = readLS(STORAGE_KEYS.searchProvider)
  if (v === 'nominatim' || v === 'photon' || v === 'google') return v
  return DEFAULT_SEARCH_PROVIDER
}

interface SettingsMenuProps {
  open: boolean
  onClose: () => void
  layerKey: string
  onLayerChange: (key: string) => void
}

// Glass settings popover derived from redesign/Home #pop-settings.
// Three sections (Actions / Preferences / About) with uppercase
// headers; each row renders a 28px icon tile + label + value/toggle
// + optional chevron to mirror the design's .set-row anatomy.
export default function SettingsMenu({ open, onClose, layerKey, onLayerChange }: SettingsMenuProps) {
  const t = useT()
  const { showToast } = useToastContext()
  const { lang, setLang } = useI18n()
  const { handleRestore, handleOpenLog } = useSimActions()
  // Overview, not useSimState: the degraded set is all this menu needs, and
  // it must not re-render on every position tick.
  const { tunnelDegradedUdids } = useSimOverview()
  const { cooldown, cooldownEnabled, handleToggleCooldown } = useSimSettings()
  const device = useDeviceContext()

  const [initialOpen, setInitialOpen] = useState(false)
  const [goldDittoOpen, setGoldDittoOpen] = useState(false)

  // Address-search provider selection, persisted to localStorage and read
  // by `services/api.ts::searchAddress`. The Google API-key row is only
  // shown when Google is the active provider.
  const [searchProvider, setSearchProvider] = useState<string>(readSearchProvider)
  const persistSearchProvider = (p: string) => {
    setSearchProvider(p)
    writeLS(STORAGE_KEYS.searchProvider, p)
  }

  // WiFi keep-alive lives server-side (the background loop reads it), so the
  // toggle reflects backend state. Load it when the popover opens; write
  // through optimistically and roll back if the PUT fails.
  const [wifiKeepalive, setWifiKeepaliveState] = useState(false)
  useEffect(() => {
    if (!open) return
    let aborted = false
    getWifiKeepalive()
      .then((r) => { if (!aborted) setWifiKeepaliveState(!!r.enabled) })
      .catch((e) => devWarn('[settings] getWifiKeepalive failed', e))
    return () => { aborted = true }
  }, [open])
  const handleToggleWifiKeepalive = (next: boolean) => {
    setWifiKeepaliveState(next)
    setWifiKeepalive(next).catch((e) => {
      devWarn('[settings] setWifiKeepalive failed', e)
      setWifiKeepaliveState(!next) // roll back on failure
      // Surface the rollback so the toggle doesn't just silently snap back.
      showToast(t('settings.wifi_keepalive_failed'))
    })
  }

  const popoverRef = useRef<HTMLDivElement>(null)
  const avatarRowRef = useRef<HTMLDivElement>(null)
  const [avatarPickerAnchor, setAvatarPickerAnchor] = useState<DOMRect | null>(null)

  const avatarCtx = useAvatarContext()
  const avatarPresetKey = avatarCtx.current.kind === 'preset' ? avatarCtx.current.key : null
  const avatarPreset = avatarPresetKey
    ? AVATAR_PRESETS.find((p) => p.key === avatarPresetKey) ?? AVATAR_PRESETS[0]
    : null
  const AvatarIcon = avatarPreset?.Icon

  // "Dual" means "two devices we can act on right now." Exclude any
  // peer mid-tunnel-reconnect from the count — the user shouldn't see
  // the cooldown toggle grayed out just because the second phone is
  // re-handshaking its DVT channel. A truly disconnected device is
  // already excluded by the upstream `is_connected` filter on
  // `connectedDevices`.
  const dualDevice =
    device.connectedDevices.filter((d) => !tunnelDegradedUdids.includes(d.udid)).length >= 2

  // Outside-click dismissal — kept inline (rather than `useOutsideClick`)
  // because the predicate has trigger and avatar-picker exemptions that
  // need access to the actual event target. Standardised on `pointerdown`
  // so the dismissal also fires for touch and pen input — Electron windows
  // running on a touchscreen wouldn't close otherwise.
  useEffect(() => {
    if (!open) return
    const handler = (e: PointerEvent) => {
      const target = e.target as HTMLElement
      if (target.closest('[data-settings-trigger]')) return
      // Keep the popover open while the avatar picker is driving its own
      // outside-click dismissal. Otherwise clicks inside the picker would
      // bubble up and collapse the settings menu behind it.
      if (target.closest('[data-avatar-picker]')) return
      // Same problem for any KebabMenu dropdown (language / map-layer rows):
      // it portals to document.body, so its items sit *outside* popoverRef.
      // Without this exemption, the pointerdown that selects an option first
      // closes (and unmounts) the settings popover, so the option's later
      // `click` → onSelect never fires — the row looks unresponsive.
      if (target.closest('[role="menu"]')) return
      if (popoverRef.current && !popoverRef.current.contains(target)) {
        onClose()
      }
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('pointerdown', handler)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', handler)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  // Keyboard accessibility: trap Tab focus inside the popover, move focus in
  // on open, and restore it to the trigger on close. The trap releases while
  // the avatar picker (a separate anchored portal) is open so the picker can
  // own focus.
  useFocusTrap(popoverRef, open && !avatarPickerAnchor)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (!open) return
    restoreFocusRef.current = document.activeElement as HTMLElement | null
    const tid = setTimeout(() => {
      popoverRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus()
    }, 0)
    return () => {
      clearTimeout(tid)
      restoreFocusRef.current?.focus?.()
    }
  }, [open])

  if (!open && !initialOpen && !goldDittoOpen) return null

  return (
    <>
      {/* Popover */}
      {open && (
        <div
          data-fc="popover.settings"
          ref={popoverRef}
          role="dialog"
          aria-modal="true"
          aria-label={t('settings.title')}
          className={[
            'surface-popup',
            'fixed top-16 right-3 w-[300px] z-[var(--z-dropdown)] overflow-hidden',
            'rounded-2xl',
            'anim-scale-in-tl',
          ].join(' ')}
          style={{ transformOrigin: 'top right' }}
        >
          {/* Actions */}
          <Section label={t('settings.title')}>
            <SettingsRow
              icon={<RotateCcw className="w-[14px] h-[14px]" />}
              label={dualDevice ? t('status.restore_all') : t('status.restore')}
              onClick={() => { handleRestore(); onClose() }}
              trailing={<ChevronRight className="w-3 h-3 text-[var(--color-text-3)] opacity-60" />}
            />
            <SettingsRow
              icon={<FileText className="w-[14px] h-[14px]" />}
              label={t('status.open_log')}
              onClick={() => { handleOpenLog(); onClose() }}
              trailing={<ChevronRight className="w-3 h-3 text-[var(--color-text-3)] opacity-60" />}
            />
            <SettingsRow
              icon={<MapPin className="w-[14px] h-[14px]" />}
              label={t('status.set_initial')}
              onClick={() => { setInitialOpen(true); onClose() }}
              trailing={<ChevronRight className="w-3 h-3 text-[var(--color-text-3)] opacity-60" />}
            />
          </Section>

          {/* Preferences */}
          <Section label={t('settings.preferences')}>
            <SettingsRow
              icon={<Timer className="w-[14px] h-[14px]" />}
              label={t('settings.cooldown_label')}
              disabled={dualDevice}
              title={dualDevice ? t('status.cooldown_dual_disabled') : t('status.cooldown_tooltip')}
              trailing={
                <div className="flex items-center gap-2">
                  {cooldown > 0 && (
                    <span className="text-[10px] font-semibold text-[var(--color-amber-text)] bg-[var(--color-amber-dim)] px-1.5 py-0.5 rounded-full font-mono">
                      {formatCountdown(cooldown)}
                    </span>
                  )}
                  <Toggle
                    checked={cooldownEnabled && !dualDevice}
                    onChange={(v) => { if (!dualDevice) handleToggleCooldown(v) }}
                    ariaLabel={t('settings.toggle_cooldown_aria')}
                  />
                </div>
              }
            />

            <SettingsRow
              icon={<Wifi className="w-[14px] h-[14px]" />}
              label={t('settings.wifi_keepalive')}
              title={t('settings.wifi_keepalive_hint')}
              trailing={
                <Toggle
                  checked={wifiKeepalive}
                  onChange={handleToggleWifiKeepalive}
                  ariaLabel={t('settings.wifi_keepalive_aria')}
                />
              }
            />

            <ChoiceRow
              icon={<Languages className="w-[14px] h-[14px]" />}
              label={t('settings.language')}
              value={lang === 'zh' ? t('lang.zh_native') : t('lang.en_native')}
              ariaLabel={t('settings.language_aria')}
              items={[
                { id: 'zh', label: t('lang.zh_native'), onSelect: () => setLang('zh' as Lang) },
                { id: 'en', label: t('lang.en_native'), onSelect: () => setLang('en' as Lang) },
              ]}
            />

            <ChoiceRow
              icon={<Layers className="w-[14px] h-[14px]" />}
              label={t('settings.map_layer')}
              value={LAYER_OPTIONS.find((o) => o.key === layerKey)?.label ?? layerKey}
              ariaLabel={t('settings.map_layer')}
              items={LAYER_OPTIONS.map(({ key, label }) => ({
                id: key,
                label,
                onSelect: () => onLayerChange(key),
              }))}
            />

            <ChoiceRow
              icon={<Search className="w-[14px] h-[14px]" />}
              label={t('settings.search_provider')}
              value={SEARCH_PROVIDERS.find((o) => o.key === searchProvider)?.label ?? searchProvider}
              ariaLabel={t('settings.search_provider_aria')}
              items={SEARCH_PROVIDERS.map(({ key, label }) => ({
                id: key,
                label,
                onSelect: () => persistSearchProvider(key),
              }))}
            />

            {/* Google key field only matters when Google is selected. */}
            {searchProvider === 'google' && <GooglePlacesKeyRow />}

            <SettingsRow
              icon={<Sun className="w-[14px] h-[14px]" />}
              label={t('settings.theme')}
              interactive={false}
              trailing={<span className="font-mono text-[11px] text-[var(--color-text-3)]">{t('settings.theme_dark')}</span>}
            />

            {/* Game-assist row — opens the Gold Ditto dialog where the
                user configures the real-position anchor and triggers a
                cycle. The action lives in Settings rather than the main
                dock so it stays out of the way of the primary movement
                modes. */}
            <SettingsRow
              icon={<Wand2 className="w-[14px] h-[14px]" />}
              label={t('settings.gold_ditto')}
              onClick={() => { setGoldDittoOpen(true); onClose() }}
              trailing={<ChevronRight className="w-3 h-3 text-[var(--color-text-3)] opacity-60" />}
            />

            {/* Map Pin Avatar — previously lived in the top-left status pair.
                Moved here so configuration sits where users look for it,
                and the status pair can stay focused on passive status.
                Uses SettingsRow for shape parity with the surrounding rows;
                the wrapping div carries the bounding-rect ref the picker
                anchors against. */}
            <div ref={avatarRowRef}>
              <SettingsRow
                icon={<UserCircle2 className="w-[14px] h-[14px]" />}
                label={t('avatar.picker_title')}
                onClick={() => {
                  const r = avatarRowRef.current?.getBoundingClientRect()
                  if (r) setAvatarPickerAnchor(r)
                }}
                trailing={
                  <span className="flex items-center gap-1.5">
                    <span className="w-6 h-6 rounded-full grid place-items-center bg-white/[0.04] border border-[var(--color-border)] overflow-hidden">
                      {avatarCtx.current.kind === 'custom' && avatarCtx.customDataUrl ? (
                        <img
                          src={avatarCtx.customDataUrl}
                          alt=""
                          width={22}
                          height={22}
                          style={{ borderRadius: '50%', objectFit: 'cover' }}
                        />
                      ) : AvatarIcon ? (
                        <AvatarIcon className="w-[14px] h-[14px] text-[var(--color-accent-strong)]" strokeWidth={2} />
                      ) : null}
                    </span>
                    <ChevronRight className="w-3 h-3 text-[var(--color-text-3)] opacity-60" />
                  </span>
                }
              />
            </div>
          </Section>

          {/* Privacy / About */}
          <Section label={t('settings.about')}>
            <SettingsRow
              icon={<Info className="w-[14px] h-[14px]" />}
              label={t('settings.version')}
              interactive={false}
              trailing={<span className="font-mono text-[11px] text-[var(--color-text-3)]">v{APP_VERSION}</span>}
            />
          </Section>
        </div>
      )}

      {/* Avatar picker portal — opens anchored to the Settings row,
          dismisses on its own outside-click handling. */}
      {avatarPickerAnchor && (
        <AvatarPicker
          anchor={avatarPickerAnchor}
          onClose={() => setAvatarPickerAnchor(null)}
        />
      )}

      {/* Set Initial Position modal — extracted into its own component so
          the popover doesn't carry the dialog's state machinery on every
          render. The dialog self-loads the current value when opened. */}
      <SetInitialPositionDialog
        open={initialOpen}
        onClose={() => setInitialOpen(false)}
      />

      <GoldDittoDialog
        open={goldDittoOpen}
        onClose={() => setGoldDittoOpen(false)}
      />
    </>
  )
}

// ─── Subcomponents ──────────────────────────────────────────────────

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="py-2 px-1.5 [&+*]:border-t [&+*]:border-[var(--color-border-subtle)]">
      <SectionHeader title={label} className="px-3" />
      <div className="flex flex-col">{children}</div>
    </div>
  )
}

interface SettingsRowProps {
  icon: React.ReactNode
  label: React.ReactNode
  trailing?: React.ReactNode
  onClick?: () => void
  /** `false` renders the row as presentational (no hover/cursor). */
  interactive?: boolean
  disabled?: boolean
  danger?: boolean
  title?: string
}

function SettingsRow({
  icon, label, trailing, onClick, interactive = true, disabled, danger, title,
}: SettingsRowProps) {
  const Tag = interactive && onClick ? 'button' : 'div'
  return (
    <Tag
      {...(Tag === 'button' ? { type: 'button', onClick, disabled } : {})}
      title={title}
      className={[
        'flex items-center gap-3 px-3 py-[9px] rounded-[9px] text-[13px]',
        'text-[var(--color-text-1)] tracking-[-0.005em]',
        'transition-colors duration-150',
        interactive && onClick && !disabled ? 'hover:bg-white/[0.04] cursor-pointer' : '',
        disabled ? 'opacity-55 cursor-not-allowed' : '',
        danger ? 'text-[var(--color-danger-text)]' : '',
      ].join(' ')}
    >
      <span
        className={[
          'w-7 h-7 rounded-lg grid place-items-center shrink-0 border',
          danger
            ? 'text-[var(--color-danger-text)] border-[rgba(255,71,87,0.3)] bg-[rgba(255,71,87,0.08)]'
            : 'text-[var(--color-text-2)] border-[var(--color-border)] bg-white/[0.04]',
        ].join(' ')}
      >
        {icon}
      </span>
      <span className="flex-1 text-left truncate">{label}</span>
      {trailing != null && <span className="shrink-0">{trailing}</span>}
    </Tag>
  )
}

// ─── Choice row — shared for rows that pick one of N options ──
// Renders the same anatomy as SettingsRow (28px icon tile + label +
// trailing value + chevron), but the trailing chevron signals that
// clicking opens a dropdown. Avoids inline pill rails for cases like
// language / map-layer where design calls for "value + chevron"
// rather than 3 small crammed buttons.

interface ChoiceRowProps {
  icon: React.ReactNode
  label: React.ReactNode
  value: React.ReactNode
  items: KebabMenuItem[]
  ariaLabel?: string
}

function ChoiceRow({ icon, label, value, items, ariaLabel }: ChoiceRowProps) {
  return (
    <KebabMenu
      items={items}
      ariaLabel={ariaLabel ?? (typeof label === 'string' ? label : undefined)}
      align="end"
      trigger={
        <button
          type="button"
          className={[
            'flex items-center gap-3 px-3 py-[9px] rounded-[9px] text-[13px]',
            'text-[var(--color-text-1)] tracking-[-0.005em]',
            'hover:bg-white/[0.04] cursor-pointer',
            'transition-colors duration-150 w-full',
          ].join(' ')}
        >
          <span className="w-7 h-7 rounded-lg grid place-items-center shrink-0 border text-[var(--color-text-2)] border-[var(--color-border)] bg-white/[0.04]">
            {icon}
          </span>
          <span className="flex-1 text-left truncate">{label}</span>
          <span className="font-mono text-[11px] text-[var(--color-text-3)]">{value}</span>
          <ChevronRight className="w-3 h-3 text-[var(--color-text-3)] opacity-60 shrink-0" />
        </button>
      }
    />
  )
}

