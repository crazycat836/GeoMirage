// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createContext, useContext, useState, type ReactNode } from 'react'
import { render, act, cleanup } from '@testing-library/react'

type FakeSim = Record<string, unknown>
const h = vi.hoisted(() => ({ setSim: null as null | ((fn: (s: FakeSim) => FakeSim) => void) }))

vi.mock('./SimContext', () => {
  const Ctx = createContext<FakeSim | null>(null)
  function FakeSimProvider({ children }: { children: ReactNode }) {
    const [sim, set] = useState<FakeSim>(() => ({
      mode: 'navigate',
      moveMode: 'walking',
      status: { running: true, paused: false },
      currentPosition: { lat: 25, lng: 121 },
      destination: null,
      waypoints: [],
      customSpeedKmh: null,
      speedMinKmh: null,
      speedMaxKmh: null,
      effectiveSpeed: null,
      ddiMounting: false,
      runtimes: { A: { udid: 'A', tunnelDegraded: false }, B: { udid: 'B', tunnelDegraded: false } },
    }))
    h.setSim = set
    return <Ctx.Provider value={sim}>{children}</Ctx.Provider>
  }
  return { FakeSimProvider, useSimState: () => useContext(Ctx) }
})

import * as SimContextMock from './SimContext'
import { SimDerivedProvider, useSimDerived, useSimOverview, type SimOverviewValue } from './SimDerivedContext'

const FakeSimProvider = (SimContextMock as unknown as { FakeSimProvider: (p: { children: ReactNode }) => ReactNode }).FakeSimProvider

afterEach(cleanup)

describe('SimOverview', () => {
  it('keeps its value across position ticks and changes when a run-level field does', () => {
    const overviewRenders = vi.fn()
    const derivedRenders = vi.fn()
    let overview: SimOverviewValue | null = null
    function OverviewConsumer() {
      overview = useSimOverview()
      overviewRenders()
      return null
    }
    function DerivedConsumer() {
      useSimDerived()
      derivedRenders()
      return null
    }
    render(
      <FakeSimProvider>
        <SimDerivedProvider>
          <OverviewConsumer />
          <DerivedConsumer />
        </SimDerivedProvider>
      </FakeSimProvider>,
    )
    const o0 = overviewRenders.mock.calls.length
    const d0 = derivedRenders.mock.calls.length

    // Position tick: new position, new status object, rebuilt runtimes map.
    act(() => {
      h.setSim!((s) => ({
        ...s,
        currentPosition: { lat: 25.001, lng: 121 },
        status: { running: true, paused: false },
        runtimes: { A: { udid: 'A', tunnelDegraded: false }, B: { udid: 'B', tunnelDegraded: false } },
      }))
    })
    expect(derivedRenders.mock.calls.length).toBe(d0 + 1)
    expect(overviewRenders.mock.calls.length).toBe(o0)

    // A tunnel degrading is overview-level.
    act(() => {
      h.setSim!((s) => ({
        ...s,
        runtimes: { A: { udid: 'A', tunnelDegraded: false }, B: { udid: 'B', tunnelDegraded: true } },
      }))
    })
    expect(overviewRenders.mock.calls.length).toBe(o0 + 1)
    expect(overview!.tunnelDegradedUdids).toEqual(['B'])

    // So is pausing.
    act(() => {
      h.setSim!((s) => ({ ...s, status: { running: true, paused: true } }))
    })
    expect(overview!.isPaused).toBe(true)
  })
})
