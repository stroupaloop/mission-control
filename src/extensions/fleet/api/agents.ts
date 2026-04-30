import { NextRequest, NextResponse } from 'next/server'
import {
  ECSClient,
  RegisterTaskDefinitionCommand,
  CreateServiceCommand,
} from '@aws-sdk/client-ecs'
import {
  ElasticLoadBalancingV2Client,
  CreateTargetGroupCommand,
  CreateRuleCommand,
  DescribeLoadBalancersCommand,
  DescribeListenersCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2'
import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  PutRetentionPolicyCommand,
} from '@aws-sdk/client-cloudwatch-logs'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'
import {
  HARNESS_TEMPLATES,
  HARNESS_TYPES,
  type HarnessType,
  type OpenClawAgentInput,
  type OpenClawAgentEnv,
} from '@/extensions/fleet/templates'

/**
 * POST /api/fleet/agents — create a new MC-managed agent end-to-end.
 *
 * Phase 2.2 Beat 3a (backend). Orchestrates the full ECS + ELBv2
 * create-agent flow: register task-def → create CW log group →
 * create target group → create listener rule → create service.
 *
 * Auth: `admin` role required. Phase 2.1 Redeploy was `operator` (lower
 * blast radius — kicks existing config). Create is permanent +
 * irreversible at the IAM grant boundary, so it sits one tier higher.
 *
 * Hybrid source-of-truth boundary:
 *   Terraform owns: ECS cluster, IAM roles, shared agents ALB +
 *     listener (ender-stack/terraform/modules/agents-shared-alb),
 *     shared OpenClaw task + exec roles (ender-stack #210, follow-up).
 *   This handler owns: per-agent task-def + service + target group +
 *     listener rule + CW log group, all created via runtime API calls.
 *     None of these resources land in Terraform state.
 *
 * Idempotency:
 *   The handler is NOT idempotent today — calling it twice with the same
 *   agent name returns a 409 (conflict) on the second call because the
 *   ECS service already exists. Reconciliation across MC SQLite ↔ ECS is
 *   deferred to Beat 3c (the scheduled reconciler).
 *
 * Validation:
 *   `agentName` must match `^[a-z0-9-]{3,32}$`. The IAM policy doc for
 *   `task_ecs_write` (ender-stack PR #208) explicitly cites this regex
 *   as load-bearing — `ecs:RegisterTaskDefinition` is granted Resource:"*"
 *   because the AWS verb has no resource-level auth, so this regex is
 *   the only thing keeping a compromised request from registering a
 *   task-def with an arbitrary family name (e.g., overwriting `litellm`).
 *   Treat it accordingly: it's a security control, not a UX nicety.
 *
 * Error responses return only the SDK error name (no message detail) to
 * avoid leaking IAM ARNs / account IDs into the browser. Full stack
 * remains in CloudWatch via the logger.error call.
 */

// Listener-rule priority bounds. AWS requires unique priorities per
// listener; agent names are hashed to a stable priority to avoid
// runtime collisions. Range avoids the default action's implicit 0 and
// AWS's reserved tail (50000+).
const PRIORITY_RANGE_MIN = 100
const PRIORITY_RANGE_MAX = 49999

// AWS clients are constructed lazily so test mutations of AWS_REGION
// take effect on import. Same singleton pattern as services.ts /
// redeploy.ts but accessed via getter functions.
const AWS_REGION = process.env.AWS_REGION || 'us-east-1'
const ecsClient = new ECSClient({ region: AWS_REGION })
const elbv2Client = new ElasticLoadBalancingV2Client({ region: AWS_REGION })
const logsClient = new CloudWatchLogsClient({ region: AWS_REGION })

interface ResolvedEnv {
  region: string
  clusterName: string
  accountId: string
  projectName: string
  environment: string
  prefix: string
  taskRoleArn: string
  executionRoleArn: string
  logGroupPrefix: string
  logRetentionDays: number
  vpcId: string
  subnetIds: string[]
  securityGroupId: string
  litellmAlbDnsName: string
  sharedAlbName: string
}

