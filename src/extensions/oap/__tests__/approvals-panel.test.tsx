import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

const mockT = (key: string, values?: Record<string, any>) => {
  if (!values) return key
  let out = key
  for (const k of Object.keys(values)) out += `:${k}=${values[k]}`
  return out
}

vi.mock('next-intl', () => ({
  useTranslations: () => mockT,
}))

import { OapApprovalsPanel } from '../panels/approvals-panel'

const SAMPLE = [
  {
    decision_id: 'decision-alpha-12345',
    capability: 'exec:read:filesystem',
    risk: 'low',
    agent: 'codex-runner',
    reason: 'Reading /etc/hosts',
    created_at: Date.now() - 5 * 60_000,
  },
  {
    decision_id: 'decision-beta-67890',
    capability: 'net:outbound:github.com',
    risk: 'high',
    agent: 'research-bot',
    reason: 'Cloning repository',
    created_at: Date.now() - 60_000,
  },
  {
    decision_id: 'decision-gamma-98765',
    capability: 'exec:write:filesystem',
    risk: 'critical',
    agent: 'deployer',
    reason: 'Writing to /var/lib',
    created_at: Date.now() - 10 * 60_000,
  },
]

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function installFetch(responses: Array<() => any>) {
  const fn = vi.fn().mockImplementation(() => {
    const next = responses.shift()
    if (!next) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ pending: SAMPLE }) })
    }
    return Promise.resolve(next())
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

async function settle() {
  await new Promise(r => setTimeout(r, 50))
}

describe('OapApprovalsPanel', () => {
  it('renders pending decisions from the API', async () => {
    installFetch([
      () => ({ ok: true, status: 200, json: async () => ({ pending: SAMPLE }) }),
    ])
    render(<OapApprovalsPanel />)

    await waitFor(() => {
      expect(screen.queryAllByTestId('oap-row').length).toBe(3)
    })
    expect(screen.getByText(/codex-runner/)).toBeInTheDocument()
    expect(screen.getByText(/research-bot/)).toBeInTheDocument()
    expect(screen.getByText(/deployer/)).toBeInTheDocument()
  })

  it('shows empty state when there are no pending decisions', async () => {
    installFetch([
      () => ({ ok: true, status: 200, json: async () => ({ pending: [] }) }),
    ])
    render(<OapApprovalsPanel />)
    await waitFor(() => {
      expect(screen.getByTestId('oap-empty-state')).toBeInTheDocument()
    })
  })

  it('shows retry banner when sidecar returns 502', async () => {
    installFetch([
      () => ({ ok: false, status: 502, json: async () => ({ error: 'OAP sidecar unreachable' }) }),
    ])
    render(<OapApprovalsPanel />)
    await waitFor(() => {
      expect(screen.getByText(/sidecarUnreachable/)).toBeInTheDocument()
    })
  })

  it('approves a decision via POST with correct payload', async () => {
    const fetchMock = installFetch([
      () => ({ ok: true, status: 200, json: async () => ({ pending: SAMPLE }) }),
      () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
    ])
    render(<OapApprovalsPanel />)
    await waitFor(() => expect(screen.queryAllByTestId('oap-row').length).toBe(3))

    const approveButtons = screen.getAllByLabelText('approve')
    fireEvent.click(approveButtons[0])

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        c => c[1] && (c[1] as RequestInit).method === 'POST'
      )
      expect(postCall).toBeTruthy()
    })
    const postCall = fetchMock.mock.calls.find(
      c => c[1] && (c[1] as RequestInit).method === 'POST'
    )
    const body = JSON.parse((postCall![1] as RequestInit).body as string)
    expect(body.action).toBe('approve')
    expect(body.decision_id).toBe('decision-alpha-12345')

    // Optimistic removal
    await waitFor(() => expect(screen.queryAllByTestId('oap-row').length).toBe(2))
  })

  it('denies a decision via POST with correct payload', async () => {
    const fetchMock = installFetch([
      () => ({ ok: true, status: 200, json: async () => ({ pending: SAMPLE }) }),
      () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
    ])
    render(<OapApprovalsPanel />)
    await waitFor(() => expect(screen.queryAllByTestId('oap-row').length).toBe(3))

    const denyButtons = screen.getAllByLabelText('deny')
    fireEvent.click(denyButtons[1])

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        c => c[1] && (c[1] as RequestInit).method === 'POST'
      )
      expect(postCall).toBeTruthy()
    })
    const postCall = fetchMock.mock.calls.find(
      c => c[1] && (c[1] as RequestInit).method === 'POST'
    )
    const body = JSON.parse((postCall![1] as RequestInit).body as string)
    expect(body.action).toBe('deny')
  })

  it('calls approve_and_add action', async () => {
    const fetchMock = installFetch([
      () => ({ ok: true, status: 200, json: async () => ({ pending: SAMPLE }) }),
      () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
    ])
    render(<OapApprovalsPanel />)
    await waitFor(() => expect(screen.queryAllByTestId('oap-row').length).toBe(3))

    const btns = screen.getAllByLabelText('approveAndAdd')
    fireEvent.click(btns[0])

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        c => c[1] && (c[1] as RequestInit).method === 'POST'
      )
      expect(postCall).toBeTruthy()
    })
    const postCall = fetchMock.mock.calls.find(
      c => c[1] && (c[1] as RequestInit).method === 'POST'
    )
    const body = JSON.parse((postCall![1] as RequestInit).body as string)
    expect(body.action).toBe('approve_and_add')
  })

  it('filter tabs switch between pending, resolved, and all', async () => {
    installFetch([
      () => ({ ok: true, status: 200, json: async () => ({ pending: SAMPLE }) }),
    ])
    render(<OapApprovalsPanel />)
    await waitFor(() => expect(screen.queryAllByTestId('oap-row').length).toBe(3))

    fireEvent.click(screen.getByRole('tab', { name: 'filterResolved' }))
    await waitFor(() => expect(screen.queryAllByTestId('oap-row').length).toBe(0))

    fireEvent.click(screen.getByRole('tab', { name: 'filterAll' }))
    await waitFor(() => expect(screen.queryAllByTestId('oap-row').length).toBe(3))
  })

  it('search filters rows in real time', async () => {
    installFetch([
      () => ({ ok: true, status: 200, json: async () => ({ pending: SAMPLE }) }),
    ])
    render(<OapApprovalsPanel />)
    await waitFor(() => expect(screen.queryAllByTestId('oap-row').length).toBe(3))

    const input = screen.getByLabelText('searchAria')
    fireEvent.change(input, { target: { value: 'research' } })
    await waitFor(() => expect(screen.queryAllByTestId('oap-row').length).toBe(1))
    expect(screen.getByText(/research-bot/)).toBeInTheDocument()

    fireEvent.change(input, { target: { value: 'net:outbound' } })
    await waitFor(() => expect(screen.queryAllByTestId('oap-row').length).toBe(1))

    fireEvent.change(input, { target: { value: '' } })
    await waitFor(() => expect(screen.queryAllByTestId('oap-row').length).toBe(3))
  })

  it('rolls back optimistic removal when POST fails', async () => {
    const fetchMock = installFetch([
      () => ({ ok: true, status: 200, json: async () => ({ pending: SAMPLE }) }),
      () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }),
    ])
    render(<OapApprovalsPanel />)
    await waitFor(() => expect(screen.queryAllByTestId('oap-row').length).toBe(3))

    fireEvent.click(screen.getAllByLabelText('approve')[0])

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryAllByTestId('oap-row').length).toBe(3))
  })
})