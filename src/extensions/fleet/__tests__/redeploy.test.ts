import { describe, expect, it, vi, beforeEach } from 'vitest'

// Mock AWS SDK before importing the handler so the module-scope ECSClient
// instantiation hits our mock. Mirrors the services.test.ts setup.
const sendMock = vi.fn()

vi.mock('@aws-sdk/client-ecs', () => {
  return {
    ECSClient: vi.fn().mockImplementation(() => ({
      send: sendMock,
    })),
    UpdateServiceCommand: vi.fn().mockImplementation((input: unknown) => ({
      __type: 'UpdateServiceCommand',
      input,
    })),
  }
})

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}))

// Stub auth — every test below assumes an operator (or higher) caller.
// One additional test exercises the auth-rejection branch directly.
vi.mock('@/lib/auth', () => ({
  requireRole: vi.fn(() => ({ user: { id: 'test', role: 'operator' } })),
}))

const importHandler = async () => {
  const mod = await import('../api/redeploy')
  return mod.POST
}

const mkRequest = () =>
  ({ url: 'http://localhost/api/fleet/services/svc/redeploy' }) as unknown as Parameters<
    Awaited<ReturnType<typeof importHandler>>
  >[0]

const mkParams = (name: string) =>
  ({ params: Promise.resolve({ name }) }) as unknown as Parameters<
    Awaited<ReturnType<typeof importHandler>>
  >[1]

beforeEach(() => {
  sendMock.mockReset()
})

describe('POST /api/fleet/services/:name/redeploy', () => {
  it('issues UpdateService with forceNewDeployment=true and returns 202', async () => {
    sendMock.mockResolvedValueOnce({
      service: {
        serviceArn:
          'arn:aws:ecs:us-east-1:111122223333:service/ender-stack-dev/svc-1',
        serviceName: 'svc-1',
        taskDefinition:
          'arn:aws:ecs:us-east-1:111122223333:task-definition/ender-stack-dev-svc-1:42',
        deployments: [
          { id: 'ecs-svc/new', status: 'PRIMARY', rolloutState: 'IN_PROGRESS' },
          { id: 'ecs-svc/old', status: 'ACTIVE', rolloutState: 'COMPLETED' },
        ],
      },
    })

    const POST = await importHandler()
    const resp = await POST(mkRequest(), mkParams('svc-1'))
    const body = await resp.json()

    expect(resp.status).toBe(202)
    expect(body.ok).toBe(true)
    // Newest deployment ID returned for cross-referencing CloudTrail
    expect(body.deploymentId).toBe('ecs-svc/new')
    // Task-def stripped to family:revision (no account ID)
    expect(body.taskDefinition).toBe('ender-stack-dev-svc-1:42')
    expect(body.taskDefinition).not.toContain('111122223333')

    // Verify the SDK call carried the right args
    const updateCall = sendMock.mock.calls[0][0]
    expect(updateCall.input.cluster).toBe('ender-stack-dev')
    expect(updateCall.input.service).toBe('svc-1')
    expect(updateCall.input.forceNewDeployment).toBe(true)
  })

  it('returns 404 when ECS reports ServiceNotFoundException (typo / stale UI)', async () => {
    const awsError = Object.assign(
      new Error('Service svc-typo not found in cluster ender-stack-dev'),
      { name: 'ServiceNotFoundException' },
    )
    sendMock.mockRejectedValueOnce(awsError)

    const POST = await importHandler()
    const resp = await POST(mkRequest(), mkParams('svc-typo'))
    const body = await resp.json()

    expect(resp.status).toBe(404)
    expect(body.error).toBe('ServiceNotFoundException')
    // Message stripped — no caller ARN / account ID leakage
    expect(body.detail).toBeUndefined()
  })

  it('returns 502 with SDK error name only on AccessDeniedException', async () => {
    // Surfaces during initial deploy if the IAM grant from ender-stack
    // PR #187 isn't applied yet. Operator-visible; loud failure.
    const awsError = Object.assign(
      new Error(
        'User: arn:aws:sts::111122223333:assumed-role/mc/sess is not authorized to perform: ecs:UpdateService',
      ),
      { name: 'AccessDeniedException' },
    )
    sendMock.mockRejectedValueOnce(awsError)

    const POST = await importHandler()
    const resp = await POST(mkRequest(), mkParams('svc-1'))
    const body = await resp.json()

    expect(resp.status).toBe(502)
    expect(body.error).toBe('AccessDeniedException')
    expect(body.detail).toBeUndefined()
  })

  it('encodes service name into UpdateService.service param without alteration', async () => {
    // Service names can contain dashes, dots, etc. The handler treats the
    // param as opaque — IAM resource scope is the actual auth boundary.
    sendMock.mockResolvedValueOnce({
      service: {
        serviceName: 'ender-stack-dev-companion-openclaw-smoke-test',
        taskDefinition:
          'arn:aws:ecs:us-east-1:111122223333:task-definition/x:1',
        deployments: [],
      },
    })

    const POST = await importHandler()
    await POST(
      mkRequest(),
      mkParams('ender-stack-dev-companion-openclaw-smoke-test'),
    )

    const updateCall = sendMock.mock.calls[0][0]
    expect(updateCall.input.service).toBe(
      'ender-stack-dev-companion-openclaw-smoke-test',
    )
  })
})

describe('POST /api/fleet/services/:name/redeploy — auth gate', () => {
  it('rejects viewer role (operator+ required)', async () => {
    const auth = await import('@/lib/auth')
    vi.mocked(auth.requireRole).mockReturnValueOnce({
      error: 'Requires operator role or higher',
      status: 403,
    })

    const POST = await importHandler()
    const resp = await POST(mkRequest(), mkParams('svc-1'))
    const body = await resp.json()

    expect(resp.status).toBe(403)
    expect(body.error).toBe('Requires operator role or higher')
    // No SDK call when auth rejects — important for the surface-area
    // guarantee of the operator role gate.
    expect(sendMock).not.toHaveBeenCalled()
  })
})