/**
 * Read every required env var fresh per-request. Module-level caching
 * was the original shape but it makes env-validation tests impossible
 * to write — module-load constants don't react to `delete process.env.X`
 * within a test. Re-reading per request is fine for create-agent (low
 * frequency, not a hot path).
 */
function resolveEnv(): ResolvedEnv {
  const clusterName = process.env.MC_FLEET_CLUSTER_NAME || 'ender-stack-dev'
  const projectName =
    process.env.MC_FLEET_PROJECT_NAME ||
    clusterName.split('-').slice(0, -1).join('-')
  const environment =
    process.env.MC_FLEET_ENVIRONMENT || clusterName.split('-').pop() || 'dev'
  return {
    region: process.env.AWS_REGION || 'us-east-1',
    clusterName,
    accountId: process.env.MC_AWS_ACCOUNT_ID || '',
    projectName,
    environment,
    prefix: `${projectName}-${environment}`,
    taskRoleArn: process.env.MC_AGENT_TASK_ROLE_ARN || '',
    executionRoleArn: process.env.MC_AGENT_EXECUTION_ROLE_ARN || '',
    logGroupPrefix:
      process.env.MC_AGENT_LOG_GROUP_PREFIX || `/ecs/${clusterName}`,
    logRetentionDays: Number(process.env.MC_AGENT_LOG_RETENTION_DAYS || '365'),
    vpcId: process.env.MC_AGENT_VPC_ID || '',
    subnetIds: (process.env.MC_AGENT_SUBNET_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    securityGroupId: process.env.MC_AGENT_SECURITY_GROUP_ID || '',
    litellmAlbDnsName: process.env.MC_LITELLM_ALB_DNS_NAME || '',
    sharedAlbName: `${projectName}-${environment}-agents-shared`,
  }
}

export interface CreateAgentRequest {
  harnessType: HarnessType
  agentName: string
  roleDescription: string
  image: string
  modelTier: 'opus-4-7' | 'sonnet-4-6' | 'haiku-4-5'
  slackWebhookUrl?: string
}

export interface CreateAgentResponse {
  ok: true
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

export interface CreateAgentErrorResponse {
  error: string
  detail?: string
}

/** Hash agent name to a deterministic priority within the allowed range. */
function priorityFor(agentName: string): number {
  let h = 5381
  for (let i = 0; i < agentName.length; i++) {
    h = ((h << 5) + h + agentName.charCodeAt(i)) | 0
  }
  const range = PRIORITY_RANGE_MAX - PRIORITY_RANGE_MIN + 1
  return PRIORITY_RANGE_MIN + (Math.abs(h) % range)
}

function buildTags(env: ResolvedEnv): Record<string, string> {
  return {
    Project: env.projectName,
    Environment: env.environment,
    Owner: 'mission-control',
    ManagedBy: 'mission-control',
  }
}

/** Validate every required env var; surface a single 500 with the missing list. */
function checkEnvOrThrow(env: ResolvedEnv): string[] {
  const missing: string[] = []
  if (!env.accountId) missing.push('MC_AWS_ACCOUNT_ID')
  if (!env.taskRoleArn) missing.push('MC_AGENT_TASK_ROLE_ARN')
  if (!env.executionRoleArn) missing.push('MC_AGENT_EXECUTION_ROLE_ARN')
  if (!env.vpcId) missing.push('MC_AGENT_VPC_ID')
  if (env.subnetIds.length === 0) missing.push('MC_AGENT_SUBNET_IDS')
  if (!env.securityGroupId) missing.push('MC_AGENT_SECURITY_GROUP_ID')
  if (!env.litellmAlbDnsName) missing.push('MC_LITELLM_ALB_DNS_NAME')
  return missing
}

function isCreateAgentRequest(body: unknown): body is CreateAgentRequest {
  if (!body || typeof body !== 'object') return false
  const b = body as Record<string, unknown>
  return (
    typeof b.harnessType === 'string' &&
    HARNESS_TYPES.includes(b.harnessType as HarnessType) &&
    typeof b.agentName === 'string' &&
    typeof b.roleDescription === 'string' &&
    typeof b.image === 'string' &&
    typeof b.modelTier === 'string' &&
    ['opus-4-7', 'sonnet-4-6', 'haiku-4-5'].includes(b.modelTier as string) &&
    (b.slackWebhookUrl === undefined || typeof b.slackWebhookUrl === 'string')
  )
}

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  const resolved = resolveEnv()
  const missing = checkEnvOrThrow(resolved)
  if (missing.length > 0) {
    logger.error(
      { missing },
      '[fleet] create-agent unavailable: required env vars unset',
    )
    return NextResponse.json(
      {
        error: 'ConfigurationError',
        detail: `Missing required env: ${missing.join(', ')}`,
      } satisfies CreateAgentErrorResponse,
      { status: 500 },
    )
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { error: 'InvalidRequestBody' } satisfies CreateAgentErrorResponse,
      { status: 400 },
    )
  }

  if (!isCreateAgentRequest(body)) {
    return NextResponse.json(
      { error: 'InvalidRequestShape' } satisfies CreateAgentErrorResponse,
      { status: 400 },
    )
  }

  const harnessType = body.harnessType
  const template = HARNESS_TEMPLATES[harnessType]
  const input: OpenClawAgentInput = {
    agentName: body.agentName,
    roleDescription: body.roleDescription,
    image: body.image,
    modelTier: body.modelTier,
    slackWebhookUrl: body.slackWebhookUrl,
  }

  // Per-harness validation. Throws on bad input — caught below as 400.
  try {
    template.validateInput(input)
  } catch (err) {
    const message = (err as Error).message
    return NextResponse.json(
      {
        error: 'ValidationError',
        detail: message,
      } satisfies CreateAgentErrorResponse,
      { status: 400 },
    )
  }

  const env: OpenClawAgentEnv = {
    accountId: resolved.accountId,
    region: resolved.region,
    prefix: resolved.prefix,
    clusterName: resolved.clusterName,
    taskRoleArn: resolved.taskRoleArn,
    executionRoleArn: resolved.executionRoleArn,
    logGroupPrefix: resolved.logGroupPrefix,
    vpcId: resolved.vpcId,
    subnetIds: resolved.subnetIds,
    securityGroupId: resolved.securityGroupId,
    litellmAlbDnsName: resolved.litellmAlbDnsName,
    tags: buildTags(resolved),
  }

  const logGroupName = `${resolved.logGroupPrefix}/companion-openclaw-${input.agentName}`
  const listenerPath = `/agent/${input.agentName}*`

  try {
    // 1. Resolve the shared listener ARN. DescribeLoadBalancers (by
    // name) → DescribeListeners (by LB ARN). Both are read-only and
    // covered by the ELBv2DescribeReadOnly IAM grant.
    const lbResp = await elbv2Client.send(
      new DescribeLoadBalancersCommand({ Names: [resolved.sharedAlbName] }),
    )
    const lbArn = lbResp.LoadBalancers?.[0]?.LoadBalancerArn
    if (!lbArn) {
      throw new Error(
        `Shared agents ALB not found: ${resolved.sharedAlbName}. Has ender-stack/agents-shared-alb been applied?`,
      )
    }
    const listenersResp = await elbv2Client.send(
      new DescribeListenersCommand({ LoadBalancerArn: lbArn }),
    )
    const listenerArn = listenersResp.Listeners?.[0]?.ListenerArn
    if (!listenerArn) {
      throw new Error(
        `Shared agents ALB has no listeners: ${resolved.sharedAlbName}`,
      )
    }

    // 2. Pre-create the per-agent CloudWatch log group. Without this,
    // the awslogs driver's first write will fail and the task will
    // bootstrap into a stop loop. The alternative (`awslogs-create-group=true`
    // in the log driver options) requires `logs:CreateLogGroup` on the
    // exec role, which is broader than the explicit pre-create here.
    try {
      await logsClient.send(
        new CreateLogGroupCommand({ logGroupName }),
      )
    } catch (err) {
      const error = err as { name?: string }
      if (error.name !== 'ResourceAlreadyExistsException') throw err
      // Idempotent on retry: log group already exists from a prior partial create.
    }
    await logsClient.send(
      new PutRetentionPolicyCommand({
        logGroupName,
        retentionInDays: resolved.logRetentionDays,
      }),
    )

    // 3. Register the task definition.
    const taskDefInput = template.renderTaskDefinition(input, env)
    const taskDefResp = await ecsClient.send(
      new RegisterTaskDefinitionCommand(taskDefInput),
    )
    const taskDefinitionArn = taskDefResp.taskDefinition?.taskDefinitionArn
    if (!taskDefinitionArn) {
      throw new Error('RegisterTaskDefinition returned no ARN')
    }

    // 4. Create the per-agent target group.
    const tgInput = template.renderTargetGroup(input, env)
    const tgResp = await elbv2Client.send(new CreateTargetGroupCommand(tgInput))
    const targetGroupArn = tgResp.TargetGroups?.[0]?.TargetGroupArn
    if (!targetGroupArn) {
      throw new Error('CreateTargetGroup returned no ARN')
    }

    // 5. Attach a listener rule for `/agent/{agentName}*` → this TG.
    const ruleSpec = template.renderListenerRule(input, env, {
      targetGroupArn,
      priority: priorityFor(input.agentName),
    })
    const ruleResp = await elbv2Client.send(
      new CreateRuleCommand({
        ListenerArn: listenerArn,
        Priority: ruleSpec.priority,
        Conditions: [
          {
            Field: 'path-pattern',
            Values: [ruleSpec.pathPattern],
          },
        ],
        Actions: [
          {
            Type: 'forward',
            TargetGroupArn: targetGroupArn,
          },
        ],
        Tags: ruleSpec.tags,
      }),
    )
    const listenerRuleArn = ruleResp.Rules?.[0]?.RuleArn
    if (!listenerRuleArn) {
      throw new Error('CreateRule returned no ARN')
    }

    // 6. Create the ECS service. Once this returns, ECS starts
    // pulling the image and provisioning the task; the Fleet panel
    // reflects deployment progress via DescribeServices polling.
    const serviceInput = template.renderService(input, env, {
      taskDefinitionArn,
      targetGroupArn,
    })
    const serviceResp = await ecsClient.send(
      new CreateServiceCommand(serviceInput),
    )
    const serviceArn = serviceResp.service?.serviceArn
    if (!serviceArn) {
      throw new Error('CreateService returned no ARN')
    }

    logger.info(
      {
        agentName: input.agentName,
        harnessType,
        serviceArn,
        taskDefinitionArn,
        targetGroupArn,
        listenerRuleArn,
        actor: 'user' in auth ? auth.user.id : undefined,
      },
      '[fleet] created agent',
    )

    return NextResponse.json(
      {
        ok: true,
        agentName: input.agentName,
        resources: {
          serviceArn,
          taskDefinitionArn,
          targetGroupArn,
          listenerRuleArn,
          logGroup: logGroupName,
          listenerPath,
        },
      } satisfies CreateAgentResponse,
      { status: 201, headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    const error = err as { name?: string; message?: string }
    logger.error(
      {
        err,
        agentName: input.agentName,
        harnessType,
        cluster: resolved.clusterName,
        region: resolved.region,
      },
      '[fleet] create-agent failed',
    )
    // Conflict statuses (service already exists, target group name
    // taken, etc.) → 409. Validation/IAM/account quota → 502. Anything
    // else → 502 conservatively.
    const status =
      error.name === 'InvalidParameterException' ||
      error.name === 'ResourceAlreadyExistsException' ||
      error.name === 'DuplicateTargetGroupNameException' ||
      error.name === 'PriorityInUseException'
        ? 409
        : 502
    return NextResponse.json(
      {
        error: error.name || 'AWSError',
      } satisfies CreateAgentErrorResponse,
      { status },
    )
  }
}
