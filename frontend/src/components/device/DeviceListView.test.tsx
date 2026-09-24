// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import type { DeviceInfo } from '../../types/device'

const state = vi.hoisted(() => ({
  devices: [] as DeviceInfo[],
  lostUdids: new Set<string>(),
  everConnectedUdids: new Set<string>(),
  runtimes: {} as Record<string, { tunnelDegraded?: boolean }>,
  connect: vi.fn(async () => null),
}))

vi.mock('../../contexts/DeviceContext', () => ({
  useDeviceContext: () => {
    const connectedDevices = state.devices.filter((d) => d.is_connected)
    return {
      devices: state.devices,
      connectedDevices,
      primaryDevice: connectedDevices[0] ?? null,
      // Legacy single-device field: still pointing at the first device.
      connectedDevice: connectedDevices[0] ?? null,
      lostUdids: state.lostUdids,
      everConnectedUdids: state.everConnectedUdids,
      scan: vi.fn(),
      connect: state.connect,
    }
  },
}))
vi.mock('../../contexts/SimContext', () => ({
  useSimState: () => ({ runtimes: state.runtimes }),
}))
vi.mock('../../contexts/ToastContext', () => ({
  useToastContext: () => ({ showToast: vi.fn() }),
}))
vi.mock('../../i18n', () => ({
  useT: () => (key: string) => key,
}))

import DeviceListView from './DeviceListView'

function dev(udid: string, name: string, is_connected: boolean): DeviceInfo {
  return { udid, name, ios_version: '18.0', connection_type: 'USB', is_connected }
}

function statusOf(name: string): string | null {
  const row = screen.getByText(name).closest('button')!
  return row.querySelector('[data-status]')?.getAttribute('data-status') ?? null
}

afterEach(() => {
  cleanup()
  state.devices = []
  state.lostUdids = new Set()
  state.everConnectedUdids = new Set()
  state.runtimes = {}
  state.connect.mockClear()
})

describe('DeviceListView status', () => {
  function renderList() {
    render(<DeviceListView onClose={vi.fn()} onManage={vi.fn()} onAdd={vi.fn()} />)
  }

  it('shows both devices as connected in group mode', () => {
    state.devices = [dev('a', 'Phone A', true), dev('b', 'Phone B', true)]
    renderList()
    expect(statusOf('Phone A')).toBe('connected')
    expect(statusOf('Phone B')).toBe('connected_secondary')
    expect(screen.getByText('device.status_connected_secondary')).toBeTruthy()
  })

  it('tells a user-disconnected device from one never connected', () => {
    state.devices = [dev('a', 'Phone A', false), dev('b', 'Phone B', false)]
    state.everConnectedUdids = new Set(['a'])
    renderList()
    expect(statusOf('Phone A')).toBe('not_connected')
    expect(screen.getByText('device.status_not_connected')).toBeTruthy()
    expect(statusOf('Phone B')).toBe('ready')
  })

  it('shows a degraded tunnel as reconnecting on that row', () => {
    state.devices = [dev('a', 'Phone A', true), dev('b', 'Phone B', true)]
    state.runtimes = { b: { tunnelDegraded: true } }
    renderList()
    expect(statusOf('Phone A')).toBe('connected')
    expect(statusOf('Phone B')).toBe('reconnecting')
    expect(screen.getByText('device.chip_state_reconnecting')).toBeTruthy()
  })
})

describe('DeviceListView row click', () => {
  it('closes the popover without reconnecting an already-connected device', () => {
    // Reconnecting rebuilt the simulation engine and aborted a running route.
    state.devices = [dev('a', 'Phone A', true)]
    const onClose = vi.fn()
    render(<DeviceListView onClose={onClose} onManage={vi.fn()} onAdd={vi.fn()} />)
    fireEvent.click(screen.getByText('Phone A').closest('button')!)
    expect(state.connect).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('connects a device that is not connected', () => {
    state.devices = [dev('a', 'Phone A', false)]
    render(<DeviceListView onClose={vi.fn()} onManage={vi.fn()} onAdd={vi.fn()} />)
    fireEvent.click(screen.getByText('Phone A').closest('button')!)
    expect(state.connect).toHaveBeenCalledWith('a')
  })
})
