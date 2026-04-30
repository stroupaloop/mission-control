import { describe, expect, it, vi, beforeEach } from 'vitest'

const ecsSendMock = vi.fn()
const elbv2SendMock = vi.fn()
const logsSendMock = vi.fn()

vi.mock('@aws-sdk/client-ecs', () => ({
  ECSClient: vi.fn().mockImplementation(() => ({ send: ecsSendMock })),
  RegisterTaskDefinitionCommand: vi.fn().mockImplementation((input: unknown) => ({
    __type: 'RegisterTaskDefinitionCommand',
    input,
  })),
  CreateServiceCommand: vi.fn().mockImplementation((input: unknown) => ({
    __type: 'CreateServiceCommand',
    input,
  })),
}))

vi.mock('@aws-sdk/client-elastic-load-balancing-v2', () => ({
  ElasticLoadBalancingV2Client: vi
    .fn()
    .mockImplementation(() => ({ send: elbv2SendMock })),
  CreateTargetGroupCommand: vi.fn().mockImplementation((input: unknown) => ({
    __type: 'CreateTargetGroupCommand',
    input,
  })),
  CreateRuleCommand: vi.fn().mockImplementation((input: unknown) => ({
    __type: 'CreateRuleCommand',
    input,
  })),
  DescribeLoadBalancersCommand: vi.fn().mockImplementation((input: unknown) => ({
    __type: 'DescribeLoadBalancersCommand',
    input,
  })),
  DescribeListenersCommand: vi.fn().mockImplementation((input: unknown) => ({
    __type: 'DescribeListenersCommand',
    input,
  })),
  DescribeRulesCommand: vi.fn().mockImplementation((input: unknown) => ({
    __type: 'DescribeRulesCommand',
    input,
  })),
}))

vi.mock('@aws-sdk/client-cloudwatch-logs', () => ({
  CloudWatchLogsClient: vi
    .fn()
    .mockImplementation(() => ({ send: logsSendMock })),
  CreateLogGroupCommand: vi.fn().mockImplementation((input: unknown) => ({
    __type: 'CreateLogGroupCommand',
    input,
  })),
  PutRetentionPolicyCommand: vi.fn().mockImplementation((input: unknown) => ({
    __type: 'PutRetentionPolicyCommand',
    input,
  })),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/auth', () => ({
  requireRole: vi.fn(() => ({ user: { id: 'test', role: 'admin' } })),
}))

vi.mock('@/lib/security-events', () => ({
  logSecurityEvent: vi.fn(),
}))

const importHandler = async () => {
  const mod = await import('../api/agents')
  return mod.POST
}

const setRequiredEnv = () => {
  process.env.AWS_REGION = 'us-east-1'
  process.env.MC_FLEET_CLUSTER_NAME = 'ender-stack-dev'
  process.env.MC_FLEET_PROJECT_NAME = 'ender-stack'
  process.env.MC_FLEET_ENVIRONMENT = 'dev'
  process.env.MC_AGENT_TASK_ROLE_ARN =
    'arn:aws:iam::398152419239:role/ender-stack-dev-companion-openclaw-mc-task'
  process.env.MC_AGENT_EXECUTION_ROLE_ARN =
    'arn:aws:iam::398152419239:role/ender-stack-dev-companion-openclaw-mc-exec'
  process.env.MC_AGENT_LOG_GROUP_PREFIX = '/ecs/ender-stack-dev'
  process.env.MC_AGENT_VPC_ID = 'vpc-abc'
  process.env.MC_AGENT_SUBNET_IDS = 'subnet-1,subnet-2'
  process.env.MC_AGENT_SECURITY_GROUP_ID = 'sg-ecs'
  process.env.MC_LITELLM_ALB_DNS_NAME = 'internal-litellm.us-east-1.elb.amazonaws.com'
}

const validBody = () => ({
  harnessType: 'companion/openclaw',
  agentName: 'hello-world',
  roleDescription: 'Says hello',
  image: 'ghcr.io/stroupaloop/openclaw:sha-abc123',
  modelTier: 'sonnet-4-6',
})

const mkRequest = (body: unknown) =>
  ({
    json: async () => body,
    url: 'http://localhost/api/fleet/agents',
  }) as unknown as Parameters<Awaited<ReturnType<typeof importHandler>>>[0]

