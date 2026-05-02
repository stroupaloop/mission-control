import { describe, expect, it, vi, beforeEach } from 'vitest'
import * as auth from '@/lib/auth'

const ecsSendMock = vi.fn()
const elbv2SendMock = vi.fn()
const logsSendMock = vi.fn()

// AWS SDK mock — same pattern as agents-create.test.ts. Each Command
// constructor wraps its input in a __type-tagged plain object so the
// test can introspect what the handler asked for.
vi.mock('@aws-sdk/client-ecs', () => ({
  ECSClient: vi.fn().mockImplementation(() => ({ send: ecsSendMock })),
  DescribeServicesCommand: vi.fn().mockImplementation((input: unknown) => ({
    __type: 'DescribeServicesCommand',
    input,
  })),
  UpdateServiceCommand: vi.fn().mockImplementation((input: unknown) => ({
    __type: 'UpdateServiceCommand',
    input,
  })),
  DeleteServiceCommand: vi.fn().mockImplementation((input: unknown) => ({
    __type: 'DeleteServiceCommand',
    input,
  })),
  ListTaskDefinitionsCommand: vi.fn().mockImplementation((input: unknown) => ({
    __type: 'ListTaskDefinitionsCommand',
    input,
  })),
  DeregisterTaskDefinitionCommand: vi
    .fn()
    .mockImplementation((input: unknown) => ({
      __type: 'DeregisterTaskDefinitionCommand',
      input,
    })),
}))

