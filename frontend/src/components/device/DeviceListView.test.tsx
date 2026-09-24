// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'
import type { DeviceInfo } from '../../types/device'

const state = vi.hoisted(() => ({
  devices: [] as DeviceInfo[],
  lostUdids: new Set<string>(),
  everConnectedUdids: new Set<string>(),
  runtimes: {} as Record<string, { tunnelDegraded?: boolean }>,
  connect: vi.fn(async () => null),
  scan: vi.fn(async (): Promise<DeviceInfo[]> => []),
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
      scan: state.scan,
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
  state.scan.mockReset()
  state.scan.mockResolvedValue([])
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

describe('DeviceListView scan', () => {
  function renderList() {
    return render(<DeviceListView onClose={vi.fn()} onManage={vi.fn()} onAdd={vi.fn()} />)
  }

  it('scans quietly as soon as it opens', async () => {
    await act(async () => { renderList() })
    expect(state.scan).toHaveBeenCalledWith({ poll: true })
  })

  it('empty state tells the user to plug in and scan, with a scan button', async () => {
    await act(async () => { renderList() })
    expect(screen.getByText('device.no_device_hint')).toBeTruthy()
    state.scan.mockClear()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /device\.scan_now/ })) })
    expect(state.scan).toHaveBeenCalledWith()
  })

  it('shows "backend not ready" when a manual scan fails', async () => {
    await act(async () => { renderList() })
    state.scan.mockRejectedValue(new TypeError('Failed to fetch'))
    await act(async () => { fireEvent.click(screen.getByTitle('device.scan_tooltip')) })
    expect(screen.getByText(/device\.scan_backend_not_ready/)).toBeTruthy()
    expect(screen.queryByText(/device\.scan_none/)).toBeNull()
  })

  it('still shows "not found" when a manual scan succeeds with no devices', async () => {
    await act(async () => { renderList() })
    await act(async () => { fireEvent.click(screen.getByTitle('device.scan_tooltip')) })
    expect(screen.getByText(/device\.scan_none/)).toBeTruthy()
  })
})
