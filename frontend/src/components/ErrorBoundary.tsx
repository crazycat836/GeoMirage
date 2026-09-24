import React from 'react'
import { devWarn } from '../lib/dev-log'
import { detectInitialLang, translate } from '../i18n'

interface ErrorBoundaryProps {
  children: React.ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

// Top-level safety net for unhandled render-time throws.
//
// Without this, a single bad render blanks the entire viewport — especially
// painful in Electron, where there is no address bar to refresh. The fallback
// here gives the user a visible "Restart" affordance that reloads the renderer.
//
// Hooks (incl. `useT`) cannot be used inside a class component, and this
// boundary may sit above I18nProvider, so the fallback reads the stored
// language itself and looks strings up with the hook-free `translate`.
export default class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    // `devWarn` short-circuits in production builds; in DEV it routes to
    // `console.warn` which is sufficient for surfacing render-time throws
    // without lighting up the DevTools error overlay every time. The
    // user-visible fallback UI still renders regardless.
    devWarn('[ErrorBoundary] Unhandled render error:', error, errorInfo)
  }

  private handleRestart = (): void => {
    window.location.reload()
  }

  render(): React.ReactNode {
    if (!this.state.hasError) {
      return this.props.children
    }

    const lang = detectInitialLang()
    const message = this.state.error?.message ?? translate(lang, 'error_boundary.fallback_message')

    return (
      <div
        role="alert"
        style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--color-surface-0, #14161e)',
          zIndex: 'var(--z-toast, 9999)',
          padding: 16,
        }}
      >
        <div
          className="surface-popup"
          style={{
            borderRadius: 'var(--radius-lg, 12px)',
            padding: 24,
            maxWidth: 420,
            width: '100%',
            textAlign: 'center',
          }}
        >
          <div
            style={{
              fontSize: 16,
              fontWeight: 600,
              marginBottom: 8,
              color: 'var(--color-text-1, #f0f2f8)',
            }}
          >
            {translate(lang, 'error_boundary.title')}
          </div>
          <div
            style={{
              fontSize: 12,
              lineHeight: 1.5,
              marginBottom: 16,
              color: 'var(--color-text-2, #a8b0c0)',
              wordBreak: 'break-word',
            }}
          >
            {message}
          </div>
          <button
            type="button"
            className="action-btn primary"
            onClick={this.handleRestart}
            style={{ width: '100%' }}
          >
            {translate(lang, 'error_boundary.restart')}
          </button>
        </div>
      </div>
    )
  }
}