const happyPathMocks = () => {
  // Order: DescribeLBs → DescribeListeners → CreateLogGroup →
  // PutRetentionPolicy → RegisterTaskDef → CreateTargetGroup →
  // DescribeRules (priority allocation) → CreateRule → CreateService.
  elbv2SendMock.mockReset()
  ecsSendMock.mockReset()
  logsSendMock.mockReset()

  elbv2SendMock
    .mockResolvedValueOnce({
      LoadBalancers: [
        {
          LoadBalancerArn:
            'arn:aws:elasticloadbalancing:us-east-1:398152419239:loadbalancer/app/ender-stack-dev-agents-shared/abc',
        },
      ],
    })
    .mockResolvedValueOnce({
      Listeners: [
        {
          ListenerArn:
            'arn:aws:elasticloadbalancing:us-east-1:398152419239:listener/app/ender-stack-dev-agents-shared/abc/lst1',
          Protocol: 'HTTP',
        },
      ],
    })
    .mockResolvedValueOnce({
      TargetGroups: [
        {
          TargetGroupArn:
            'arn:aws:elasticloadbalancing:us-east-1:398152419239:targetgroup/ender-stack-dev-agent-hello-world/tg1',
        },
      ],
    })
    .mockResolvedValueOnce({
      // DescribeRules — empty listener (no occupied priorities), so
      // allocatePriority returns the hashed slot directly.
      Rules: [{ Priority: 'default' }],
    })
    .mockResolvedValueOnce({
      Rules: [
        {
          RuleArn:
            'arn:aws:elasticloadbalancing:us-east-1:398152419239:listener-rule/app/ender-stack-dev-agents-shared/abc/lst1/r1',
        },
      ],
    })

  logsSendMock
    .mockResolvedValueOnce({}) // CreateLogGroup
    .mockResolvedValueOnce({}) // PutRetentionPolicy

  ecsSendMock
    .mockResolvedValueOnce({
      taskDefinition: {
        taskDefinitionArn:
          'arn:aws:ecs:us-east-1:398152419239:task-definition/ender-stack-dev-companion-openclaw-hello-world:1',
      },
    })
    .mockResolvedValueOnce({
      service: {
        serviceArn:
          'arn:aws:ecs:us-east-1:398152419239:service/ender-stack-dev/ender-stack-dev-companion-openclaw-hello-world',
      },
    })
}

beforeEach(() => {
  setRequiredEnv()
  ecsSendMock.mockReset()
  elbv2SendMock.mockReset()
  logsSendMock.mockReset()
})

describe('POST /api/fleet/agents — env validation', () => {
  it('returns 500 ConfigurationError when MC_AGENT_TASK_ROLE_ARN is unset', async () => {
    delete process.env.MC_AGENT_TASK_ROLE_ARN
    const POST = await importHandler()
    const resp = await POST(mkRequest(validBody()))
    expect(resp.status).toBe(500)
    const json = (await resp.json()) as { error: string; detail?: string }
    expect(json.error).toBe('ConfigurationError')
    expect(json.detail).toContain('MC_AGENT_TASK_ROLE_ARN')
  })

  it('returns 500 with all missing env vars listed', async () => {
    delete process.env.MC_AGENT_VPC_ID
    delete process.env.MC_AGENT_SECURITY_GROUP_ID
    const POST = await importHandler()
    const resp = await POST(mkRequest(validBody()))
    const json = (await resp.json()) as { detail?: string }
    expect(json.detail).toContain('MC_AGENT_VPC_ID')
    expect(json.detail).toContain('MC_AGENT_SECURITY_GROUP_ID')
  })

  it('returns 500 ConfigurationError when MC_FLEET_IMAGE_REGISTRY_ALLOWLIST contains an invalid regex (not a 502 SyntaxError)', async () => {
    // Audit on PR #37 round 3 caught this: a malformed allowlist entry
    // would throw SyntaxError from `new RegExp()`, the outer try/catch
    // would surface it as a generic 502, and the operator would
    // diagnose a downstream AWS issue instead of fixing their env var.
    // The handler now maps ImageAllowlistConfigError to 500
    // ConfigurationError with the bad pattern named.
    const original = process.env.MC_FLEET_IMAGE_REGISTRY_ALLOWLIST
    process.env.MC_FLEET_IMAGE_REGISTRY_ALLOWLIST = '[unterminated-class'
    try {
      const POST = await importHandler()
      const resp = await POST(mkRequest(validBody()))
      expect(resp.status).toBe(500)
      const json = (await resp.json()) as { error: string; detail?: string }
      expect(json.error).toBe('ConfigurationError')
      expect(json.detail).toContain('MC_FLEET_IMAGE_REGISTRY_ALLOWLIST')
      expect(json.detail).toContain('[unterminated-class')
    } finally {
      if (original === undefined) {
        delete process.env.MC_FLEET_IMAGE_REGISTRY_ALLOWLIST
      } else {
        process.env.MC_FLEET_IMAGE_REGISTRY_ALLOWLIST = original
      }
    }
  })

  it('rejects agentName with invalid characters at the type-guard layer (defense-in-depth)', async () => {
    // Length window passes (11 chars, in [3,32]) but the regex fails
    // on the space. Confirms that even if a future harness's
    // validateInput drops the regex, the type guard catches it.
    const POST = await importHandler()
    const resp = await POST(
      mkRequest({ ...validBody(), agentName: 'hello world' }),
    )
    expect(resp.status).toBe(400)
    const json = (await resp.json()) as { error: string }
    expect(json.error).toBe('InvalidRequestShape')
  })
})

