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
            status: 'ACTIVE',
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
      defaults: Record<
        string,
        { defaultImage: string | null; agentNameMaxLength: number }
      >
    }
    expect(json.defaults['companion/openclaw'].defaultImage).toBe(
      '1.dkr.ecr.us-east-1.amazonaws.com/ender-stack/companion-openclaw:1dcff0d',
    )
    // For prefix `ender-stack-dev`: 32 (TG max) - 15 (prefix) - 7
    // ('-agent-') = 10. Server-computed so the form's maxLength
    // attribute is accurate per-deployment.
    expect(json.defaults['companion/openclaw'].agentNameMaxLength).toBe(10)
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

  it('returns null defaultImage when the smoke-test service is INACTIVE / DRAINING (filters to ACTIVE only)', async () => {
    // Round-1 audit (Greptile P2): DescribeServices returns
    // decommissioned services with their last-known taskDefinition.
    // Without an ACTIVE filter, the form would pre-fill an image
    // that's no longer running anywhere. Filter to status==='ACTIVE'
    // so torn-down smoke-tests get null (placeholder fallback in form).
    ecsSendMock.mockResolvedValueOnce({
      services: [
        {
          status: 'INACTIVE',
          taskDefinition:
            'arn:aws:ecs:us-east-1:1:task-definition/stale-decom:99',
        },
      ],
    })
    const GET = await importHandler()
    const resp = await GET(mkRequest())
    expect(resp.status).toBe(200)
    const json = (await resp.json()) as {
      defaults: Record<string, { defaultImage: string | null }>
    }
    expect(json.defaults['companion/openclaw'].defaultImage).toBeNull()
  })

  it('returns null defaultImage when the gateway container is missing from the task-def', async () => {
    ecsSendMock
      .mockResolvedValueOnce({
        services: [{ status: 'ACTIVE', taskDefinition: 'arn:tdf' }],
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

  it('derives project + env from MC_FLEET_CLUSTER_NAME when only that env var is set (round-3 audit P2)', async () => {
    // Round-3 audit caught: previous hardcoded 'ender-stack'
    // fallback diverged from agents.ts, which derives both project
    // and env from a cluster name when the explicit vars aren't
    // set. New behavior mirrors agents.ts exactly.
    delete process.env.MC_FLEET_PROJECT_NAME
    delete process.env.MC_FLEET_ENVIRONMENT
    process.env.MC_FLEET_CLUSTER_NAME = 'foo-bar-staging'

    ecsSendMock.mockResolvedValueOnce({ services: [] })
    const GET = await importHandler()
    await GET(mkRequest())

    // First call: DescribeServicesCommand. Inspect the service name
    // it asked for — must be derived as `foo-bar-staging-companion-
    // openclaw-smoke-test`, not `ender-stack-dev-...` (old hardcode).
    const firstCall = ecsSendMock.mock.calls[0]?.[0] as {
      __type: string
      input: { services?: string[] }
    }
    expect(firstCall.__type).toBe('DescribeServicesCommand')
    expect(firstCall.input.services?.[0]).toBe(
      'foo-bar-staging-companion-openclaw-smoke-test',
    )
  })

  it('returns 500 PrefixTooLongForHarness when the deployment prefix leaves no room for any legal agent name (round-2 audit on PR #39)', async () => {
    // Round-2 audit caught the degenerate path: a long prefix
    // makes maxAgentNameLengthForPrefix return less than the regex
    // min (3). The form would silently fall back to maxLength=32
    // and the operator would see every submission rejected with a
    // confusing 400. Surface the misconfig at the endpoint instead
    // with a clear 500 + the prefix named in detail.
    delete process.env.MC_FLEET_PROJECT_NAME
    delete process.env.MC_FLEET_ENVIRONMENT
    process.env.MC_FLEET_CLUSTER_NAME =
      'this-is-an-extremely-long-cluster-name-staging' // 47 chars

    const GET = await importHandler()
    const resp = await GET(mkRequest())
    expect(resp.status).toBe(500)
    const json = (await resp.json()) as { error: string; detail?: string }
    expect(json.error).toBe('PrefixTooLongForHarness')
    // Round-4 audit: detail names the prefix so operators without
    // log access can self-diagnose.
    expect(json.detail).toContain('this-is-an-extremely-long')
    expect(json.detail).toMatch(/at least 3/)
  })

  it('catches the off-by-two boundary: 23-char prefix → maxLen=2 → 500 (regex min is 3, not 1) — round-4 audit on PR #39', async () => {
    // Round-4 audit caught: prior threshold was `openclawMaxLen <= 0`,
    // but AGENT_NAME_RE requires minimum 3 chars. A 23-char prefix
    // (e.g. `acme-platform-staging-x`) produces maxLen=2 which
    // passes the old guard, endpoint returns 200 with
    // `agentNameMaxLength: 2`, form sets maxLength=2 < minLength=3
    // — every submission rejected. New threshold uses
    // AGENT_NAME_MIN_LENGTH so the gate fires correctly.
    delete process.env.MC_FLEET_PROJECT_NAME
    delete process.env.MC_FLEET_ENVIRONMENT
    // 23-char prefix (15 + 7 = 22 overhead → maxLen = 32 - 22 = 10).
    // To trigger the boundary we need exactly 23 chars: project +
    // env totals 23. e.g. `endpoint-22charname-dev` is 23.
    process.env.MC_FLEET_CLUSTER_NAME = 'endpoint-22charname-dev' // 23 chars

    const GET = await importHandler()
    const resp = await GET(mkRequest())
    expect(resp.status).toBe(500)
    const json = (await resp.json()) as { error: string }
    expect(json.error).toBe('PrefixTooLongForHarness')
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
