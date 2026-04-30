import { describe, expect, it } from 'vitest'
import {
  renderTaskDefinition,
  renderTargetGroup,
  renderService,
  renderListenerRule,
  type OpenClawAgentInput,
  type OpenClawAgentEnv,
} from '../templates/openclaw'
import { HARNESS_TEMPLATES } from '../templates'

const fixtureInput: OpenClawAgentInput = {
  agentName: 'hello-world',
  roleDescription: 'Says hello',
  image: 'ghcr.io/stroupaloop/openclaw:sha-abc123',
  modelTier: 'sonnet-4-6',
}

const fixtureEnv: OpenClawAgentEnv = {
  region: 'us-east-1',
  prefix: 'ender-stack-dev',
  clusterName: 'ender-stack-dev',
  taskRoleArn:
    'arn:aws:iam::398152419239:role/ender-stack-dev-companion-openclaw-mc-task',
  executionRoleArn:
    'arn:aws:iam::398152419239:role/ender-stack-dev-companion-openclaw-mc-exec',
  logGroupPrefix: '/ecs/ender-stack-dev',
  vpcId: 'vpc-abc',
  subnetIds: ['subnet-1', 'subnet-2'],
  securityGroupId: 'sg-ecs',
  litellmAlbDnsName: 'internal-litellm.us-east-1.elb.amazonaws.com',
  tags: {
    Project: 'ender-stack',
    Environment: 'dev',
    Owner: 'mission-control',
    ManagedBy: 'mission-control',
  },
}

describe('renderTaskDefinition', () => {
  it('builds the family from prefix + agent name', () => {
    const taskDef = renderTaskDefinition(fixtureInput, fixtureEnv)
    expect(taskDef.family).toBe('ender-stack-dev-companion-openclaw-hello-world')
  })

  it('sets Fargate-compatible launch type and awsvpc network', () => {
    const taskDef = renderTaskDefinition(fixtureInput, fixtureEnv)
    expect(taskDef.requiresCompatibilities).toEqual(['FARGATE'])
    expect(taskDef.networkMode).toBe('awsvpc')
  })

  it('passes the per-agent env vars on the gateway container', () => {
    const taskDef = renderTaskDefinition(fixtureInput, fixtureEnv)
    const gateway = taskDef.containerDefinitions?.[0]
    expect(gateway?.name).toBe('gateway')
    const env = gateway?.environment ?? []
    expect(env).toContainEqual({
      name: 'OPENCLAW_AGENT_NAME',
      value: 'hello-world',
    })
    expect(env).toContainEqual({ name: 'OPENCLAW_MODEL', value: 'sonnet-4-6' })
    expect(env).toContainEqual({
      name: 'LITELLM_API_BASE',
      value: 'http://internal-litellm.us-east-1.elb.amazonaws.com',
    })
  })

  it('does not emit a SLACK_WEBHOOK_URL env var (deferred to Phase 2.5 secrets-manager wiring)', () => {
    const taskDef = renderTaskDefinition(fixtureInput, fixtureEnv)
    const env = taskDef.containerDefinitions?.[0]?.environment ?? []
    expect(env.find((e) => e.name === 'SLACK_WEBHOOK_URL')).toBeUndefined()
  })

  it('points awslogs-group at the per-agent log group', () => {
    const taskDef = renderTaskDefinition(fixtureInput, fixtureEnv)
    const opts = taskDef.containerDefinitions?.[0]?.logConfiguration?.options
    expect(opts?.['awslogs-group']).toBe(
      '/ecs/ender-stack-dev/companion-openclaw-hello-world',
    )
    expect(opts?.['awslogs-region']).toBe('us-east-1')
  })

  it('tags the task-def with Component=agent-harness so Fleet picks it up', () => {
    const taskDef = renderTaskDefinition(fixtureInput, fixtureEnv)
    const tags = taskDef.tags ?? []
    expect(tags).toContainEqual({ key: 'Component', value: 'agent-harness' })
    expect(tags).toContainEqual({ key: 'Harness', value: 'companion/openclaw' })
    expect(tags).toContainEqual({ key: 'AgentName', value: 'hello-world' })
  })

  it('uses the IAM-aligned task + exec role ARNs', () => {
    const taskDef = renderTaskDefinition(fixtureInput, fixtureEnv)
    expect(taskDef.taskRoleArn).toBe(fixtureEnv.taskRoleArn)
    expect(taskDef.executionRoleArn).toBe(fixtureEnv.executionRoleArn)
  })
})