describe('POST /api/fleet/agents — request validation', () => {
  it('returns 400 InvalidRequestBody on non-JSON', async () => {
    const POST = await importHandler()
    const req = {
      json: async () => {
        throw new SyntaxError('bad json')
      },
    } as unknown as Parameters<typeof POST>[0]
    const resp = await POST(req)
    expect(resp.status).toBe(400)
    expect(((await resp.json()) as { error: string }).error).toBe(
      'InvalidRequestBody',
    )
  })

  it('returns 400 InvalidRequestShape when fields are missing', async () => {
    const POST = await importHandler()
    const resp = await POST(
      mkRequest({ harnessType: 'companion/openclaw', agentName: 'hi' }),
    )
    expect(resp.status).toBe(400)
    expect(((await resp.json()) as { error: string }).error).toBe(
      'InvalidRequestShape',
    )
  })

  it('returns 400 InvalidRequestShape when agentName fails the regex (caught at type guard)', async () => {
    // After auditor round 5, the regex moved into isCreateAgentRequest
    // as the harness-agnostic security boundary, so invalid agent names
    // are caught here BEFORE the template's validateInput sees them.
    // Both layers still apply the same regex (defense-in-depth).
    const POST = await importHandler()
    const resp = await POST(
      mkRequest({ ...validBody(), agentName: 'BAD_NAME' }),
    )
    expect(resp.status).toBe(400)
    const json = (await resp.json()) as { error: string }
    expect(json.error).toBe('InvalidRequestShape')
  })

  it('returns 400 InvalidRequestShape on unknown harnessType', async () => {
    const POST = await importHandler()
    const resp = await POST(
      mkRequest({ ...validBody(), harnessType: 'task/hermes' }),
    )
    expect(resp.status).toBe(400)
    expect(((await resp.json()) as { error: string }).error).toBe(
      'InvalidRequestShape',
    )
  })
})

describe('POST /api/fleet/agents — auth', () => {
  it('rejects non-admin callers via requireRole', async () => {
    const auth = await import('@/lib/auth')
    vi.mocked(auth.requireRole).mockReturnValueOnce({
      error: 'forbidden',
      status: 403,
    })
    const POST = await importHandler()
    const resp = await POST(mkRequest(validBody()))
    expect(resp.status).toBe(403)
  })
})

