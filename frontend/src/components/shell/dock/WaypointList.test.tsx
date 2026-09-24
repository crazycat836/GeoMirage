// @vitest-environment jsdom
// The stop list labels go through i18n: no hardcoded "Start" / "Stop N · … next".
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'

vi.mock('../../../i18n', async () => {
  const { translate } = await vi.importActual<typeof import('../../../i18n')>('../../../i18n')
  const t = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate('zh', key, vars)
  return { useT: () => t }
})

import WaypointList from './WaypointList'

afterEach(cleanup)

describe('WaypointList labels in the Chinese UI', () => {
  it('translates the start row and the stop rows', () => {
    render(
      <WaypointList
        points={[
          { id: 'wp-0', label: '', position: { lat: 25, lng: 121 }, kind: 'start' },
          { id: 'wp-1', label: '', position: { lat: 25.01, lng: 121 } },
          { id: 'wp-2', label: '', position: { lat: 25.02, lng: 121 } },
        ]}
      />,
    )
    expect(screen.getByText('起點')).toBeTruthy()
    expect(screen.getByText(/^停靠點 1 · 距下一站 /)).toBeTruthy()
    expect(screen.getByText('停靠點 2')).toBeTruthy()
    expect(screen.queryByText(/^Start$/)).toBeNull()
    expect(screen.queryByText(/Stop \d/)).toBeNull()
  })
})
