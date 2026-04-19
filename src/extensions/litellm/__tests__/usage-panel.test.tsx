import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

const mockT = (key: string, values?: Record<string, any>) => {
  // Return a readable value similar to literal text for assertions.
  // For keys like 'totalCalls' we just return the key; tests assert on testid.
  return key
}

vi.mock('next-intl', () => ({
  useTranslations: () => mockT,
}))

// Silence ResponsiveContainer jsdom complaints by mocking recharts to simple divs
vi.mock('recharts', () => {
  const Passthrough = ({ children }: any) => React.createElement('div', { 'data-testid': 'mock-recharts' }, children)
  return {
    ResponsiveContainer: Passthrough,
    ComposedChart: Passthrough,
    BarChart: Passthrough,
    Bar: () => null,
    Line: () => null,
    XAxis: () => null,
    YAxis: () => null,
    CartesianGrid: () => null,
    Tooltip: () => null,
  }
})

import { LitellmUsagePanel } from '../panels/usage-panel'

function summaryFixture(overrides: Partial<any> = {}) {
  return {
    window: '24h',
    totals: {
      calls: 100,
      cost_usd: 12.3456,
      prompt_tokens: 5000,
      completion_tokens: 2000,
      total_tokens: 7000,
      avg_latency_ms: 1500,
      cache_hit_rate: 0.2,
      error_rate: 0.03,
      success_rate: 0.97,
    },
    by_model: [
      { model: 'claude-opus', calls: 60, cost_usd: 10, total_tokens: 4000, avg_tokens: 66, avg_latency_ms: 2500 },
      { model: 'gpt-5', calls: 40, cost_usd: 2.3, total_tokens: 3000, avg_tokens: 75, avg_latency_ms: 800 },
    ],
    by_user: [
      { user_id: 'ender', calls: 80, cost_usd: 11, total_tokens: 6000 },
      { user_id: 'alexis', calls: 20, cost_usd: 1.3, total_tokens: 1000 },
    ],
    by_hour: [
      { bucket: '2026-04-18T10', calls: 40, cost_usd: 5, total_tokens: 2000 },
      { bucket: '2026-04-18T11', calls: 60, cost_usd: 7.3456, total_tokens: 5000 },
    ],
    ...overrides,
  }
}

function recordsFixture(records: any[] = []) {
  return { records, total: records.length, limit: 25, offset: 0 }
}

interface FetchStep {
  match: (url: string) => boolean
  respond: () => any
}

function installFetch(steps: FetchStep[]) {
  const fetchMock = vi.fn(async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : (url as URL).toString()
    const step = steps.find(s => s.match(u))
    if (!step) {
      return {
        ok: false,
        status: 500,
        json: async () => ({ error: 'unexpected fetch: ' + u }),
      }
    }
    const data = step.respond()
    return {
      ok: true,
      status: 200,
      json: async () => data,
    }
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

async function flush() {
  // Let pending promises/microtasks settle
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('LitellmUsagePanel', () => {
  it('renders stat cards with fetched data', async () => {
    installFetch([
      { match: u => u.includes('/dashboard/summary'), respond: () => summaryFixture() },
      { match: u => u.includes('/dashboard/records'), respond: () => recordsFixture() },
    ])

    render(<LitellmUsagePanel />)
    await waitFor(() => expect(screen.getByTestId('stat-calls')).toBeTruthy())

    expect(screen.getByTestId('stat-calls').textContent).toContain('100')
    expect(screen.getByTestId('stat-cost').textContent).toContain('$12.3456')
    expect(screen.getByTestId('stat-tokens').textContent).toContain('7')
    expect(screen.getByTestId('stat-latency')).toBeTruthy()
  })

  it('window selector triggers new fetch with correct param', async () => {
    const fetchMock = installFetch([
      { match: u => u.includes('/dashboard/summary'), respond: () => summaryFixture() },
      { match: u => u.includes('/dashboard/records'), respond: () => recordsFixture() },
    ])

    render(<LitellmUsagePanel />)
    await waitFor(() => expect(screen.getByTestId('stat-calls')).toBeTruthy())

    const initialCalls = fetchMock.mock.calls.filter(c => String(c[0]).includes('/dashboard/summary')).length

    fireEvent.click(screen.getByTestId('window-7d'))
    await flush()

    const newCalls = fetchMock.mock.calls.filter(c => String(c[0]).includes('window=7d'))
    expect(newCalls.length).toBeGreaterThan(0)
    expect(fetchMock.mock.calls.filter(c => String(c[0]).includes('/dashboard/summary')).length).toBeGreaterThan(initialCalls)
  })

  it('sortable by-model table reverses direction when clicking same header', async () => {
    installFetch([
      { match: u => u.includes('/dashboard/summary'), respond: () => summaryFixture() },
      { match: u => u.includes('/dashboard/records'), respond: () => recordsFixture() },
    ])

    render(<LitellmUsagePanel />)
    await waitFor(() => expect(screen.getByTestId('by-model')).toBeTruthy())

    const byModel = screen.getByTestId('by-model')
    // initial sort: cost desc → claude-opus (10) first, gpt-5 (2.3) second
    const rowsBefore = byModel.querySelectorAll('tbody tr')
    expect(rowsBefore[0].textContent).toContain('claude-opus')

    // Click cost header → toggle to asc
    fireEvent.click(byModel.querySelector('[data-testid="sort-cost_usd"]')!)
    await flush()
    const rowsAfter = byModel.querySelectorAll('tbody tr')
    expect(rowsAfter[0].textContent).toContain('gpt-5')
  })

  it('empty state renders when no calls', async () => {
    installFetch([
      {
        match: u => u.includes('/dashboard/summary'),
        respond: () =>
          summaryFixture({
            totals: {
              calls: 0,
              cost_usd: 0,
              prompt_tokens: 0,
              completion_tokens: 0,
              total_tokens: 0,
              avg_latency_ms: 0,
              cache_hit_rate: 0,
              error_rate: 0,
              success_rate: 0,
            },
            by_model: [],
            by_user: [],
            by_hour: [],
          }),
      },
      { match: u => u.includes('/dashboard/records'), respond: () => recordsFixture() },
    ])

    render(<LitellmUsagePanel />)
    await waitFor(() => expect(screen.getByTestId('litellm-empty')).toBeTruthy())
  })

  it('error banner renders on 500', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'boom' }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    render(<LitellmUsagePanel />)
    await waitFor(() => expect(screen.getByTestId('litellm-error')).toBeTruthy())
    expect(screen.getByTestId('litellm-error').textContent).toContain('boom')
  })

  it('search input triggers debounced records refetch', async () => {
    const fetchMock = installFetch([
      { match: u => u.includes('/dashboard/summary'), respond: () => summaryFixture() },
      { match: u => u.includes('/dashboard/records'), respond: () => recordsFixture() },
    ])

    render(<LitellmUsagePanel />)
    await waitFor(() => expect(screen.getByTestId('litellm-search')).toBeTruthy())

    const input = screen.getByTestId('litellm-search') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'gpt' } })

    // advance past debounce (300ms)
    await act(async () => {
      vi.advanceTimersByTime(400)
    })
    await flush()

    const callsWithQuery = fetchMock.mock.calls.filter(c =>
      String(c[0]).includes('/dashboard/records') && String(c[0]).includes('model=gpt')
    )
    expect(callsWithQuery.length).toBeGreaterThan(0)
  })
})