describe('POST /api/fleet/agents — happy path', () => {
  it('returns 201 with all created resource ARNs', async () => {
    happyPathMocks()
    const POST = await importHandler()
    const resp = await POST(mkRequest(validBody()))
    expect(resp.status).toBe(201)
    const json = (await resp.json()) as {
      ok: boolean
      agentName: string
      resources: {
        serviceArn: string
        taskDefinitionArn: string
        targetGroupArn: string
        listenerRuleArn: string
        logGroup: string
        listenerPath: string
      }
    }
    expect(json.ok).toBe(true)
    expect(json.agentName).toBe('hello-world')
    expect(json.resources.listenerPath).toBe(
      '/agent/hello-world (+ /agent/hello-world/*)',
    )
    expect(json.resources.logGroup).toBe(
      '/ecs/ender-stack-dev/companion-openclaw-hello-world',
    )
    expect(json.resources.serviceArn).toContain(
      'service/ender-stack-dev/ender-stack-dev-companion-openclaw-hello-world',
    )
  })

  it('looks up the shared ALB by name', async () => {
    happyPathMocks()
    const POST = await importHandler()
    await POST(mkRequest(validBody()))
    const firstElbCall = elbv2SendMock.mock.calls[0]?.[0] as {
      __type: string
      input: { Names?: string[] }
    }
    expect(firstElbCall.__type).toBe('DescribeLoadBalancersCommand')
    expect(firstElbCall.input.Names).toEqual(['ender-stack-dev-agents-shared'])
  })

  it('pre-creates the per-agent log group with retention before RegisterTaskDef', async () => {
    happyPathMocks()
    const POST = await importHandler()
    await POST(mkRequest(validBody()))
    const calls = logsSendMock.mock.calls.map(
      (c) => (c[0] as { __type: string }).__type,
    )
    expect(calls).toEqual(['CreateLogGroupCommand', 'PutRetentionPolicyCommand'])
    // RegisterTaskDef must be after both log calls.
    const registerOrder = ecsSendMock.mock.invocationCallOrder[0]
    const lastLogOrder =
      logsSendMock.mock.invocationCallOrder[
        logsSendMock.mock.invocationCallOrder.length - 1
      ]
    expect(registerOrder).toBeGreaterThan(lastLogOrder)
  })

  it('treats ResourceAlreadyExistsException on log-group create as idempotent', async () => {
    happyPathMocks()
    // Override CreateLogGroup with a "already exists" error followed by
    // a successful PutRetentionPolicy — handler should swallow and continue.
    logsSendMock.mockReset()
    const alreadyExists = Object.assign(new Error('exists'), {
      name: 'ResourceAlreadyExistsException',
    })
    logsSendMock
      .mockRejectedValueOnce(alreadyExists)
      .mockResolvedValueOnce({})
    const POST = await importHandler()
    const resp = await POST(mkRequest(validBody()))
    expect(resp.status).toBe(201)
  })

  it('surfaces a runtime-config-gap warning on 201 referencing the open ender-stack issue', async () => {
    happyPathMocks()
    const POST = await importHandler()
    const resp = await POST(mkRequest(validBody()))
    expect(resp.status).toBe(201)
    const json = (await resp.json()) as {
      warnings: Array<{ code: string; message: string }>
    }
    expect(Array.isArray(json.warnings)).toBe(true)
    const codes = json.warnings.map((w) => w.code)
    expect(codes).toContain('runtime-config-gap')
    const msg = json.warnings.find(
      (w) => w.code === 'runtime-config-gap',
    )?.message
    expect(msg).toMatch(/ender-stack#215/i)
  })

  it('CreateRule routes /agent/{name} and /agent/{name}/* to the new TG', async () => {
    happyPathMocks()
    const POST = await importHandler()
    await POST(mkRequest(validBody()))
    const ruleCall = elbv2SendMock.mock.calls.find(
      (c) => (c[0] as { __type: string }).__type === 'CreateRuleCommand',
    )
    expect(ruleCall).toBeDefined()
    const input = (ruleCall![0] as { input: Record<string, unknown> }).input
    // Two explicit patterns prevent prefix-pair collisions (e.g.,
    // `bot` + `bot-test`).
    expect((input.Conditions as Array<Record<string, unknown>>)[0].Values).toEqual(
      ['/agent/hello-world', '/agent/hello-world/*'],
    )
    const actions = input.Actions as Array<Record<string, unknown>>
    expect(actions[0].TargetGroupArn).toContain(
      'targetgroup/ender-stack-dev-agent-hello-world',
    )
  })
})

describe('POST /api/fleet/agents — error handling', () => {
  it('returns 502 with the SDK error name when the shared ALB is missing', async () => {
    elbv2SendMock.mockResolvedValueOnce({ LoadBalancers: [] })
    const POST = await importHandler()
    const resp = await POST(mkRequest(validBody()))
    expect(resp.status).toBe(502)
    const json = (await resp.json()) as { error: string }
    expect(json.error).toBe('Error') // generic Error.name
  })

  it('returns 409 when the ECS service already exists', async () => {
    happyPathMocks()
    // Override the LAST ecs call (CreateService) with a conflict.
    ecsSendMock.mockReset()
    ecsSendMock
      .mockResolvedValueOnce({
        taskDefinition: {
          taskDefinitionArn: 'arn:tdf',
        },
      })
      .mockRejectedValueOnce(
        Object.assign(new Error('Service already exists'), {
          name: 'InvalidParameterException',
        }),
      )
    const POST = await importHandler()
    const resp = await POST(mkRequest(validBody()))
    expect(resp.status).toBe(409)
    expect(((await resp.json()) as { error: string }).error).toBe(
      'InvalidParameterException',
    )
  })

  it('returns 502 (not 409) when InvalidParameterException is a parameter-validation failure, not a conflict', async () => {
    happyPathMocks()
    ecsSendMock.mockReset()
    ecsSendMock
      .mockResolvedValueOnce({
        taskDefinition: { taskDefinitionArn: 'arn:tdf' },
      })
      .mockRejectedValueOnce(
        Object.assign(
          new Error(
            'Subnet is not a valid Fargate-compatible subnet ID',
          ),
          { name: 'InvalidParameterException' },
        ),
      )
    const POST = await importHandler()
    const resp = await POST(mkRequest(validBody()))
    // Pre-fix: this would 409 because InvalidParameterException name was
    // hard-mapped to 409. Post-fix: only "already exists"/"in use"
    // messages map to 409; everything else is 502.
    expect(resp.status).toBe(502)
    expect(((await resp.json()) as { error: string }).error).toBe(
      'InvalidParameterException',
    )
  })

  it('surfaces partialResources.serviceArn when CreateService SDK response is missing serviceArn (round-4 audit defensive case)', async () => {
    happyPathMocks()
    // Override the LAST ecs call (CreateService): respond as if AWS
    // succeeded (HTTP 200) but the SDK contract was violated — the
    // service field is present but serviceArn is undefined. The
    // service WAS created on AWS; without serviceArn surfacing in
    // partialResources, the operator has no pointer to clean up the
    // orphaned ECS service.
    ecsSendMock.mockReset()
    ecsSendMock
      .mockResolvedValueOnce({
        taskDefinition: { taskDefinitionArn: 'arn:tdf' },
      })
      .mockResolvedValueOnce({
        // SDK contract violation: serviceArn missing from response
        service: {},
      })
    const POST = await importHandler()
    const resp = await POST(mkRequest(validBody()))
    expect(resp.status).toBe(502)
    const json = (await resp.json()) as {
      error: string
      partialResources?: {
        taskDefinitionArn?: string
        serviceArn?: string
      }
    }
    // The handler throws a generic Error after detecting the missing
    // ARN; outer catch surfaces the Error.name. Important: the
    // partial.serviceArn key is set even when its value is undefined,
    // so the operator gets a structured "this MAY be orphaned" signal.
    expect(json.partialResources).toBeDefined()
    expect(json.partialResources?.taskDefinitionArn).toBe('arn:tdf')
    // null (not undefined) so the field survives JSON.stringify and
    // the operator gets a clear "we don't have it but we tried"
    // signal in the response body.
    expect(json.partialResources?.serviceArn).toBeNull()
  })

  it('returns 409 on DuplicateTargetGroupNameException', async () => {
    // CreateTargetGroup is called before DescribeRules (the priority
    // allocator), so this error path doesn't reach DescribeRules.
    elbv2SendMock
      .mockResolvedValueOnce({
        LoadBalancers: [{ LoadBalancerArn: 'arn:lb' }],
      })
      .mockResolvedValueOnce({
        Listeners: [{ ListenerArn: 'arn:lst', Protocol: 'HTTP' }],
      })
      .mockRejectedValueOnce(
        Object.assign(new Error('exists'), {
          name: 'DuplicateTargetGroupNameException',
        }),
      )
    logsSendMock.mockResolvedValue({})
    ecsSendMock.mockResolvedValueOnce({
      taskDefinition: { taskDefinitionArn: 'arn:tdf' },
    })
    const POST = await importHandler()
    const resp = await POST(mkRequest(validBody()))
    expect(resp.status).toBe(409)
  })

  it('surfaces partialResources on partial-failure 5xx so operators can clean up orphans', async () => {
    happyPathMocks()
    // Override the LAST ecs call (CreateService) with a non-conflict
    // failure — earlier creates succeeded so partialResources should
    // surface taskDefinitionArn + targetGroupArn + listenerRuleArn +
    // logGroup.
    ecsSendMock.mockReset()
    ecsSendMock
      .mockResolvedValueOnce({
        taskDefinition: { taskDefinitionArn: 'arn:tdf-1' },
      })
      .mockRejectedValueOnce(
        Object.assign(new Error('aws explosion'), { name: 'ServerException' }),
      )
    const POST = await importHandler()
    const resp = await POST(mkRequest(validBody()))
    expect(resp.status).toBe(502)
    const json = (await resp.json()) as {
      error: string
      partialResources?: {
        taskDefinitionArn?: string
        targetGroupArn?: string
        listenerRuleArn?: string
        logGroup?: string
      }
    }
    expect(json.error).toBe('ServerException')
    expect(json.partialResources).toBeDefined()
    expect(json.partialResources?.taskDefinitionArn).toBe('arn:tdf-1')
    expect(json.partialResources?.targetGroupArn).toContain(
      'targetgroup/ender-stack-dev-agent-hello-world',
    )
    expect(json.partialResources?.listenerRuleArn).toContain(
      'listener-rule/app/ender-stack-dev-agents-shared',
    )
    expect(json.partialResources?.logGroup).toBe(
      '/ecs/ender-stack-dev/companion-openclaw-hello-world',
    )
  })
})

describe('POST /api/fleet/agents — audit trail', () => {
  it('writes a fleet.agent_created security event on successful create', async () => {
    happyPathMocks()
    const securityEvents = await import('@/lib/security-events')
    const POST = await importHandler()
    await POST(mkRequest(validBody()))
    expect(vi.mocked(securityEvents.logSecurityEvent)).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'fleet.agent_created',
        agent_name: 'hello-world',
        source: 'fleet',
      }),
    )
  })
})

