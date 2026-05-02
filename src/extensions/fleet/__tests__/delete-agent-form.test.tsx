import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DeleteAgentForm } from '../panels/delete-agent-form'

beforeEach(() => {
  vi.restoreAllMocks()
})

const AGENT = 'hello-bot'

/**
 * Modal renders via createPortal into document.body, so screen-query
 * helpers (getByTestId etc.) all resolve correctly without container
 * scoping. Same pattern as CreateAgentForm tests.
 */
describe('<DeleteAgentForm />', () => {
  it('does not render when agentName is null', () => {
    const { container } = render(
      <DeleteAgentForm
        agentName={null}
        onDeleted={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    // createPortal renders into document.body, but when agentName is
    // null the component returns null — nothing in the body.
    expect(
      document.body.querySelector('[data-testid="delete-agent-modal"]'),
    ).toBeNull()
    // And the test-rendering container itself is empty.
    expect(container.firstChild).toBeNull()
  })

  it('renders the modal when agentName is provided', () => {
    render(
      <DeleteAgentForm
        agentName={AGENT}
        onDeleted={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(
      document.body.querySelector('[data-testid="delete-agent-modal"]'),
    ).not.toBeNull()
    // Title contains the agent name.
    expect(document.body.textContent).toContain(AGENT)
  })

  it('disables Delete until the operator types the agent name exactly', () => {
    render(
      <DeleteAgentForm
        agentName={AGENT}
        onDeleted={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    const submit = document.body.querySelector(
      '[data-testid="delete-agent-submit"]',
    ) as HTMLButtonElement
    const input = document.body.querySelector(
      '[data-testid="delete-agent-confirm-input"]',
    ) as HTMLInputElement

    expect(submit).toBeDefined()
    expect(submit.disabled).toBe(true)

    // Partial match — still disabled
    fireEvent.change(input, { target: { value: 'hello' } })
    expect(submit.disabled).toBe(true)

    // Wrong case — still disabled (regex is case-sensitive on the
    // server, so the client check must be exact too)
    fireEvent.change(input, { target: { value: 'HELLO-BOT' } })
    expect(submit.disabled).toBe(true)

    // Exact match — enabled
    fireEvent.change(input, { target: { value: AGENT } })
    expect(submit.disabled).toBe(false)
  })

  it('issues DELETE /api/fleet/agents/{name} on submit and calls onDeleted on 200', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            agentName: AGENT,
            deletedResources: {
              serviceArn: 'arn:aws:ecs:...:service/x/s',
              listenerRuleArn: 'arn:listener-rule:r1',
              targetGroupArn: 'arn:tg:abc',
              logGroup: '/ecs/...',
            },
            warnings: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ) as unknown as Response,
    )
    const onDeleted = vi.fn()
    render(
      <DeleteAgentForm
        agentName={AGENT}
        onDeleted={onDeleted}
        onClose={vi.fn()}
      />,
    )
    const input = document.body.querySelector(
      '[data-testid="delete-agent-confirm-input"]',
    ) as HTMLInputElement
    fireEvent.change(input, { target: { value: AGENT } })
    const submit = document.body.querySelector(
      '[data-testid="delete-agent-submit"]',
    ) as HTMLButtonElement
    fireEvent.click(submit)

    await waitFor(() => {
      expect(
        document.body.querySelector('[data-testid="delete-agent-success"]'),
      ).not.toBeNull()
    })
    expect(onDeleted).toHaveBeenCalledTimes(1)
    // DELETE method, correct URL
    const call = fetchMock.mock.calls[0]
    expect(call[0]).toBe(`/api/fleet/agents/${AGENT}`)
    expect(call[1]?.method).toBe('DELETE')
  })

  it('shows error banner with SDK error name on a 502 response', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            error: 'AccessDeniedException',
            detail: 'IAM blocked the call',
            failedResources: { listenerRuleArn: '(unknown)' },
          }),
          { status: 502, headers: { 'content-type': 'application/json' } },
        ) as unknown as Response,
    )
    const onDeleted = vi.fn()
    render(
      <DeleteAgentForm
        agentName={AGENT}
        onDeleted={onDeleted}
        onClose={vi.fn()}
      />,
    )
    const input = document.body.querySelector(
      '[data-testid="delete-agent-confirm-input"]',
    ) as HTMLInputElement
    fireEvent.change(input, { target: { value: AGENT } })
    const submit = document.body.querySelector(
      '[data-testid="delete-agent-submit"]',
    ) as HTMLButtonElement
    fireEvent.click(submit)

    await waitFor(() => {
      expect(
        document.body.querySelector('[data-testid="delete-agent-error"]'),
      ).not.toBeNull()
    })
    const errBanner = document.body.querySelector(
      '[data-testid="delete-agent-error"]',
    )
    expect(errBanner?.textContent).toContain('AccessDeniedException')
    expect(errBanner?.textContent).toContain('502')
    // onDeleted NOT called on error path — stays open for retry
    expect(onDeleted).not.toHaveBeenCalled()
  })

  it('closes via Cancel button when not submitting', () => {
    const onClose = vi.fn()
    render(
      <DeleteAgentForm
        agentName={AGENT}
        onDeleted={vi.fn()}
        onClose={onClose}
      />,
    )
    const cancel = document.body.querySelector(
      '[data-testid="delete-agent-cancel"]',
    ) as HTMLButtonElement
    fireEvent.click(cancel)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not include service-name parsing — modal receives parsed agentName from parent', async () => {
    // Defense in depth: the modal uses the prop directly in the DELETE
    // URL. The parent (fleet-panel) is responsible for extracting the
    // agent name from the service name. Asserting the URL shape here
    // catches a regression where the modal accidentally URL-encodes
    // or mutates the name.
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            agentName: AGENT,
            deletedResources: {},
            warnings: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ) as unknown as Response,
    )
    render(
      <DeleteAgentForm
        agentName={AGENT}
        onDeleted={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    const input = document.body.querySelector(
      '[data-testid="delete-agent-confirm-input"]',
    ) as HTMLInputElement
    fireEvent.change(input, { target: { value: AGENT } })
    fireEvent.click(
      document.body.querySelector(
        '[data-testid="delete-agent-submit"]',
      ) as HTMLButtonElement,
    )
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled()
    })
    // Exact URL — no encoding (agent names are AGENT_NAME_RE so they
    // never contain special characters), no path traversal.
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/fleet/agents/${AGENT}`)
  })
})
