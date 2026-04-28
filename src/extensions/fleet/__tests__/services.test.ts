import { describe, expect, it, vi, beforeEach } from 'vitest'

// Mock the AWS SDK before importing the handler so the module-scope
// ECSClient instantiation hits our mock. Each test sets the desired
// per-call mock behaviour via the shared `sendMock`.
const sendMock = vi.fn()

vi.mock('@aws-sdk/client-ecs', () => {
  return {
    ECSClient: vi.fn().mockImplementation(() => ({
      send: sendMock,
    })),
    ListServicesCommand: vi.fn().mockImplementation((input: unknown) => ({
      __type: 'ListServicesCommand',
      input,
    })),
    DescribeServicesCommand: vi.fn().mockImplementation((input: unknown) => ({
      __type: 'DescribeServicesCommand',
      input,
    })),
  }
})

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}))

// Stub auth — every test below assumes a viewer (or higher) caller.
// One additional test exercises the auth-rejection branch directly.
vi.mock('@/lib/auth', () => ({
  requireRole: vi.fn(() => ({ user: { id: 'test', role: 'viewer' } })),
}))

const importHandler = async () => {
  const mod = await import('../api/services')
  return mod.GET
}

// Minimal NextRequest stub — the handler never reads it (auth is stubbed).
const mkRequest = () =>
  ({ url: 'http://localhost/api/fleet/services' }) as unknown as Parameters<
    Awaited<ReturnType<typeof importHandler>>
  >[0]

beforeEach(() => {
  sendMock.mockReset()
})

