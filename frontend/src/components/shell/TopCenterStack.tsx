import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useSimActions, useSimState } from '../../contexts/SimContext'
import { useToastMsg } from '../../contexts/ToastContext'
import { useT } from '../../i18n'
import { isEtaBarLive } from '../EtaBar'
import ConnectionStatusBanner from './ConnectionStatusBanner'
import DeviceLostBanner from './DeviceLostBanner'
import DdiFailedBanner from './DdiFailedBanner'
import CooldownBadge from './CooldownBadge'

// Auto-dismiss window for the transient command-error pill.
const ERROR_AUTO_DISMISS_MS = 5000

// Where the column starts. When the ETA pill is live it occupies the
// top-[76px] band, so the column drops below it; otherwise it tucks just
// under the top bar.
const STACK_TOP_DEFAULT = 64
const STACK_TOP_BELOW_ETA = 120

interface TopCenterStackProps {
  /** Opens the device panel from the device-lost banner's Reconnect action. */
  onOpenDevices: () => void
}

// Single owner of the top-center status region. Everything that used to pin
// itself there with a hardcoded top-* offset (connection / device / DDI
// banners, the command-error pill, the pause + cooldown pills, and the
// transient toast) now renders here as flow children of one fixed flex
// column. The column stacks them with a consistent gap and one z-order, so
// they can never overlap each other, and it offsets below the ETA pill when a
// run is live. The ETA pill itself stays separate (lower z, below the top bar)
// so the search dropdown still wins over it.
export default function TopCenterStack({ onOpenDevices }: TopCenterStackProps) {
  const { error, status, runtimes, pauseRemaining } = useSimState()
  const { clearError } = useSimActions()
  const toastMsg = useToastMsg()
  const t = useT()

  const etaLive = isEtaBarLive(status?.state ?? 'idle', runtimes)
  const top = etaLive ? STACK_TOP_BELOW_ETA : STACK_TOP_DEFAULT

  const showPause = pauseRemaining != null && pauseRemaining > 0

  return createPortal(
    <div className="top-center-stack" style={{ top }}>
      {/* Order, top → bottom: command error, system banners, pause, cooldown,
          general toast. Each returns null when inactive, so the column only
          contains what's actually live. */}
      {error && <StackedErrorPill message={error} onDismiss={clearError} />}
      <ConnectionStatusBanner />
      <DeviceLostBanner onOpenDevices={onOpenDevices} />
      <DdiFailedBanner />
      {showPause && (
        <div className="toast-pill toast-pill-warning is-stacked" role="status" aria-live="polite" data-fc="map.toast.pause">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <rect x="6" y="4" width="4" height="16" rx="1" />
            <rect x="14" y="4" width="4" height="16" rx="1" />
          </svg>
          <span>{t('toast.pause_countdown', { n: Math.round(pauseRemaining ?? 0) })}</span>
        </div>
      )}
      <CooldownBadge />
      {toastMsg && (
        <div key={toastMsg} className="toast-pill toast-pill-dark is-stacked" role="status" aria-live="polite" data-fc="map.toast">
          <span>{toastMsg}</span>
        </div>
      )}
    </div>,
    document.body,
  )
}

// Transient command-failure pill — auto-dismisses after a few seconds, and
// click anywhere to dismiss immediately. Replaces App's old ErrorBanner.
function StackedErrorPill({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, ERROR_AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [message, onDismiss])

  return (
    <div
      className="toast-pill toast-pill-danger is-stacked"
      onClick={onDismiss}
      role="alert"
      aria-live="assertive"
      style={{ cursor: 'pointer' }}
    >
      <span>{message}</span>
      <span style={{ opacity: 0.7, fontSize: 11, flexShrink: 0 }} aria-hidden>✕</span>
    </div>
  )
}
