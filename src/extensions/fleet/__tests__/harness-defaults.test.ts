import { describe, expect, it, vi, beforeEach } from 'vitest'

const ecsSendMock = vi.fn()

vi.mock('@aws-sdk/client-ecs', () => ({
  ECSClient: vi.fn().mockImplementation(() => ({ send: ecsSendMock })),
  DescribeServicesCommand: vi.fn().mockImplementation((input: unknown) => ({
    __type: 'DescribeServicesCommand',
    input,
  })),
  DescribeTaskDefinitionCommand: vi
    .fn()
    .mockImplementation((input: unknown) => ({
      __type: 'DescribeTaskDefinitionCommand',
      input,
    })),
}))

vi.mock('@/lib/auth', () => ({
  requireRole: vi.fn().mockReturnValue({ ok: true }),
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

async function importHandler() {
  const mod = await import('../api/harness-defaults')
  return mod.GET
}

function mkRequest() {
  return new Request('http://localhost/api/fleet/harness-defaults') as never
}

beforeEach(() => {
  ecsSendMock.mockReset()
  process.env.MC_FLEET_CLUSTER_NAME = 'ender-stack-dev'
  process.env.MC_FLEET_PROJECT_NAME = 'ender-stack'
  process.env.MC_FLEET_ENVIRONMENT = 'dev'
})

describe('GET /api/fleet/harness-defaults', () => {
  it('returns the smoke-test image as the default for companion/openclaw', async () => {
    ecsSendMock
      // DescribeServices
      .mockResolvedValueOnce({
        services: [
          {
            taskDefinition:
              'arn:aws:ecs:us-east-1:1:task-definition/ender-stack-dev-companion-openclaw-smoke-test:7',
          },
        ],
      })
      // DescribeTaskDefinition
      .mockResolvedValueOnce({
        taskDefinition: {
          containerDefinitions: [
            { name: 'init-config', image: 'init/scratch:1' },
            {
              name: 'openclaw-gateway',
              image: '1.dkr.ecr.us-east-1.amazonaws.com/ender-stack/companion-openclaw:1dcff0d',
            },
          ],
        },
      })

    const GET = await importHandler()
    const resp = await GET(mkRequest())
    expect(resp.status).toBe(200)
    const json = (await resp.json()) as {
      defaults: Record<string, { defaultImage: string | null }>
    }
    expect(json.defaults['companion/openclaw'].defaultImage).toBe(
      '1.dkr.ecr.us-east-1.amazonaws.com/ender-stack/companion-openclaw:1dcff0d',
    )
  })

  it('returns null defaultImage when the smoke-test service does not exist (fresh cluster)', async () => {
    ecsSendMock.mockResolvedValueOnce({ services: [] })
    const GET = await importHandler()
    const resp = await GET(mkRequest())
    expect(resp.status).toBe(200)
    const json = (await resp.json()) as {
      defaults: Record<string, { defaultImage: string | null }>
    }
    expect(json.defaults['companion/openclaw'].defaultImage).toBeNull()
  })

  it('returns null defaultImage on AWS API failure (no 5xx)', async () => {
    ecsSendMock.mockRejectedValueOnce(
      Object.assign(new Error('throttled'), {
        name: 'ThrottlingException',
      }),
    )
    const GET = await importHandler()
    const resp = await GET(mkRequest())
    // Endpoint never 5xx's on a missing default — null lets the form
    // fall back to the placeholder example without blocking.
    expect(resp.status).toBe(200)
    const json = (await resp.json()) as {
      defaults: Record<string, { defaultImage: string | null }>
    }
    expect(json.defaults['companion/openclaw'].defaultImage).toBeNull()
  })

  it('returns null defaultImage when the gateway container is missing from the task-def', async () => {
    ecsSendMock
      .mockResolvedValueOnce({
        services: [{ taskDefinition: 'arn:tdf' }],
      })
      .mockResolvedValueOnce({
        taskDefinition: {
          containerDefinitions: [
            { name: 'init-config', image: 'init:1' },
            // openclaw-gateway missing
          ],
        },
      })

    const GET = await importHandler()
    const resp = await GET(mkRequest())
    expect(resp.status).toBe(200)
    const json = (await resp.json()) as {
      defaults: Record<string, { defaultImage: string | null }>
    }
    expect(json.defaults['companion/openclaw'].defaultImage).toBeNull()
  })

  it('rejects unauthorized callers via requireRole', async () => {
    const auth = await import('@/lib/auth')
    vi.mocked(auth.requireRole).mockReturnValueOnce({
      error: 'Unauthorized',
      status: 401,
    } as unknown as ReturnType<typeof auth.requireRole>)

    const GET = await importHandler()
    const resp = await GET(mkRequest())
    expect(resp.status).toBe(401)
  })
})