vi.mock('@aws-sdk/client-elastic-load-balancing-v2', () => ({
  ElasticLoadBalancingV2Client: vi
    .fn()
    .mockImplementation(() => ({ send: elbv2SendMock })),
  DescribeLoadBalancersCommand: vi
    .fn()
    .mockImplementation((input: unknown) => ({
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
  DescribeTargetGroupsCommand: vi.fn().mockImplementation((input: unknown) => ({
    __type: 'DescribeTargetGroupsCommand',
    input,
  })),
  DeleteRuleCommand: vi.fn().mockImplementation((input: unknown) => ({
    __type: 'DeleteRuleCommand',
    input,
  })),
  DeleteTargetGroupCommand: vi.fn().mockImplementation((input: unknown) => ({
    __type: 'DeleteTargetGroupCommand',
    input,
  })),
}))

vi.mock('@aws-sdk/client-cloudwatch-logs', () => ({
  CloudWatchLogsClient: vi
    .fn()
    .mockImplementation(() => ({ send: logsSendMock })),
  DeleteLogGroupCommand: vi.fn().mockImplementation((input: unknown) => ({
    __type: 'DeleteLogGroupCommand',
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
  const mod = await import('../api/agents-delete')
  return mod.DELETE
}

const setRequiredEnv = () => {
  process.env.AWS_REGION = 'us-east-1'
  process.env.MC_FLEET_CLUSTER_NAME = 'ender-stack-dev'
  process.env.MC_FLEET_PROJECT_NAME = 'ender-stack'
  process.env.MC_FLEET_ENVIRONMENT = 'dev'
  process.env.MC_AGENT_LOG_GROUP_PREFIX = '/ecs/ender-stack-dev'
}

// Resource ARN/name fixtures matching the deterministic naming the
// handler derives from `prefix + agentName = ender-stack-dev-...-hello-bot`.
const PREFIX = 'ender-stack-dev'
const AGENT = 'hello-bot'
const SERVICE_NAME = `${PREFIX}-companion-openclaw-${AGENT}`
const SERVICE_ARN = `arn:aws:ecs:us-east-1:398152419239:service/${PREFIX}/${SERVICE_NAME}`
const TG_NAME = `${PREFIX}-agent-${AGENT}`
const TG_ARN = `arn:aws:elasticloadbalancing:us-east-1:398152419239:targetgroup/${TG_NAME}/abc123`
const ALB_ARN = `arn:aws:elasticloadbalancing:us-east-1:398152419239:loadbalancer/app/${PREFIX}-agents-shared/lb1`
const LISTENER_ARN = `arn:aws:elasticloadbalancing:us-east-1:398152419239:listener/app/${PREFIX}-agents-shared/lb1/lst1`
const RULE_ARN = `arn:aws:elasticloadbalancing:us-east-1:398152419239:listener-rule/app/${PREFIX}-agents-shared/lb1/lst1/r1`
const LOG_GROUP = `/ecs/${PREFIX}/companion-openclaw-${AGENT}`
const TASK_DEF_ARN_1 = `arn:aws:ecs:us-east-1:398152419239:task-definition/${SERVICE_NAME}:1`
const TASK_DEF_ARN_2 = `arn:aws:ecs:us-east-1:398152419239:task-definition/${SERVICE_NAME}:2`

const mkRequest = () =>
  ({
    url: `http://localhost/api/fleet/agents/${AGENT}`,
  }) as unknown as Parameters<Awaited<ReturnType<typeof importHandler>>>[0]

const mkParams = (name: string = AGENT) => ({
  params: Promise.resolve({ name }),
})

/**
 * Happy-path mock chain. Order matches the handler's tear-down sequence:
 *   ecs:DescribeServices → ecs:UpdateService
 *   → elbv2:DescribeLBs → DescribeListeners → DescribeRules → DeleteRule
 *   → elbv2:DescribeTGs → DeleteTargetGroup
 *   → ecs:ListTaskDefinitions → DeregisterTaskDefinition (×2) → DeleteService
 *   → logs:DeleteLogGroup
 */
const happyPathMocks = () => {
  ecsSendMock.mockReset()
  elbv2SendMock.mockReset()
  logsSendMock.mockReset()

  ecsSendMock
    // 1. DescribeServices — service exists, ACTIVE, agent-harness + MC-managed
    .mockResolvedValueOnce({
      services: [
        {
          serviceArn: SERVICE_ARN,
          status: 'ACTIVE',
          tags: [
            { key: 'Component', value: 'agent-harness' },
            { key: 'ManagedBy', value: 'mission-control' },
          ],
        },
      ],
    })
    // 2. UpdateService desired=0
    .mockResolvedValueOnce({})
    // (ELBv2 calls happen between here and the next ECS call)
    // 7. ListTaskDefinitions
    .mockResolvedValueOnce({
      taskDefinitionArns: [TASK_DEF_ARN_1, TASK_DEF_ARN_2],
    })
    // 7. DeregisterTaskDefinition (×2)
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({})
    // 8. DeleteService force=true
    .mockResolvedValueOnce({})

  elbv2SendMock
    // 3. DescribeLoadBalancers
    .mockResolvedValueOnce({
      LoadBalancers: [{ LoadBalancerArn: ALB_ARN }],
    })
    // 3. DescribeListeners
    .mockResolvedValueOnce({
      Listeners: [{ ListenerArn: LISTENER_ARN, Protocol: 'HTTP' }],
    })
    // 3. DescribeRules
    .mockResolvedValueOnce({
      Rules: [
        {
          RuleArn: RULE_ARN,
          Conditions: [
            { Field: 'path-pattern', Values: [`/agent/${AGENT}`] },
          ],
        },
      ],
    })
    // 4. DeleteRule
    .mockResolvedValueOnce({})
    // 5. DescribeTargetGroups
    .mockResolvedValueOnce({
      TargetGroups: [{ TargetGroupArn: TG_ARN }],
    })
    // 6. DeleteTargetGroup
    .mockResolvedValueOnce({})

  // 9. DeleteLogGroup (last)
  logsSendMock.mockResolvedValueOnce({})
}

beforeEach(() => {
  setRequiredEnv()
  ecsSendMock.mockReset()
  elbv2SendMock.mockReset()
  logsSendMock.mockReset()
})

describe('DELETE /api/fleet/agents/:name — happy path', () => {
  it('tears down all 5 resource categories and returns 200 with deletedResources populated', async () => {
    happyPathMocks()
    const DELETE = await importHandler()
    const resp = await DELETE(mkRequest(), mkParams())
    expect(resp.status).toBe(200)
    const json = (await resp.json()) as {
      ok: boolean
      agentName: string
      deletedResources: Record<string, unknown>
      warnings: Array<{ code: string }>
    }
    expect(json.ok).toBe(true)
    expect(json.agentName).toBe(AGENT)
    expect(json.deletedResources).toEqual({
      serviceArn: SERVICE_ARN,
      listenerRuleArn: RULE_ARN,
      targetGroupArn: TG_ARN,
      logGroup: LOG_GROUP,
      taskDefinitionRevisions: [TASK_DEF_ARN_1, TASK_DEF_ARN_2],
    })
    expect(json.warnings).toEqual([])
  })

  it('issues UpdateService desiredCount=0 before any delete call', async () => {
    happyPathMocks()
    const DELETE = await importHandler()
    await DELETE(mkRequest(), mkParams())
    const updateCall = ecsSendMock.mock.calls.find(
      (c) => (c[0] as { __type: string }).__type === 'UpdateServiceCommand',
    )
    expect(updateCall).toBeDefined()
    const input = (updateCall![0] as { input: Record<string, unknown> }).input
    expect(input.desiredCount).toBe(0)
    expect(input.service).toBe(SERVICE_NAME)
  })

  it('passes force=true on DeleteService', async () => {
    happyPathMocks()
    const DELETE = await importHandler()
    await DELETE(mkRequest(), mkParams())
    const delCall = ecsSendMock.mock.calls.find(
      (c) => (c[0] as { __type: string }).__type === 'DeleteServiceCommand',
    )
    expect(delCall).toBeDefined()
    const input = (delCall![0] as { input: Record<string, unknown> }).input
    expect(input.force).toBe(true)
  })

  it('deletes log group AFTER deleting the service (avoids losing tail buffer)', async () => {
    // Auditor flag (ender-stack PR #262 round-1): DeleteLogGroup before
    // DeleteService risks losing the awslogs driver's final flush as
    // containers shut down. Order asserted explicitly so a future
    // refactor can't silently revert this.
    happyPathMocks()
    const DELETE = await importHandler()
    await DELETE(mkRequest(), mkParams())
    const deleteServiceCallIdx = ecsSendMock.mock.invocationCallOrder.find(
      (_, i) =>
        (ecsSendMock.mock.calls[i]?.[0] as { __type: string })?.__type ===
        'DeleteServiceCommand',
    )
    const deleteLogGroupCallIdx =
      logsSendMock.mock.invocationCallOrder[
        logsSendMock.mock.calls.findIndex(
          (c) => (c[0] as { __type: string }).__type === 'DeleteLogGroupCommand',
        )
      ]
    expect(deleteServiceCallIdx).toBeDefined()
    expect(deleteLogGroupCallIdx).toBeDefined()
    expect(deleteLogGroupCallIdx).toBeGreaterThan(deleteServiceCallIdx!)
  })
})

describe('DELETE /api/fleet/agents/:name — idempotency', () => {
  it('returns 200 with warning when listener rule is already gone', async () => {
    ecsSendMock.mockReset()
    elbv2SendMock.mockReset()
    logsSendMock.mockReset()

    ecsSendMock
      .mockResolvedValueOnce({
        services: [
          {
            serviceArn: SERVICE_ARN,
            status: 'ACTIVE',
            tags: [
              { key: 'Component', value: 'agent-harness' },
              { key: 'ManagedBy', value: 'mission-control' },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({}) // UpdateService
      .mockResolvedValueOnce({ taskDefinitionArns: [] }) // ListTaskDefinitions empty
      .mockResolvedValueOnce({}) // DeleteService

    elbv2SendMock
      .mockResolvedValueOnce({ LoadBalancers: [{ LoadBalancerArn: ALB_ARN }] })
      .mockResolvedValueOnce({ Listeners: [{ ListenerArn: LISTENER_ARN }] })
      // DescribeRules returns no matching rule for this agent
      .mockResolvedValueOnce({ Rules: [] })
      // DescribeTargetGroups returns the TG (still present)
      .mockResolvedValueOnce({ TargetGroups: [{ TargetGroupArn: TG_ARN }] })
      .mockResolvedValueOnce({}) // DeleteTargetGroup

    logsSendMock.mockResolvedValueOnce({})

    const DELETE = await importHandler()
    const resp = await DELETE(mkRequest(), mkParams())
    expect(resp.status).toBe(200)
    const json = (await resp.json()) as {
      deletedResources: { listenerRuleArn?: string }
      warnings: Array<{ code: string }>
    }
    expect(json.deletedResources.listenerRuleArn).toBeUndefined()
    expect(json.warnings.map((w) => w.code)).toContain(
      'listener-rule-not-found',
    )
  })

  it('returns 200 with warning when log group is already gone (DeleteLogGroup → ResourceNotFoundException)', async () => {
    ecsSendMock.mockReset()
    elbv2SendMock.mockReset()
    logsSendMock.mockReset()

    ecsSendMock
      .mockResolvedValueOnce({
        services: [
          {
            serviceArn: SERVICE_ARN,
            status: 'ACTIVE',
            tags: [
              { key: 'Component', value: 'agent-harness' },
              { key: 'ManagedBy', value: 'mission-control' },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ taskDefinitionArns: [] })
      .mockResolvedValueOnce({})

    elbv2SendMock
      .mockResolvedValueOnce({ LoadBalancers: [{ LoadBalancerArn: ALB_ARN }] })
      .mockResolvedValueOnce({ Listeners: [{ ListenerArn: LISTENER_ARN }] })
      .mockResolvedValueOnce({
        Rules: [
          {
            RuleArn: RULE_ARN,
            Conditions: [
              { Field: 'path-pattern', Values: [`/agent/${AGENT}`] },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ TargetGroups: [{ TargetGroupArn: TG_ARN }] })
      .mockResolvedValueOnce({})

    const notFoundErr = Object.assign(new Error('Log group not found'), {
      name: 'ResourceNotFoundException',
    })
    logsSendMock.mockRejectedValueOnce(notFoundErr)

    const DELETE = await importHandler()
    const resp = await DELETE(mkRequest(), mkParams())
    expect(resp.status).toBe(200)
    const json = (await resp.json()) as {
      deletedResources: { logGroup?: string }
      warnings: Array<{ code: string }>
    }
    expect(json.deletedResources.logGroup).toBeUndefined()
    expect(json.warnings.map((w) => w.code)).toContain(
      'log-group-already-deleted',
    )
  })

  it('returns 200 with warning when target group is already gone (DescribeTargetGroups → TargetGroupNotFoundException)', async () => {
    ecsSendMock.mockReset()
    elbv2SendMock.mockReset()
    logsSendMock.mockReset()

    ecsSendMock
      .mockResolvedValueOnce({
        services: [
          {
            serviceArn: SERVICE_ARN,
            status: 'ACTIVE',
            tags: [
              { key: 'Component', value: 'agent-harness' },
              { key: 'ManagedBy', value: 'mission-control' },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ taskDefinitionArns: [] })
      .mockResolvedValueOnce({})

    const tgNotFound = Object.assign(new Error('TG not found'), {
      name: 'TargetGroupNotFoundException',
    })
    elbv2SendMock
      .mockResolvedValueOnce({ LoadBalancers: [{ LoadBalancerArn: ALB_ARN }] })
      .mockResolvedValueOnce({ Listeners: [{ ListenerArn: LISTENER_ARN }] })
      .mockResolvedValueOnce({
        Rules: [
          {
            RuleArn: RULE_ARN,
            Conditions: [
              { Field: 'path-pattern', Values: [`/agent/${AGENT}`] },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({})
      // DescribeTargetGroups throws — TG already deleted
      .mockRejectedValueOnce(tgNotFound)

    logsSendMock.mockResolvedValueOnce({})

    const DELETE = await importHandler()
    const resp = await DELETE(mkRequest(), mkParams())
    expect(resp.status).toBe(200)
    const json = (await resp.json()) as {
      warnings: Array<{ code: string }>
    }
    expect(json.warnings.map((w) => w.code)).toContain('target-group-not-found')
  })
})

describe('DELETE /api/fleet/agents/:name — sibling-family safety', () => {
  it('does NOT deregister task-defs from sibling families that share the prefix (e.g. delete `bot` must not touch `bot-test`)', async () => {
    // ListTaskDefinitions familyPrefix is a PREFIX match, not exact —
    // `familyPrefix=bot` returns revisions for `bot`, `bot-test`,
    // `bot-2026`, etc. The handler filters returned ARNs back to the
    // EXACT family before deregistering. Without this filter, deleting
    // a short-named agent would silently deregister another agent's
    // task-defs.
    ecsSendMock
      .mockResolvedValueOnce({
        services: [
          {
            serviceArn: SERVICE_ARN,
            status: 'ACTIVE',
            tags: [
              { key: 'Component', value: 'agent-harness' },
              { key: 'ManagedBy', value: 'mission-control' },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({}) // UpdateService
      // ListTaskDefinitions returns ARNs for BOTH the target family
      // (`...-hello-bot`) and a sibling family (`...-hello-bot-test`).
      .mockResolvedValueOnce({
        taskDefinitionArns: [
          TASK_DEF_ARN_1, // ender-stack-dev-companion-openclaw-hello-bot:1
          // Sibling: same prefix + `-test` suffix
          'arn:aws:ecs:us-east-1:398152419239:task-definition/ender-stack-dev-companion-openclaw-hello-bot-test:1',
          TASK_DEF_ARN_2, // ender-stack-dev-companion-openclaw-hello-bot:2
        ],
      })
      .mockResolvedValueOnce({}) // DeregisterTaskDefinition (only for matching family)
      .mockResolvedValueOnce({}) // DeregisterTaskDefinition (only for matching family)
      .mockResolvedValueOnce({}) // DeleteService

    elbv2SendMock
      .mockResolvedValueOnce({ LoadBalancers: [{ LoadBalancerArn: ALB_ARN }] })
      .mockResolvedValueOnce({
        Listeners: [{ ListenerArn: LISTENER_ARN, Protocol: 'HTTP' }],
      })
      .mockResolvedValueOnce({
        Rules: [
          {
            RuleArn: RULE_ARN,
            Conditions: [
              { Field: 'path-pattern', Values: [`/agent/${AGENT}`] },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ TargetGroups: [{ TargetGroupArn: TG_ARN }] })
      .mockResolvedValueOnce({})

    logsSendMock.mockResolvedValueOnce({})

    const DELETE = await importHandler()
    const resp = await DELETE(mkRequest(), mkParams())
    expect(resp.status).toBe(200)
    const json = (await resp.json()) as {
      deletedResources: { taskDefinitionRevisions?: string[] }
    }
    // Exactly the 2 ARNs for the target family — sibling NOT deregistered
    expect(json.deletedResources.taskDefinitionRevisions).toEqual([
      TASK_DEF_ARN_1,
      TASK_DEF_ARN_2,
    ])
    expect(
      json.deletedResources.taskDefinitionRevisions?.find((arn) =>
        arn.includes('hello-bot-test'),
      ),
    ).toBeUndefined()
    // DeregisterTaskDefinition was called exactly TWICE — once per
    // matching ARN. Sibling skipped; counted by inspecting the mock
    // call list rather than relying on call count (which mixes
    // describe + delete).
    const deregCalls = ecsSendMock.mock.calls.filter(
      (c) =>
        (c[0] as { __type: string }).__type ===
        'DeregisterTaskDefinitionCommand',
    )
    expect(deregCalls).toHaveLength(2)
  })
})

describe('DELETE /api/fleet/agents/:name — refusal paths', () => {
  it('refuses non-MC-managed agent with 404 (smoke-test protection)', async () => {
    // Smoke-test has Component=agent-harness but ManagedBy=terraform —
    // teardown-protected by Terraform state, not this endpoint.
    ecsSendMock.mockResolvedValueOnce({
      services: [
        {
          serviceArn: SERVICE_ARN,
          status: 'ACTIVE',
          tags: [
            { key: 'Component', value: 'agent-harness' },
            { key: 'ManagedBy', value: 'terraform' },
          ],
        },
      ],
    })
    const DELETE = await importHandler()
    const resp = await DELETE(mkRequest(), mkParams())
    expect(resp.status).toBe(404)
    const json = (await resp.json()) as { error: string }
    expect(json.error).toBe('ServiceNotFoundException')
    // Defense-in-depth: confirm no destructive AWS calls fired
    expect(ecsSendMock).toHaveBeenCalledTimes(1) // only DescribeServices
    expect(elbv2SendMock).not.toHaveBeenCalled()
    expect(logsSendMock).not.toHaveBeenCalled()
  })

  it('refuses non-harness platform service with 404 (e.g. mission-control itself)', async () => {
    ecsSendMock.mockResolvedValueOnce({
      services: [
        {
          serviceArn: SERVICE_ARN,
          status: 'ACTIVE',
          tags: [
            { key: 'Component', value: 'platform' },
            { key: 'ManagedBy', value: 'terraform' },
          ],
        },
      ],
    })
    const DELETE = await importHandler()
    const resp = await DELETE(mkRequest(), mkParams())
    expect(resp.status).toBe(404)
  })

  it('returns 404 when service not found', async () => {
    ecsSendMock.mockResolvedValueOnce({ services: [] })
    const DELETE = await importHandler()
    const resp = await DELETE(mkRequest(), mkParams())
    expect(resp.status).toBe(404)
    const json = (await resp.json()) as { error: string }
    expect(json.error).toBe('ServiceNotFoundException')
  })

  it('continues teardown when service is already INACTIVE (idempotent retry path)', async () => {
    // Round-1 audit on PR #43 caught a stuck-state: a prior DELETE
    // that succeeded at DeleteService but failed downstream (e.g.
    // DeleteLogGroup before the IAM grant in PR #262 applied) leaves
    // the service INACTIVE while listener rule / TG / log group
    // still exist. 404'ing on retry would strand those resources.
    // INACTIVE is now treated as "ECS portion already done, finish
    // the rest" — handler returns 200 with a warning instead.
    ecsSendMock
      .mockResolvedValueOnce({
        services: [
          {
            serviceArn: SERVICE_ARN,
            status: 'INACTIVE',
            tags: [
              { key: 'Component', value: 'agent-harness' },
              { key: 'ManagedBy', value: 'mission-control' },
            ],
          },
        ],
      })
      // Note: no UpdateService / DeleteService mocks because the
      // INACTIVE branch skips both.
      .mockResolvedValueOnce({ taskDefinitionArns: [] }) // ListTaskDefinitions

    elbv2SendMock
      .mockResolvedValueOnce({ LoadBalancers: [{ LoadBalancerArn: ALB_ARN }] })
      .mockResolvedValueOnce({
        Listeners: [{ ListenerArn: LISTENER_ARN, Protocol: 'HTTP' }],
      })
      .mockResolvedValueOnce({
        Rules: [
          {
            RuleArn: RULE_ARN,
            Conditions: [
              { Field: 'path-pattern', Values: [`/agent/${AGENT}`] },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({}) // DeleteRule
      .mockResolvedValueOnce({ TargetGroups: [{ TargetGroupArn: TG_ARN }] })
      .mockResolvedValueOnce({}) // DeleteTargetGroup

    logsSendMock.mockResolvedValueOnce({})

    const DELETE = await importHandler()
    const resp = await DELETE(mkRequest(), mkParams())
    expect(resp.status).toBe(200)
    const json = (await resp.json()) as {
      deletedResources: { serviceArn?: string; listenerRuleArn?: string }
      warnings: Array<{ code: string }>
    }
    // Service was already gone — not in deletedResources
    expect(json.deletedResources.serviceArn).toBeUndefined()
    // But everything downstream was cleaned up
    expect(json.deletedResources.listenerRuleArn).toBe(RULE_ARN)
    expect(json.warnings.map((w) => w.code)).toContain('service-already-deleted')
  })
})

describe('DELETE /api/fleet/agents/:name — auth + validation', () => {
  it('returns 403 when caller is not admin', async () => {
    vi.mocked(auth.requireRole).mockReturnValueOnce({
      error: 'Forbidden',
      status: 403,
    } as unknown as ReturnType<typeof auth.requireRole>)
    const DELETE = await importHandler()
    const resp = await DELETE(mkRequest(), mkParams())
    expect(resp.status).toBe(403)
    expect(ecsSendMock).not.toHaveBeenCalled()
  })

  it('returns 400 when agentName fails the regex (security boundary)', async () => {
    const DELETE = await importHandler()
    const resp = await DELETE(mkRequest(), mkParams('UPPERCASE-NAME'))
    expect(resp.status).toBe(400)
    const json = (await resp.json()) as { error: string; detail?: string }
    expect(json.error).toBe('InvalidAgentName')
    // Defense-in-depth: NO AWS calls — handler short-circuits on
    // bad name before reaching DescribeServices.
    expect(ecsSendMock).not.toHaveBeenCalled()
    expect(elbv2SendMock).not.toHaveBeenCalled()
    expect(logsSendMock).not.toHaveBeenCalled()
  })

  it('returns 400 when agentName is empty', async () => {
    const DELETE = await importHandler()
    const resp = await DELETE(mkRequest(), mkParams(''))
    expect(resp.status).toBe(400)
    expect(ecsSendMock).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/fleet/agents/:name — partial failure', () => {
  it('returns 502 with deletedResources + failedResources when DeleteRule throws AccessDenied', async () => {
    ecsSendMock.mockReset()
    elbv2SendMock.mockReset()
    logsSendMock.mockReset()

    ecsSendMock
      .mockResolvedValueOnce({
        services: [
          {
            serviceArn: SERVICE_ARN,
            status: 'ACTIVE',
            tags: [
              { key: 'Component', value: 'agent-harness' },
              { key: 'ManagedBy', value: 'mission-control' },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({}) // UpdateService

    const accessDenied = Object.assign(new Error('AccessDenied'), {
      name: 'AccessDeniedException',
    })
    elbv2SendMock
      .mockResolvedValueOnce({ LoadBalancers: [{ LoadBalancerArn: ALB_ARN }] })
      .mockResolvedValueOnce({
        Listeners: [{ ListenerArn: LISTENER_ARN, Protocol: 'HTTP' }],
      })
      .mockResolvedValueOnce({
        Rules: [
          {
            RuleArn: RULE_ARN,
            Conditions: [
              { Field: 'path-pattern', Values: [`/agent/${AGENT}`] },
            ],
          },
        ],
      })
      .mockRejectedValueOnce(accessDenied) // DeleteRule throws

    const DELETE = await importHandler()
    const resp = await DELETE(mkRequest(), mkParams())
    expect(resp.status).toBe(502)
    const json = (await resp.json()) as {
      error: string
      deletedResources?: Record<string, unknown>
      failedResources?: Record<string, unknown>
    }
    expect(json.error).toBe('AccessDeniedException')
    // Service was DISCOVERED in step 1 but NEVER DELETED — so it
    // belongs in failedResources, not deletedResources. The
    // contract is: deletedResources lists actual successful deletes,
    // failedResources lists what the operator must clean up
    // manually. (The discovered ARN appears in failedResources so
    // the operator has the full ARN, not just the service name.)
    expect(json.deletedResources?.serviceArn).toBeUndefined()
    expect(json.failedResources).toBeDefined()
    expect(json.failedResources?.serviceArn).toBe(SERVICE_ARN)
    expect(json.failedResources?.listenerRuleArn).toBeDefined()
    expect(json.failedResources?.logGroup).toBeDefined()
    expect(json.failedResources?.taskDefinitionRevisions).toBeDefined()
  })
})
