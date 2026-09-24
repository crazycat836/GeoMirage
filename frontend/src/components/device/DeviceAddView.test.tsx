// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
import DeviceAddView from './DeviceAddView'

const showToast = vi.fn()
const startWifiTunnel = vi.fn()

vi.mock('../../contexts/DeviceContext', () => ({
  useDeviceContext: () => ({ devices: [], startWifiTunnel }),
}))
vi.mock('../../contexts/ToastContext', () => ({
  useToastContext: () => ({ showToast }),
}))
vi.mock('../../i18n', () => ({
  useT: () => (key: string) => key,
}))
vi.mock('../../services/api', () => ({
  wifiTunnelDiscover: vi.fn(),
}))
vi.mock('../../lib/local-storage', () => ({
  readLS: () => '',
  writeLS: vi.fn(),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function startTunnel() {
  let reject: (err: Error) => void = () => {}
  startWifiTunnel.mockImplementationOnce(
    () => new Promise((_, rej) => { reject = rej }),
  )
  const view = render(<DeviceAddView onConnected={vi.fn()} />)
  fireEvent.change(view.getByPlaceholderText('wifi.ip_placeholder'), {
    target: { value: '192.168.1.20' },
  })
  fireEvent.click(view.getByText('wifi.tunnel_start'))
  expect(startWifiTunnel).toHaveBeenCalledWith('192.168.1.20', 49152)
  return { view, reject: (err: Error) => reject(err) }
}

describe('DeviceAddView tunnel failure', () => {
  it('still reports the failure when the panel closed mid-request', async () => {
    const { view, reject } = startTunnel()
    view.unmount()

    await act(async () => { reject(new Error('timed out')) })

    expect(showToast).toHaveBeenCalledWith('device.tunnel_failed: timed out', 6000)
  })

  it('shows the error inline (no toast) while the view is still open', async () => {
    const { view, reject } = startTunnel()

    await act(async () => { reject(new Error('timed out')) })

    expect(view.getByText('timed out')).toBeTruthy()
    expect(showToast).not.toHaveBeenCalled()
  })
})
