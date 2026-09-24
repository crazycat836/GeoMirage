// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, act, waitFor } from '@testing-library/react'
import UpdateChecker from './UpdateChecker'
import { I18nProvider } from '../i18n'

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ tag_name: 'v999.0.0' }),
  })))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function renderOpen() {
  render(<><button type="button">behind</button><I18nProvider><UpdateChecker /></I18nProvider></>)
  return await screen.findByRole('dialog')
}

describe('UpdateChecker dialog keyboard', () => {
  it('closes on Escape', async () => {
    await renderOpen()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('moves focus inside the dialog on open', async () => {
    const dialog = await renderOpen()
    await act(async () => { await new Promise((r) => setTimeout(r, 80)) })
    expect(dialog.contains(document.activeElement)).toBe(true)
  })
})
