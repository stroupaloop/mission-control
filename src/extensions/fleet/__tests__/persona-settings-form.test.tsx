import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PersonaSettingsForm } from '../panels/persona-settings-form'
import type { FleetServiceSummary } from '../api/services'

// Mock the store so we control the caller's role. The real store defaults
// currentUser to null; persona editing is admin-only, so each test sets the
// role it needs via this mock.
let mockRole: 'admin' | 'operator' | 'viewer' | undefined = 'admin'
vi.mock('@/store', () => ({
  useMissionControl: () => ({
    currentUser: mockRole ? { id: 1, username: 'u', role: mockRole } : null,
  }),
}))

const fetchMock = vi.fn()

beforeEach(() => {
  vi.restoreAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  mockRole = 'admin'
})

const AGENT_NAME = 'hello-bot'
const SERVICE_NAME = 'ender-stack-dev-companion-openclaw-hello-bot'

const agent: FleetServiceSummary = {
  name: SERVICE_NAME,
  status: 'ACTIVE',
  desiredCount: 1,
  runningCount: 1,
  pendingCount: 0,
  taskDefinition: `${SERVICE_NAME}:5`,
  launchType: 'FARGATE',
  activeDeployments: 0,
}

const okResp = (body: unknown, status = 200) =>
  ({ ok: true, status, json: async () => body }) as unknown as Response
const errResp = (status: number, body: unknown) =>
  ({ ok: false, status, json: async () => body }) as unknown as Response

const renderForm = () =>
  render(<PersonaSettingsForm agent={agent} agentName={AGENT_NAME} />)

describe('<PersonaSettingsForm />', () => {
  it('shows the admin-only notice for a non-admin role (no fetch)', () => {
    mockRole = 'operator'
    renderForm()
    expect(screen.getByTestId('persona-settings-no-access')).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('renders the four-file allow-list for admin and GETs the first file', async () => {
    fetchMock.mockResolvedValueOnce(
      okResp({ ok: true, agentName: AGENT_NAME, filename: 'IDENTITY.md', content: '# Identity', hash: 'h1' }),
    )
    renderForm()
    // Allow-list tabs present (exactly the four persona files).
    for (const f of ['IDENTITY.md', 'SOUL.md', 'USER.md', 'AGENTS.md']) {
      expect(screen.getByTestId(`persona-file-${f}`)).toBeTruthy()
    }
    await waitFor(() =>
      expect(screen.getByTestId('persona-editor')).toBeTruthy(),
    )
    // First file fetched via GET on the workspace endpoint.
    expect(fetchMock.mock.calls[0][0]).toContain(
      `/api/fleet/agents/${AGENT_NAME}/workspace/IDENTITY.md`,
    )
    expect((screen.getByTestId('persona-editor') as HTMLTextAreaElement).value).toBe(
      '# Identity',
    )
  })

  it('saves an edit with expected_hash and advances the snapshot', async () => {
    fetchMock.mockResolvedValueOnce(
      okResp({ ok: true, agentName: AGENT_NAME, filename: 'IDENTITY.md', content: 'old', hash: 'h1' }),
    )
    renderForm()
    const editor = (await screen.findByTestId('persona-editor')) as HTMLTextAreaElement

    fetchMock.mockResolvedValueOnce(
      okResp({ ok: true, agentName: AGENT_NAME, filename: 'IDENTITY.md', hash: 'h2', bytes: 3 }),
    )
    fireEvent.change(editor, { target: { value: 'new' } })
    // Diff shows once dirty.
    expect(screen.getByTestId('persona-diff-section')).toBeTruthy()
    fireEvent.click(screen.getByTestId('persona-save'))

    await waitFor(() =>
      expect(screen.getByTestId('persona-settings-saved')).toBeTruthy(),
    )
    const putCall = fetchMock.mock.calls[1]
    expect(putCall[1].method).toBe('PUT')
    const sentBody = JSON.parse(putCall[1].body as string)
    expect(sentBody).toEqual({ content: 'new', expected_hash: 'h1' })
    expect(putCall[1].headers['if-match']).toBe('h1')
  })

  it('handles a 409 conflict by refetching and showing the conflict banner', async () => {
    fetchMock.mockResolvedValueOnce(
      okResp({ ok: true, agentName: AGENT_NAME, filename: 'IDENTITY.md', content: 'old', hash: 'h1' }),
    )
    renderForm()
    const editor = (await screen.findByTestId('persona-editor')) as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: 'my edit' } })

    // PUT → 409 with the current server hash; then the refetch GET.
    fetchMock.mockResolvedValueOnce(
      errResp(409, { error: 'Conflict', hash: 'h-agent' }),
    )
    fetchMock.mockResolvedValueOnce(
      okResp({ ok: true, agentName: AGENT_NAME, filename: 'IDENTITY.md', content: 'agent wrote this', hash: 'h-agent' }),
    )
    fireEvent.click(screen.getByTestId('persona-save'))

    await waitFor(() =>
      expect(screen.getByTestId('persona-settings-conflict')).toBeTruthy(),
    )
    // The operator's draft is preserved for reapply.
    expect((screen.getByTestId('persona-editor') as HTMLTextAreaElement).value).toBe(
      'my edit',
    )
  })

  it('surfaces a load error with a Retry affordance', async () => {
    fetchMock.mockResolvedValueOnce(
      errResp(404, { error: 'FileNotFound', detail: 'not seeded' }),
    )
    renderForm()
    await waitFor(() =>
      expect(screen.getByTestId('persona-settings-load-error')).toBeTruthy(),
    )
    expect(screen.getByTestId('persona-settings-retry')).toBeTruthy()
  })

  it('Apply now POSTs the redeploy endpoint after confirmation', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    fetchMock.mockResolvedValueOnce(
      okResp({ ok: true, agentName: AGENT_NAME, filename: 'IDENTITY.md', content: 'x', hash: 'h1' }),
    )
    renderForm()
    await screen.findByTestId('persona-editor')

    fetchMock.mockResolvedValueOnce(okResp({ ok: true, deploymentId: 'd1' }, 202))
    fireEvent.click(screen.getByTestId('persona-apply-now'))

    await waitFor(() =>
      expect(screen.getByTestId('persona-apply-now-done')).toBeTruthy(),
    )
    const redeployCall = fetchMock.mock.calls[1]
    expect(redeployCall[0]).toContain(
      `/api/fleet/services/${SERVICE_NAME}/redeploy`,
    )
    expect(redeployCall[1].method).toBe('POST')
  })

  it('does not redeploy if the operator cancels the confirm', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false))
    fetchMock.mockResolvedValueOnce(
      okResp({ ok: true, agentName: AGENT_NAME, filename: 'IDENTITY.md', content: 'x', hash: 'h1' }),
    )
    renderForm()
    await screen.findByTestId('persona-editor')
    fireEvent.click(screen.getByTestId('persona-apply-now'))
    // Only the initial GET fired; no POST.
    expect(fetchMock.mock.calls.length).toBe(1)
  })
})
