// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import ErrorBoundary from './ErrorBoundary'
import { STRINGS } from '../i18n/strings'
import { STORAGE_KEYS } from '../lib/storage-keys'

function Boom(): never {
  throw new Error('kaboom')
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('ErrorBoundary fallback', () => {
  it.each(['zh', 'en'] as const)('renders in the stored %s locale', (lang) => {
    localStorage.setItem(STORAGE_KEYS.lang, lang)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<ErrorBoundary><Boom /></ErrorBoundary>)
    expect(screen.getByText(STRINGS['error_boundary.title'][lang])).toBeTruthy()
    expect(screen.getByRole('button', { name: STRINGS['error_boundary.restart'][lang] })).toBeTruthy()
  })
})
