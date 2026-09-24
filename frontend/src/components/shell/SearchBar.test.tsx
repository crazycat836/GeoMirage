// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { I18nProvider } from '../../i18n'

type Raw = { display_name: string; lat: number; lng: number }[]
const h = vi.hoisted(() => ({
  pending: [] as { q: string; resolve: (r: Raw) => void }[],
}))

vi.mock('../../services/api', () => ({
  searchAddress: (q: string) => new Promise<Raw>((resolve) => { h.pending.push({ q, resolve }) }),
}))

import SearchBar from './SearchBar'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  h.pending.length = 0
})

function setup() {
  const onTeleport = vi.fn()
  render(
    <I18nProvider>
      <SearchBar onTeleport={onTeleport} deviceConnected />
    </I18nProvider>,
  )
  const input = screen.getByRole('combobox') as HTMLInputElement
  return { input, onTeleport }
}

function type(input: HTMLInputElement, value: string) {
  fireEvent.change(input, { target: { value } })
  act(() => { vi.advanceTimersByTime(300) })
}

async function resolve(q: string, names: string[]) {
  const req = h.pending.find((p) => p.q === q)!
  await act(async () => {
    req.resolve(names.map((n, i) => ({ display_name: n, lat: 25 + i, lng: 121 })))
  })
}

describe('SearchBar stale responses', () => {
  it('ignores an earlier search that answers after a newer one', async () => {
    const { input } = setup()
    fireEvent.focus(input)
    type(input, '台北')
    type(input, '台北101')
    expect(h.pending.map((p) => p.q)).toEqual(['台北', '台北101'])

    await resolve('台北101', ['Taipei 101'])
    await resolve('台北', ['Taipei City'])

    const names = screen.getAllByRole('option').map((o) => o.textContent)
    expect(names).toEqual(['Taipei 101'])
  })

  it('does not reopen the dropdown when a response lands after a selection', async () => {
    const { input, onTeleport } = setup()
    fireEvent.focus(input)
    type(input, '台北')
    await resolve('台北', ['Taipei City'])
    type(input, '台北1') // second request still in flight

    fireEvent.click(screen.getByRole('option', { name: /Taipei City/ }))
    expect(onTeleport).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('listbox')).toBeNull()

    await resolve('台北1', ['Taipei 1'])
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('drops an in-flight response once the query is cleared', async () => {
    const { input } = setup()
    fireEvent.focus(input)
    type(input, '台北')
    fireEvent.change(input, { target: { value: '' } })
    await resolve('台北', ['Taipei City'])
    expect(screen.queryByRole('option')).toBeNull()
  })
})
