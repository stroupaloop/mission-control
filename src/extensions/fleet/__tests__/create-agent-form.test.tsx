import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CreateAgentForm } from '../panels/create-agent-form'

beforeEach(() => {
  vi.restoreAllMocks()
})

const validInputs = {
  agentName: 'smoke-2',
  image: 'ghcr.io/stroupaloop/openclaw:sha-abc1234',
  roleDescription: 'Phase 2.2 vertical-slice smoke test',
}

function fill(inputs: Partial<typeof validInputs> = {}) {
  const merged = { ...validInputs, ...inputs }
  fireEvent.change(screen.getByLabelText(/Agent name/i), {
    target: { value: merged.agentName },
  })
  fireEvent.change(screen.getByLabelText(/Container image/i), {
    target: { value: merged.image },
  })
  fireEvent.change(screen.getByLabelText(/Role description/i), {
    target: { value: merged.roleDescription },
  })
}

describe('<CreateAgentForm />', () => {
  it('disables Create until all fields are valid', () => {
    render(<CreateAgentForm onCreated={vi.fn()} onClose={vi.fn()} />)
    const submit = screen.getByRole('button', { name: /Create agent/i })
    expect(submit).toBeDisabled()
    fill()
    expect(submit).not.toBeDisabled()
  })

  it('rejects an agent name with a leading hyphen at the client layer', () => {
    render(<CreateAgentForm onCreated={vi.fn()} onClose={vi.fn()} />)
    fill({ agentName: '-bad' })
    expect(
      screen.getByRole('button', { name: /Create agent/i }),
    ).toBeDisabled()
  })

  it('rejects an agent name with a trailing hyphen at the client layer', () => {
    render(<CreateAgentForm onCreated={vi.fn()} onClose={vi.fn()} />)
    fill({ agentName: 'bad-' })
    expect(
      screen.getByRole('button', { name: /Create agent/i }),
    ).toBeDisabled()
  })

  it('rejects an image without a tag separator at the client layer', () => {
    render(<CreateAgentForm onCreated={vi.fn()} onClose={vi.fn()} />)
    fill({ image: 'ghcr.io/stroupaloop/openclaw' })
    expect(
      screen.getByRole('button', { name: /Create agent/i }),
    ).toBeDisabled()
  })

  it('rejects a whitespace-only role description at the client layer', () => {
    render(<CreateAgentForm onCreated={vi.fn()} onClose={vi.fn()} />)
    fill({ roleDescription: '    ' })
    expect(
      screen.getByRole('button', { name: /Create agent/i }),
    ).toBeDisabled()
  })

  it('POSTs the expected JSON body and surfaces success state with warnings', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          agentName: 'smoke-2',
          resources: {
            serviceArn: 'arn:aws:ecs:us-east-1:1:service/c/s',
            taskDefinitionArn: 'arn:aws:ecs:us-east-1:1:task-definition/t:1',
            targetGroupArn:
              'arn:aws:elasticloadbalancing:us-east-1:1:targetgroup/tg/abc',
            listenerRuleArn:
              'arn:aws:elasticloadbalancing:us-east-1:1:listener-rule/app/lb/abc/lst/rule',
            logGroup: '/ecs/c/companion-openclaw-smoke-2',
            listenerPath: '/agent/smoke-2 (+ /agent/smoke-2/*)',
          },
          warnings: [
            {
              code: 'runtime-config-gap',
              message:
                'Agent task will fail health checks until ender-stack#215 closes…',
            },
          ],
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      ) as unknown as Response,
    )

    const onCreated = vi.fn()
    render(<CreateAgentForm onCreated={onCreated} onClose={vi.fn()} />)
    fill()
    fireEvent.click(screen.getByRole('button', { name: /Create agent/i }))

    await waitFor(() =>
      expect(screen.getByTestId('create-agent-success')).toBeInTheDocument(),
    )
    expect(onCreated).toHaveBeenCalledTimes(1)

    // POST body shape — handler treats agentName regex as a security
    // control; double-check the form actually emits the user's input.
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/fleet/agents',
      expect.objectContaining({ method: 'POST' }),
    )
    const body = JSON.parse(
      (fetchMock.mock.calls[0]?.[1]?.body as string) ?? '{}',
    ) as Record<string, unknown>
    expect(body).toEqual({
      harnessType: 'companion/openclaw',
      agentName: 'smoke-2',
      image: 'ghcr.io/stroupaloop/openclaw:sha-abc1234',
      roleDescription: 'Phase 2.2 vertical-slice smoke test',
      modelTier: 'sonnet-4-6',
    })

    // Warning code surfaced verbatim — Beat 3a uses stable codes
    // specifically so the UI can render specific guidance without
    // parsing message text.
    expect(screen.getByTestId('create-agent-warnings')).toHaveTextContent(
      'runtime-config-gap',
    )
  })

  it('renders an error block (with status + SDK error name) on a 502', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: 'ServerException',
          partialResources: {
            taskDefinitionArn:
              'arn:aws:ecs:us-east-1:1:task-definition/t:1',
            logGroup: '/ecs/c/companion-openclaw-smoke-2',
          },
        }),
        { status: 502, headers: { 'content-type': 'application/json' } },
      ) as unknown as Response,
    )

    const onCreated = vi.fn()
    render(<CreateAgentForm onCreated={onCreated} onClose={vi.fn()} />)
    fill()
    fireEvent.click(screen.getByRole('button', { name: /Create agent/i }))

    await waitFor(() =>
      expect(screen.getByTestId('create-agent-error')).toBeInTheDocument(),
    )
    expect(onCreated).not.toHaveBeenCalled()

    const errBox = screen.getByTestId('create-agent-error')
    expect(errBox).toHaveTextContent('502')
    expect(errBox).toHaveTextContent('ServerException')
    // Operator needs to know what to clean up — partialResources MUST
    // surface in the error block.
    expect(errBox).toHaveTextContent('task-definition/t:1')
    expect(errBox).toHaveTextContent('/ecs/c/companion-openclaw-smoke-2')
  })

  it('renders an error block with a "0 — NetworkError" code on fetch reject', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      Object.assign(new Error('boom'), { name: 'TypeError' }),
    )

    render(<CreateAgentForm onCreated={vi.fn()} onClose={vi.fn()} />)
    fill()
    fireEvent.click(screen.getByRole('button', { name: /Create agent/i }))

    await waitFor(() =>
      expect(screen.getByTestId('create-agent-error')).toBeInTheDocument(),
    )
    // Status 0 prefix is suppressed in the displayed string; we only
    // surface the SDK-style error name.
    const errBox = screen.getByTestId('create-agent-error')
    expect(errBox).toHaveTextContent('TypeError')
  })

  it('calls onClose when the operator cancels', () => {
    const onClose = vi.fn()
    render(<CreateAgentForm onCreated={vi.fn()} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('"Create another" resets the form to the idle state with empty fields', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          agentName: 'smoke-2',
          resources: {
            serviceArn: 'arn:s',
            taskDefinitionArn: 'arn:t',
            targetGroupArn: 'arn:tg',
            listenerRuleArn: 'arn:lr',
            logGroup: '/ecs/lg',
            listenerPath: '/agent/smoke-2',
          },
          warnings: [],
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      ) as unknown as Response,
    )

    render(<CreateAgentForm onCreated={vi.fn()} onClose={vi.fn()} />)
    fill()
    fireEvent.click(screen.getByRole('button', { name: /Create agent/i }))

    await waitFor(() =>
      expect(screen.getByTestId('create-agent-success')).toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole('button', { name: /Create another/i }))

    // After reset: success view is gone, form fields are empty,
    // submit is disabled (no fields filled). Defends against reset()
    // accidentally dropping any default state.
    expect(screen.queryByTestId('create-agent-success')).not.toBeInTheDocument()
    expect(screen.getByLabelText(/Agent name/i)).toHaveValue('')
    expect(screen.getByLabelText(/Container image/i)).toHaveValue('')
    expect(screen.getByLabelText(/Role description/i)).toHaveValue('')
    expect(
      screen.getByRole('button', { name: /Create agent/i }),
    ).toBeDisabled()
  })
})