describe('renderTargetGroup', () => {
  it('uses the prefix-agent-{name} pattern (singular agent vs plural agents on the LB)', () => {
    const tg = renderTargetGroup(fixtureInput, fixtureEnv)
    expect(tg.Name).toBe('ender-stack-dev-agent-hello-world')
  })

  it('uses /healthz on port 18789 (matches OpenClaw gateway)', () => {
    const tg = renderTargetGroup(fixtureInput, fixtureEnv)
    expect(tg.HealthCheckPath).toBe('/healthz')
    expect(tg.Port).toBe(18789)
    expect(tg.HealthCheckPort).toBe('traffic-port')
  })

  it('targets IPs (awsvpc tasks register by IP, not instance ID)', () => {
    const tg = renderTargetGroup(fixtureInput, fixtureEnv)
    expect(tg.TargetType).toBe('ip')
  })
})

describe('renderService', () => {
  it('uses the prefix-companion-openclaw-{name} pattern matching IAM CreateService scope', () => {
    const svc = renderService(fixtureInput, fixtureEnv, {
      taskDefinitionArn: 'arn:aws:ecs:us-east-1:398152419239:task-definition/x:1',
      targetGroupArn:
        'arn:aws:elasticloadbalancing:us-east-1:398152419239:targetgroup/ender-stack-dev-agent-hello-world/abc',
    })
    expect(svc.serviceName).toBe(
      'ender-stack-dev-companion-openclaw-hello-world',
    )
  })

  it('binds the gateway container on the right port for ALB target registration', () => {
    const svc = renderService(fixtureInput, fixtureEnv, {
      taskDefinitionArn: 'arn:tdf',
      targetGroupArn: 'arn:tg',
    })
    const lb = svc.loadBalancers?.[0]
    expect(lb?.containerName).toBe('gateway')
    expect(lb?.containerPort).toBe(18789)
  })

  it('runs in private subnets with assignPublicIp DISABLED', () => {
    const svc = renderService(fixtureInput, fixtureEnv, {
      taskDefinitionArn: 'arn:tdf',
      targetGroupArn: 'arn:tg',
    })
    const cfg = svc.networkConfiguration?.awsvpcConfiguration
    expect(cfg?.assignPublicIp).toBe('DISABLED')
    expect(cfg?.subnets).toEqual(['subnet-1', 'subnet-2'])
    expect(cfg?.securityGroups).toEqual(['sg-ecs'])
  })

  it('explicitly disables ECS Exec — operator privilege escalation vector', () => {
    const svc = renderService(fixtureInput, fixtureEnv, {
      taskDefinitionArn: 'arn:tdf',
      targetGroupArn: 'arn:tg',
    })
    expect(svc.enableExecuteCommand).toBe(false)
  })
})

describe('renderListenerRule', () => {
  it('emits two explicit path patterns to avoid prefix-pair collisions', () => {
    const rule = renderListenerRule(fixtureInput, fixtureEnv, {
      targetGroupArn: 'arn:tg',
      priority: 1234,
    })
    // Two patterns: exact-name root + subtree. Prevents `/agent/bot-test/api`
    // from matching a `/agent/bot*` glob and silently routing to `bot`.
    expect(rule.pathPatterns).toEqual([
      '/agent/hello-world',
      '/agent/hello-world/*',
    ])
    expect(rule.targetGroupArn).toBe('arn:tg')
    expect(rule.priority).toBe(1234)
  })
})