describe('POST /api/fleet/agents — listener selection', () => {
  it('picks the HTTP listener when an HTTPS one is also present', async () => {
    elbv2SendMock.mockReset()
    ecsSendMock.mockReset()
    logsSendMock.mockReset()

    elbv2SendMock
      .mockResolvedValueOnce({
        LoadBalancers: [{ LoadBalancerArn: 'arn:lb' }],
      })
      .mockResolvedValueOnce({
        Listeners: [
          // Order intentionally reversed — handler must filter by
          // protocol, not pick by index.
          {
            ListenerArn: 'arn:lst-https',
            Protocol: 'HTTPS',
          },
          {
            ListenerArn: 'arn:lst-http',
            Protocol: 'HTTP',
          },
        ],
      })
      .mockResolvedValueOnce({
        TargetGroups: [{ TargetGroupArn: 'arn:tg' }],
      })
      .mockResolvedValueOnce({
        // DescribeRules — empty for priority allocation
        Rules: [{ Priority: 'default' }],
      })
      .mockResolvedValueOnce({
        Rules: [{ RuleArn: 'arn:rule' }],
      })

    logsSendMock.mockResolvedValue({})
    ecsSendMock
      .mockResolvedValueOnce({
        taskDefinition: { taskDefinitionArn: 'arn:tdf' },
      })
      .mockResolvedValueOnce({
        service: { serviceArn: 'arn:svc' },
      })

    const POST = await importHandler()
    const resp = await POST(mkRequest(validBody()))
    expect(resp.status).toBe(201)

    const ruleCall = elbv2SendMock.mock.calls.find(
      (c) => (c[0] as { __type: string }).__type === 'CreateRuleCommand',
    )
    const input = (ruleCall![0] as { input: { ListenerArn: string } }).input
    expect(input.ListenerArn).toBe('arn:lst-http')
  })

  it('502s with a clear error when the LB has only an HTTPS listener', async () => {
    elbv2SendMock.mockReset()
    elbv2SendMock
      .mockResolvedValueOnce({
        LoadBalancers: [{ LoadBalancerArn: 'arn:lb' }],
      })
      .mockResolvedValueOnce({
        Listeners: [{ ListenerArn: 'arn:lst-https', Protocol: 'HTTPS' }],
      })
    const POST = await importHandler()
    const resp = await POST(mkRequest(validBody()))
    expect(resp.status).toBe(502)
  })
})

describe('POST /api/fleet/agents — env edge cases', () => {
  it('falls back to retention=365 when MC_AGENT_LOG_RETENTION_DAYS is non-numeric', async () => {
    process.env.MC_AGENT_LOG_RETENTION_DAYS = 'totally-bogus'
    happyPathMocks()
    const POST = await importHandler()
    const resp = await POST(mkRequest(validBody()))
    expect(resp.status).toBe(201)
    const retentionCall = logsSendMock.mock.calls.find(
      (c) => (c[0] as { __type: string }).__type === 'PutRetentionPolicyCommand',
    )
    const input = (
      retentionCall![0] as { input: { retentionInDays: number } }
    ).input
    expect(input.retentionInDays).toBe(365)
  })
})
