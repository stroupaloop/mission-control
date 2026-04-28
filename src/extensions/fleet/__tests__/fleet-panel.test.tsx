import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { FleetPanel } from '../panels/fleet-panel'

// Use vitest's globalThis.fetch mocking pattern (matches MC fork's litellm
// usage-panel.test.tsx style — fetch is mocked per-test rather than via a
// global jest fetch shim).

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('<FleetPanel />', () => {
  it('renders services from the API', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          cluster: 'ender-stack-dev',
          region: 'us-east-1',
          services: [
            {
              name: 'ender-stack-dev-companion-openclaw-smoke-test',
              status: 'ACTIVE',
              desiredCount: 1,
              runningCount: 1,
              pendingCount: 0,
              taskDefinition: 'arn:...',
              launchType: 'FARGATE',
              activeDeployments: 1,
            },
          ],
          truncated: false,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ) as unknown as Response,
    )

    render(<FleetPanel />)

    await waitFor(() =>
      expect(
        screen.getByText('ender-stack-dev-companion-openclaw-smoke-test'),
      ).toBeInTheDocument(),
    )
    expect(screen.getByText('ACTIVE')).toBeInTheDocument()
    expect(screen.getByText(/Cluster:/)).toBeInTheDocument()
    // Truncation banner only appears when truncated=true
    expect(screen.queryByText(/Result truncated/)).not.toBeInTheDocument()
  })

  it('renders truncation warning when API reports truncated=true', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          cluster: 'ender-stack-dev',
          region: 'us-east-1',
          services: [],
          truncated: true,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ) as unknown as Response,
    )

    render(<FleetPanel />)

    await waitFor(() =>
      expect(screen.getByText(/Result truncated/)).toBeInTheDocument(),
    )
  })

  it('renders harness-aware copy when truncated AND no results AND harnessOnly', async () => {
    // Simulates the joint state Claude Auditor + Greptile flagged: cluster
    // has > 100 services but none of the first 100 carry Component=agent-harness.
    // Generic empty-state would say "no harnesses found" without acknowledging
    // the truncation; harness-aware copy explains the page cap explicitly.
    //
    // mockImplementation (not mockResolvedValue) constructs a fresh Response
    // for each call — Response body streams are single-use, so a shared
    // mocked Response throws on the second `.json()` and the panel
    // silently drops to its NetworkError branch.
    const mkResp = () =>
      new Response(
        JSON.stringify({
          cluster: 'ender-stack-dev',
          region: 'us-east-1',
          services: [],
          truncated: true,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(mkResp()))

    render(<FleetPanel />)

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled())
    const checkbox = screen.getByLabelText(/Agent harnesses only/) as HTMLInputElement
    await act(async () => {
      checkbox.click()
    })

    // Match via data-testid since JSX-rendered multi-line strings can be
    // split across text nodes that defeat regex/string matchers.
    const banner = await screen.findByTestId('truncation-banner')
    expect(banner.textContent).toMatch(
      /the harness filter only sees the first 100/,
    )
    const empty = await screen.findByTestId('empty-state')
    expect(empty.textContent).toMatch(/More services may exist beyond the page cap/)
  })

  it('renders error state on 502 from API', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: 'AccessDeniedException',
        }),
        { status: 502, headers: { 'content-type': 'application/json' } },
      ) as unknown as Response,
    )

    render(<FleetPanel />)

    await waitFor(() =>
      expect(screen.getByText('Failed to load fleet')).toBeInTheDocument(),
    )
    expect(screen.getByText('AccessDeniedException')).toBeInTheDocument()
  })

  it('renders empty-state when API returns zero services', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          cluster: 'ender-stack-dev',
          region: 'us-east-1',
          services: [],
          truncated: false,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ) as unknown as Response,
    )

    render(<FleetPanel />)

    await waitFor(() =>
      expect(
        screen.getByText(/No services in/),
      ).toBeInTheDocument(),
    )
  })

  it('passes ?harness=true on the fetch when the toggle is on', async () => {
    // Use mockImplementation so each fetch call gets a fresh Response —
    // body streams are single-use and a shared Response would throw on
    // the second `.json()`, dropping the panel into its NetworkError
    // branch. Today this test only asserts on URL inspection so the
    // hidden failure isn't visible, but matching the documented pattern
    // here (see truncated+harness test below) keeps the trap from biting
    // a future maintainer adding output assertions.
    const mkResp = () =>
      new Response(
        JSON.stringify({
          cluster: 'ender-stack-dev',
          region: 'us-east-1',
          services: [],
          truncated: false,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(mkResp()))

    render(<FleetPanel />)

    // First load — toggle off, no query string
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled())
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/fleet/services')

    // Click the harness-only checkbox; wrap in act() so the resulting
    // useEffect-driven refetch flushes before assertion.
    const checkbox = screen.getByLabelText(/Agent harnesses only/)
    await act(async () => {
      checkbox.click()
    })

    await waitFor(() =>
      expect(
        fetchSpy.mock.calls.some(
          (c) => c[0] === '/api/fleet/services?harness=true',
        ),
      ).toBe(true),
    )
  })

  it('renders the Refresh button in loading state on initial mount', async () => {
    // Hold fetch open so we can observe the initial-loading state.
    let resolveFetch: (resp: Response) => void = () => {}
    const fetchPromise = new Promise<Response>((resolve) => {
      resolveFetch = resolve
    })
    vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(fetchPromise)

    render(<FleetPanel />)

    // Loading text should be visible from t=0 because we initialize
    // useState(true) — not after useEffect fires.
    expect(screen.getByText(/Loading…/)).toBeInTheDocument()

    resolveFetch(
      new Response(
        JSON.stringify({
          cluster: 'ender-stack-dev',
          region: 'us-east-1',
          services: [],
          truncated: false,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )

    await waitFor(() =>
      expect(screen.getByText(/Refresh/)).toBeInTheDocument(),
    )
  })
})
