import { describe, expect, it, vi, beforeEach } from 'vitest'

// Mock the AWS SDK before importing the handler so the module-scope
// ECSClient instantiation hits our mock. Each test sets the desired
// per-call mock behaviour via the exported `__sendMock`.
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
  logger: { error: vi.fn() },
}))

const importHandler = async () => {
  const mod = await import('../api/services')
  return mod.GET
}

beforeEach(() => {
  sendMock.mockReset()
})

describe('GET /api/fleet/services', () => {
  it('returns empty services list when ListServices returns no ARNs', async () => {
    sendMock.mockResolvedValueOnce({ serviceArns: [] })

    const GET = await importHandler()
    const resp = await GET()
    const body = await resp.json()

    expect(resp.status).toBe(200)
    expect(body.services).toEqual([])
    expect(body.cluster).toBeDefined()
    expect(body.region).toBeDefined()
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
    const resp = await GET()
    const body = await resp.json()

    expect(resp.status).toBe(200)
    expect(body.services).toHaveLength(2)
    expect(body.services[0].name).toBe('ender-stack-dev-companion-openclaw-smoke-test')
    expect(body.services[0].status).toBe('ACTIVE')
    expect(body.services[0].runningCount).toBe(1)
    expect(body.services[0].activeDeployments).toBe(1)
    expect(body.services[1].name).toBe('ender-stack-dev-litellm')
  })

  it('returns 502 with SDK error name + message on AWS error', async () => {
    const awsError = Object.assign(new Error('User: ... is not authorized'), {
      name: 'AccessDeniedException',
    })
    sendMock.mockRejectedValueOnce(awsError)

    const GET = await importHandler()
    const resp = await GET()
    const body = await resp.json()

    expect(resp.status).toBe(502)
    expect(body.error).toBe('AccessDeniedException')
    expect(body.detail).toContain('not authorized')
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
    const resp = await GET()
    const body = await resp.json()

    expect(resp.status).toBe(200)
    expect(body.services).toHaveLength(12)
    // 1 ListServices + 2 DescribeServices = 3 SDK calls
    expect(sendMock).toHaveBeenCalledTimes(3)
  })
})
