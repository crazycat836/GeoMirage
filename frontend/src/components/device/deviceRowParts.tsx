import { CircleSlash, Usb, Wifi } from 'lucide-react'
import type { DeviceInfo } from '../../hooks/useDevice'
import { ICON_SIZE } from '../../lib/icons'
import { useT } from '../../i18n'

// Shared visual primitives for device rows. Both list and manage views
// render the same avatar + info column; the row container and trailing
// controls differ per view. Centralising these keeps the two views
// pixel-identical without duplicating Tailwind/styling.

const A_CHAR_CODE = 65
const ALPHABET_LIMIT = 26
const FALLBACK_LETTER = '•'
const MIN_SUPPORTED_IOS_MAJOR = 16

export interface DeviceMeta {
  major: number
  unsupported: boolean
  isNetwork: boolean
  isUsb: boolean
  isSelected: boolean
  letter: string
}

export function getDeviceMeta(
  d: DeviceInfo,
  idx: number,
  selectedUdid: string | undefined,
): DeviceMeta {
  const major = parseInt((d.ios_version || '0').split('.')[0], 10) || 0
  const unsupported = major > 0 && major < MIN_SUPPORTED_IOS_MAJOR
  const isNetwork = d.connection_type === 'Network'
  const isUsb = d.connection_type === 'USB' || d.connection_type === 'Usbmuxd'
  const isSelected = d.udid === selectedUdid
  const letter = idx < ALPHABET_LIMIT
    ? String.fromCharCode(A_CHAR_CODE + idx)
    : (d.name?.[0] ?? FALLBACK_LETTER)
  return { major, unsupported, isNetwork, isUsb, isSelected, letter }
}

/** What the device list shows as a row's connection status. */
export type DeviceRowStatus =
  | 'unsupported'
  | 'reconnecting'
  | 'connected'
  | 'connected_secondary'
  | 'lost'
  | 'not_connected'
  | 'ready'

/**
 * Row status from the device's own `is_connected`, whether it is the
 * primary device, and its tunnel health. A disconnected device is `lost`
 * when the drop was involuntary, `not_connected` when it was connected
 * earlier this session (e.g. the user disconnected it), and `ready` when
 * it has never been connected.
 */
export function getDeviceRowStatus(s: {
  isConnected: boolean
  unsupported: boolean
  isPrimary: boolean
  isLost: boolean
  degraded: boolean
  wasConnected: boolean
}): DeviceRowStatus {
  if (s.unsupported) return 'unsupported'
  if (s.isConnected) {
    if (s.degraded) return 'reconnecting'
    return s.isPrimary ? 'connected' : 'connected_secondary'
  }
  if (s.isLost) return 'lost'
  return s.wasConnected ? 'not_connected' : 'ready'
}

interface DeviceAvatarProps {
  meta: DeviceMeta
}

export function DeviceAvatar({ meta }: DeviceAvatarProps) {
  const { unsupported, isNetwork, letter } = meta
  if (unsupported) {
    return (
      <span
        className="w-9 h-9 rounded-[10px] grid place-items-center"
        style={{
          background: 'rgba(255,71,87,0.08)',
          border: '1px solid rgba(255,71,87,0.3)',
          color: 'var(--color-error-text)',
        }}
        aria-hidden="true"
      >
        <CircleSlash width={ICON_SIZE.md} height={ICON_SIZE.md} />
      </span>
    )
  }
  return (
    <span
      className="w-9 h-9 rounded-[10px] grid place-items-center text-white font-semibold text-[14px]"
      style={{
        background: `var(${isNetwork ? '--gradient-device-network' : '--gradient-device-usb'})`,
        boxShadow: 'var(--shadow-avatar-ring)',
      }}
      aria-hidden="true"
    >
      {letter}
    </span>
  )
}

interface DeviceInfoColumnProps {
  device: DeviceInfo
  meta: DeviceMeta
}

export function DeviceInfoColumn({ device, meta }: DeviceInfoColumnProps) {
  const t = useT()
  const { unsupported, isNetwork } = meta
  // A plugged-in but not-yet-paired device: discover_devices surfaces it
  // with an empty name/version (autopair=False, so it never pairs just to
  // list). Show a clear "not paired" placeholder so the user knows to tap
  // Connect rather than seeing a blank "USB · iOS " row.
  const unpaired = !device.is_connected && !device.ios_version
  return (
    <div className="min-w-0">
      <div className="text-[13px] font-medium text-[var(--color-text-1)] tracking-[-0.005em] truncate">
        {device.name || (unpaired ? t('device.unpaired_name') : '')}
      </div>
      <div className="mt-0.5 font-mono text-[10.5px] text-[var(--color-text-3)] inline-flex items-center gap-1.5 min-w-0">
        {!unsupported && (
          isNetwork
            ? <Wifi width={10} height={10} className="text-[var(--color-success-text)] shrink-0" />
            : <Usb width={10} height={10} className="text-[var(--color-accent-strong)] shrink-0" />
        )}
        <span className="truncate">
          {unsupported
            ? t('device.ios_unsupported_label', { version: device.ios_version })
            : unpaired
              ? t('device.unpaired_label')
              : `${isNetwork ? 'Wi-Fi' : 'USB'} · iOS ${device.ios_version}`}
        </span>
      </div>
    </div>
  )
}