describe('GET /api/fleet/services', () => {
  it('returns empty services list when ListServices returns no ARNs', async () => {
    sendMock.mockResolvedValueOnce({ serviceArns: [] })

    const GET = await importHandler()
    const resp = await GET(mkRequest())
    const body = await resp.json()

    expect(resp.status).toBe(200)
    expect(body.services).toEqual([])
    expect(body.cluster).toBeDefined()
    expect(body.region).toBeDefined()
    expect(body.truncated).toBe(false)
    // Only ListServices was called — no Describe needed for empty list
    expect(sendMock).toHaveBeenCalledTimes(1)
  })

  it('summarizes services when DescribeServices returns metadata', async () => {
    sendMock.mockResolvedValueOnce({
      serviceArns: [
        'arn:aws:ecs:us-east-1:111122223333:service/ender-stack-dev/ender-stack-dev-companion-openclaw-smoke-test',
        'arn:aws:ecs:us-east-1:111122223333:service/ender-stack-dev/ender-stack-dev-litellm',
      ],
    })
    sendMock.mockResolvedValueOnce({
      services: [
        {
          serviceArn:
            'arn:aws:ecs:us-east-1:111122223333:service/ender-stack-dev/ender-stack-dev-companion-openclaw-smoke-test',
          serviceName: 'ender-stack-dev-companion-openclaw-smoke-test',
          status: 'ACTIVE',
          desiredCount: 1,
          runningCount: 1,
          pendingCount: 0,
          taskDefinition: 'arn:aws:ecs:...:task-definition/ender-stack-dev-companion-openclaw-smoke-test:1',
          launchType: 'FARGATE',
          deployments: [{ id: 'ecs-svc/1' }],
        },
        {
          serviceArn:
            'arn:aws:ecs:us-east-1:111122223333:service/ender-stack-dev/ender-stack-dev-litellm',
          serviceName: 'ender-stack-dev-litellm',
          status: 'ACTIVE',
          desiredCount: 1,
          runningCount: 1,
          pendingCount: 0,
          taskDefinition: 'arn:aws:ecs:...:task-definition/ender-stack-dev-litellm:7',
          launchType: 'FARGATE',
          deployments: [{ id: 'ecs-svc/2' }],
        },
      ],
    })

    const GET = await importHandler()
    const resp = await GET(mkRequest())
    const body = await resp.json()

    expect(resp.status).toBe(200)
    expect(body.services).toHaveLength(2)
    expect(body.services[0].name).toBe('ender-stack-dev-companion-openclaw-smoke-test')
    expect(body.services[0].status).toBe('ACTIVE')
    expect(body.services[0].runningCount).toBe(1)
    expect(body.services[0].activeDeployments).toBe(1)
    expect(body.services[1].name).toBe('ender-stack-dev-litellm')
    expect(body.truncated).toBe(false)
  })

  it('returns 502 with SDK error name only (no detail) on AWS error', async () => {
    const awsError = Object.assign(
      new Error(
        'User: arn:aws:sts::111122223333:assumed-role/mc/sess is not authorized',
      ),
      { name: 'AccessDeniedException' },
    )
    sendMock.mockRejectedValueOnce(awsError)

    const GET = await importHandler()
    const resp = await GET(mkRequest())
    const body = await resp.json()

    expect(resp.status).toBe(502)
    expect(body.error).toBe('AccessDeniedException')
    // detail must NOT be in the response — AWS error messages embed
    // caller ARN / account ID / cluster ARN. Server-side log captures it.
    expect(body.detail).toBeUndefined()
  })

  it('chunks DescribeServices calls when more than 10 service ARNs', async () => {
    // Generate 12 ARNs to force the chunking branch (cap of 10 per Describe)
    const arns = Array.from(
      { length: 12 },
      (_, i) =>
        `arn:aws:ecs:us-east-1:111122223333:service/ender-stack-dev/svc-${i}`,
    )
    sendMock.mockResolvedValueOnce({ serviceArns: arns })

    // Two DescribeServices chunks
    sendMock.mockResolvedValueOnce({
      services: arns.slice(0, 10).map((arn, i) => ({
        serviceArn: arn,
        serviceName: `svc-${i}`,
        status: 'ACTIVE',
        desiredCount: 1,
        runningCount: 1,
        pendingCount: 0,
        deployments: [{}],
      })),
    })
    sendMock.mockResolvedValueOnce({
      services: arns.slice(10).map((arn, i) => ({
        serviceArn: arn,
        serviceName: `svc-${i + 10}`,
        status: 'ACTIVE',
        desiredCount: 1,
        runningCount: 1,
        pendingCount: 0,
        deployments: [{}],
      })),
    })

    const GET = await importHandler()
    const resp = await GET(mkRequest())
    const body = await resp.json()

    expect(resp.status).toBe(200)
    expect(body.services).toHaveLength(12)
    // 1 ListServices + 2 DescribeServices = 3 SDK calls
    expect(sendMock).toHaveBeenCalledTimes(3)
  })

  it('marks response truncated when ListServices fills the first page', async () => {
    const arns = Array.from(
      { length: 100 },
      (_, i) =>
        `arn:aws:ecs:us-east-1:111122223333:service/ender-stack-dev/svc-${i}`,
    )
    sendMock.mockResolvedValueOnce({ serviceArns: arns })
    // 10 chunks of 10 — return one stub service per chunk so the test
    // doesn't have to materialize 100 service objects.
    for (let i = 0; i < 10; i++) {
      sendMock.mockResolvedValueOnce({ services: [] })
    }

    const GET = await importHandler()
    const resp = await GET(mkRequest())
    const body = await resp.json()

    expect(resp.status).toBe(200)
    expect(body.truncated).toBe(true)
  })
})

describe('GET /api/fleet/services — auth gate', () => {
  it('returns the auth error response when requireRole rejects', async () => {
    const auth = await import('@/lib/auth')
    vi.mocked(auth.requireRole).mockReturnValueOnce({
      error: 'Authentication required',
      status: 401,
    })

    const GET = await importHandler()
    const resp = await GET(mkRequest())
    const body = await resp.json()

    expect(resp.status).toBe(401)
    expect(body.error).toBe('Authentication required')
    // No SDK calls when auth rejects
    expect(sendMock).not.toHaveBeenCalled()
  })
})