describe('HARNESS_TEMPLATES.companion/openclaw validateInput', () => {
  const validate =
    HARNESS_TEMPLATES['companion/openclaw'].validateInput

  it('accepts a valid agent name', () => {
    expect(() => validate(fixtureInput)).not.toThrow()
  })

  it('rejects agent name shorter than 3 chars', () => {
    expect(() => validate({ ...fixtureInput, agentName: 'ab' })).toThrow(
      /agentName/,
    )
  })

  it('rejects agent name longer than 32 chars', () => {
    expect(() =>
      validate({ ...fixtureInput, agentName: 'a'.repeat(33) }),
    ).toThrow(/agentName/)
  })

  it('rejects uppercase characters', () => {
    expect(() => validate({ ...fixtureInput, agentName: 'Hello' })).toThrow(
      /agentName/,
    )
  })

  it('rejects characters outside [a-z0-9-]', () => {
    expect(() => validate({ ...fixtureInput, agentName: 'hello_world' })).toThrow(
      /agentName/,
    )
    expect(() => validate({ ...fixtureInput, agentName: 'hello.world' })).toThrow(
      /agentName/,
    )
  })

  it('rejects names starting with a hyphen', () => {
    expect(() => validate({ ...fixtureInput, agentName: '-hello' })).toThrow(
      /agentName/,
    )
  })

  it('rejects names ending with a hyphen', () => {
    expect(() => validate({ ...fixtureInput, agentName: 'hello-' })).toThrow(
      /agentName/,
    )
  })

  it('rejects names that are only hyphens', () => {
    expect(() => validate({ ...fixtureInput, agentName: '---' })).toThrow(
      /agentName/,
    )
  })

  it('rejects names starting with a digit (lowercase-letter start required)', () => {
    expect(() => validate({ ...fixtureInput, agentName: '1abc' })).toThrow(
      /agentName/,
    )
  })

  it('accepts names with internal hyphens and digits', () => {
    expect(() =>
      validate({ ...fixtureInput, agentName: 'bot-v2-prod' }),
    ).not.toThrow()
  })

  it('rejects an image without a tag/digest separator', () => {
    expect(() => validate({ ...fixtureInput, image: 'untagged-image' })).toThrow(
      /image/,
    )
  })

  it('rejects an image from an unallowed registry', () => {
    expect(() =>
      validate({
        ...fixtureInput,
        image: 'docker.io/attacker/malicious:latest',
      }),
    ).toThrow(/registry/)
  })

  it('accepts images from ECR in this account', () => {
    expect(() =>
      validate({
        ...fixtureInput,
        image:
          '398152419239.dkr.ecr.us-east-1.amazonaws.com/ender-stack/openclaw:sha-deadbeef',
      }),
    ).not.toThrow()
  })

  it('accepts images from public ECR', () => {
    expect(() =>
      validate({
        ...fixtureInput,
        image: 'public.ecr.aws/openclaw/openclaw:v1.2.3',
      }),
    ).not.toThrow()
  })

  it('honors MC_FLEET_IMAGE_REGISTRY_ALLOWLIST override', () => {
    const original = process.env.MC_FLEET_IMAGE_REGISTRY_ALLOWLIST
    process.env.MC_FLEET_IMAGE_REGISTRY_ALLOWLIST =
      String.raw`example\.com/`
    try {
      expect(() =>
        validate({
          ...fixtureInput,
          image: 'example.com/some/image:tag',
        }),
      ).not.toThrow()
      // Default-allowed registry now rejected because the override
      // replaces the list rather than appending.
      expect(() =>
        validate({
          ...fixtureInput,
          image: 'ghcr.io/stroupaloop/openclaw:tag',
        }),
      ).toThrow(/registry/)
    } finally {
      if (original === undefined) {
        delete process.env.MC_FLEET_IMAGE_REGISTRY_ALLOWLIST
      } else {
        process.env.MC_FLEET_IMAGE_REGISTRY_ALLOWLIST = original
      }
    }
  })

  it('rejects an empty roleDescription', () => {
    expect(() => validate({ ...fixtureInput, roleDescription: '' })).toThrow(
      /roleDescription/,
    )
    expect(() =>
      validate({ ...fixtureInput, roleDescription: '   ' }),
    ).toThrow(/roleDescription/)
  })
})
