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
  it('renders agents from the API', async () => {
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
    expect(screen.queryByTestId('truncation-banner')).not.toBeInTheDocument()
  })

  it('renders truncation warning when API reports truncated=true AND agents are present', async () => {
    // Truncation banner now agent-flavored — Fleet always-filters, so the
    // copy talks about "agents may be missing" not "services truncated".
    // Banner is only shown when services.length > 0; when there are zero
    // agents the empty-state copy carries the same warning, so showing
    // both would just duplicate the message.
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
              taskDefinition: 'family:1',
              launchType: 'FARGATE',
              activeDeployments: 0,
            },
          ],
          truncated: true,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ) as unknown as Response,
    )

    render(<FleetPanel />)

    const banner = await screen.findByTestId('truncation-banner')
    expect(banner.textContent).toMatch(/some agents may be missing/)
  })

  it('suppresses truncation banner when services=[] (empty-state copy carries the warning)', async () => {
    // Joint state truncated=true + services=[] — the empty-state alone is
    // sufficient. Banner would be redundant.
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

    // Empty-state is shown
    const empty = await screen.findByTestId('empty-state')
    expect(empty.textContent).toMatch(/More services may exist beyond the page cap/)
    // Banner is suppressed
    expect(screen.queryByTestId('truncation-banner')).not.toBeInTheDocument()
  })

  it('renders agent-flavored empty-state when API returns zero agents', async () => {
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

    const empty = await screen.findByTestId('empty-state')
    expect(empty.textContent).toMatch(/No agents currently deployed/)
  })

  it('renders truncation-aware empty-state when truncated AND no agents', async () => {
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

    const empty = await screen.findByTestId('empty-state')
    expect(empty.textContent).toMatch(
      /No agents found in the first 100 services\. More services may exist/,
    )
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

  it('fetches /api/fleet/services without query params (no opt-in filter)', async () => {
    // Fleet's filter is always-on server-side — the panel never sends
    // `?harness=...`. Test guards against accidental reintroduction of
    // an opt-in toggle.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
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

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled())
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/fleet/services')
    // No checkbox in the UI — the toggle was removed when the filter
    // moved to always-on.
    expect(screen.queryByLabelText(/Agent harnesses only/)).not.toBeInTheDocument()
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

describe('<FleetPanel /> — Redeploy button', () => {
  // Helpers — the panel makes 1 fetch (services) on mount, then 1 fetch
  // (redeploy) on click, then 1 fetch (services again) to refresh post-rollout.
  // mockImplementation factory because Response body streams are single-use.
  const mkServicesResp = (services: unknown[] = [], truncated = false) =>
    new Response(
      JSON.stringify({
        cluster: 'ender-stack-dev',
        region: 'us-east-1',
        services,
        truncated,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )

  const stableSvc = {
    name: 'ender-stack-dev-companion-openclaw-smoke-test',
    status: 'ACTIVE',
    desiredCount: 1,
    runningCount: 1,
    pendingCount: 0,
    taskDefinition: 'family:1',
    launchType: 'FARGATE',
    activeDeployments: 0, // steady state — Redeploy enabled
  }

  it('POSTs to /api/fleet/services/:name/redeploy, refreshes table, and re-enables the button', async () => {
    // Auditor flagged: prior implementation set kind:'rolling' and never
    // reset, so the button stayed permanently disabled until hard reload.
    // This test simulates the operator-real flow: click → 202 → refresh
    // shows ECS already on a fresh task (activeDeployments=0) → button
    // back to enabled. The disable predicate now keys solely on
    // activeDeployments + the in-flight POST flag — ECS is the source of
    // truth for "rolling".
    const calls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const u = String(url)
      calls.push(u)
      if (u.endsWith('/redeploy')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              deploymentId: 'ecs-svc/new',
              taskDefinition: 'family:1',
            }),
            { status: 202, headers: { 'content-type': 'application/json' } },
          ),
        )
      }
      // /api/fleet/services — return steady-state data both before AND
      // after the redeploy click. In production, the post-redeploy fetch
      // would briefly show activeDeployments=1 then drop to 0 once ECS
      // reports COMPLETED. We collapse to "0 throughout" since the
      // disable predicate is the same shape either way and asserting
      // re-enabled is the regression we care about.
      return Promise.resolve(mkServicesResp([stableSvc]))
    })

    render(<FleetPanel />)

    const button = await screen.findByTestId(`redeploy-${stableSvc.name}`)
    expect(button).toBeEnabled()

    await act(async () => {
      ;(button as HTMLButtonElement).click()
    })

    // Right URL was POSTed
    await waitFor(() =>
      expect(
        calls.some((c) =>
          c.endsWith(`/api/fleet/services/${stableSvc.name}/redeploy`),
        ),
      ).toBe(true),
    )
    // Table refresh fetch followed
    await waitFor(() =>
      expect(calls.filter((c) => c === '/api/fleet/services').length).toBeGreaterThanOrEqual(2),
    )
    // Button re-enabled after the refresh — regression guard for the
    // 'rolling' state bug Auditor flagged on the initial commit.
    await waitFor(() =>
      expect(screen.getByTestId(`redeploy-${stableSvc.name}`)).toBeEnabled(),
    )
  })

  it('renders an inline error if the redeploy POST returns 502', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const u = String(url)
      if (u.endsWith('/redeploy')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ error: 'AccessDeniedException' }),
            { status: 502, headers: { 'content-type': 'application/json' } },
          ),
        )
      }
      return Promise.resolve(mkServicesResp([stableSvc]))
    })

    render(<FleetPanel />)
    const button = await screen.findByTestId(`redeploy-${stableSvc.name}`)
    await act(async () => {
      ;(button as HTMLButtonElement).click()
    })

    const errorEl = await screen.findByTestId(
      `redeploy-error-${stableSvc.name}`,
    )
    expect(errorEl.textContent).toMatch(/AccessDeniedException/)
  })

  it('disables Redeploy button when activeDeployments > 0 (avoids double-rolling)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        mkServicesResp([{ ...stableSvc, activeDeployments: 1 }]),
      ),
    )

    render(<FleetPanel />)
    const button = await screen.findByTestId(`redeploy-${stableSvc.name}`)
    expect(button).toBeDisabled()
    // Button label flips to "Rolling…" when ECS already shows IN_PROGRESS
    expect(button.textContent).toMatch(/Rolling/)
  })
})
