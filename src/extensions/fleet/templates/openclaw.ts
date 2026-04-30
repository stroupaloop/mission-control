import type {
  RegisterTaskDefinitionCommandInput,
  CreateServiceCommandInput,
} from '@aws-sdk/client-ecs'
import type { CreateTargetGroupCommandInput } from '@aws-sdk/client-elastic-load-balancing-v2'

/**
 * OpenClaw companion harness — task-def + ECS service + ALB target group
 * templates rendered from `/fleet/new` form input.
 *
 * Each template emits the exact AWS SDK input objects the create-agent
 * handler passes to RegisterTaskDefinition / CreateService / CreateTargetGroup.
 * Naming is load-bearing — the IAM grants in
 * ender-stack/terraform/modules/iam/main.tf authorize MC against ARN
 * patterns derived from `{prefix}-companion-openclaw-{name}`. Drift
 * between the templated names here and the IAM scopes will silently 403.
 *
 * The container surface mirrors the canonical Terraform-bootstrapped
 * openclaw module (ender-stack/terraform/modules/companion/openclaw/main.tf)
 * — two-container task with init-config + gateway, awsvpc network mode,
 * /healthz health check on port 18789. Kept intentionally minimal for
 * Phase 2.2 MVP; per-agent extensions, persona configs, and channel-token
 * binding are out of scope for this template (deferred to Phase 2.3).
 */

/**
 * Validated form input for an OpenClaw create-agent request.
 *
 * agentName regex `^[a-z0-9-]{3,32}$` is enforced server-side at the
 * handler boundary BEFORE this template is rendered. The IAM policy doc
 * for `task_ecs_write` (ender-stack PR #208) explicitly cites this regex
 * as a load-bearing security control: ecs:RegisterTaskDefinition is
 * granted Resource:"*" because the AWS verb has no resource-level auth,
 * so the only thing keeping a compromised MC from registering arbitrary
 * task-def families is THIS regex. Treat it accordingly.
 */
export interface OpenClawAgentInput {
  /** Unique identifier (`^[a-z0-9-]{3,32}$`). Becomes the suffix on every per-agent ARN. */
  agentName: string
  /** Operator-facing role description, surfaced in MC's agent detail panel. */
  roleDescription: string
  /** Container image (full ECR or GHCR URI with digest or tag). */
  image: string
  /** Model tier passed to the agent runtime as `OPENCLAW_MODEL`. */
  modelTier: 'opus-4-7' | 'sonnet-4-6' | 'haiku-4-5'
  /** Optional Slack webhook URL for the per-agent channel. Stored unmasked in env. */
  slackWebhookUrl?: string
}

/**
 * Environment / cluster context resolved by the handler from
 * MC_FLEET_* env vars before calling the template. Decoupling these
 * from the template lets unit tests render with stable fixture values.
 */
export interface OpenClawAgentEnv {
  /** AWS account ID (e.g., '398152419239'). Used for ARN construction. */
  accountId: string
  /** AWS region (e.g., 'us-east-1'). */
  region: string
  /** `{project}-{environment}` (e.g., 'ender-stack-dev'). Drives every per-agent name. */
  prefix: string
  /** ECS cluster name; equal to prefix in the current Terraform composition. */
  clusterName: string
  /** ARN of the shared OpenClaw task role MC-managed agents share. */
  taskRoleArn: string
  /** ARN of the shared OpenClaw exec role. */
  executionRoleArn: string
  /** CloudWatch log group prefix (e.g., '/ecs/ender-stack-dev'). The handler
   *  must create the log group at `${logGroupPrefix}/companion-openclaw-${agentName}`
   *  before CreateService — agent boot will tail-fail otherwise. */
  logGroupPrefix: string
  /** VPC ID for the per-agent target group. */
  vpcId: string
  /** Private app subnet IDs the ECS service will run in. Comma-joined string at runtime. */
  subnetIds: string[]
  /** ECS-services security group ID (already permits ALB→agent traffic). */
  securityGroupId: string
  /** LiteLLM ALB DNS — passed to the agent as `LITELLM_API_BASE`. */
  litellmAlbDnsName: string
  /** Mandatory tags to merge into every created resource (`Project`, `Environment`, `Owner`, `ManagedBy`). */
  tags: Record<string, string>
}

const CONTAINER_PORT = 18789
const HEALTHCHECK_PATH = '/healthz'

/** Resource name = task-def family = ECS service name = TG name suffix. */
function resourceName(prefix: string, agentName: string): string {
  return `${prefix}-companion-openclaw-${agentName}`
}

/** Convert the `Record<string, string>` tag input into the ECS / ELBv2 list format. */
function tagsToEcs(
  tags: Record<string, string>,
): { key: string; value: string }[] {
  return Object.entries(tags).map(([key, value]) => ({ key, value }))
}
function tagsToElbv2(
  tags: Record<string, string>,
): { Key: string; Value: string }[] {
  return Object.entries(tags).map(([Key, Value]) => ({ Key, Value }))
}

/**
 * Renders RegisterTaskDefinition input. The task-def family resolves to
 * `{prefix}-companion-openclaw-{agentName}` and matches the IAM
 * authorization patterns (`task-definition/{prefix}-companion-*:*`).
 */
export function renderTaskDefinition(
  input: OpenClawAgentInput,
  env: OpenClawAgentEnv,
): RegisterTaskDefinitionCommandInput {
  const name = resourceName(env.prefix, input.agentName)
  const logGroup = `${env.logGroupPrefix}/companion-openclaw-${input.agentName}`

  return {
    family: name,
    networkMode: 'awsvpc',
    requiresCompatibilities: ['FARGATE'],
    cpu: '512',
    memory: '1024',
    taskRoleArn: env.taskRoleArn,
    executionRoleArn: env.executionRoleArn,
    containerDefinitions: [
      {
        name: 'gateway',
        image: input.image,
        essential: true,
        portMappings: [
          {
            containerPort: CONTAINER_PORT,
            protocol: 'tcp',
          },
        ],
        environment: [
          { name: 'OPENCLAW_AGENT_NAME', value: input.agentName },
          { name: 'OPENCLAW_ROLE_DESCRIPTION', value: input.roleDescription },
          { name: 'OPENCLAW_MODEL', value: input.modelTier },
          { name: 'LITELLM_API_BASE', value: `http://${env.litellmAlbDnsName}` },
          ...(input.slackWebhookUrl
            ? [{ name: 'SLACK_WEBHOOK_URL', value: input.slackWebhookUrl }]
            : []),
        ],
        healthCheck: {
          command: [
            'CMD-SHELL',
            `wget --quiet --tries=1 --spider http://localhost:${CONTAINER_PORT}${HEALTHCHECK_PATH} || exit 1`,
          ],
          interval: 30,
          timeout: 5,
          retries: 3,
          startPeriod: 20,
        },
        logConfiguration: {
          logDriver: 'awslogs',
          options: {
            'awslogs-group': logGroup,
            'awslogs-region': env.region,
            'awslogs-stream-prefix': 'gateway',
          },
        },
      },
    ],
    tags: tagsToEcs({
      ...env.tags,
      Name: name,
      Component: 'agent-harness',
      Harness: 'companion/openclaw',
      AgentName: input.agentName,
    }),
  }
}

/**
 * Renders CreateTargetGroup input. Name pattern `{prefix}-agent-{agentName}`
 * matches the IAM grant for ELBv2MutateAgentTargetGroups
 * (targetgroup ARN pattern under `{prefix}-agent-` with a wildcard tail).
 *
 * Note the `agent` (singular) vs `agents` (plural) asymmetry — TGs are
 * per-agent, the listener is the shared resource. Same convention as
 * ender-stack/terraform/modules/agents-shared-alb/main.tf.
 */
export function renderTargetGroup(
  input: OpenClawAgentInput,
  env: OpenClawAgentEnv,
): CreateTargetGroupCommandInput {
  return {
    Name: `${env.prefix}-agent-${input.agentName}`,
    Port: CONTAINER_PORT,
    Protocol: 'HTTP',
    VpcId: env.vpcId,
    TargetType: 'ip',
    HealthCheckPath: HEALTHCHECK_PATH,
    HealthCheckProtocol: 'HTTP',
    HealthCheckPort: 'traffic-port',
    HealthyThresholdCount: 2,
    UnhealthyThresholdCount: 3,
    HealthCheckTimeoutSeconds: 5,
    HealthCheckIntervalSeconds: 30,
    Matcher: { HttpCode: '200' },
    Tags: tagsToElbv2({
      ...env.tags,
      Name: `${env.prefix}-agent-${input.agentName}-tg`,
      Component: 'agent-harness',
      Harness: 'companion/openclaw',
      AgentName: input.agentName,
    }),
  }
}

/**
 * Renders CreateService input. Service name `{prefix}-companion-openclaw-{agentName}`
 * matches the IAM grant for ECSCreateAndDeleteAgentServices
 * (`service/{cluster}/{prefix}-companion-*`).
 *
 * `taskDefinition` is supplied separately by the handler — the registered
 * task-def revision ARN is only known after RegisterTaskDefinition returns.
 * The `loadBalancers[].targetGroupArn` is similarly handler-supplied
 * post-CreateTargetGroup.
 */
export function renderService(
  input: OpenClawAgentInput,
  env: OpenClawAgentEnv,
  resolved: { taskDefinitionArn: string; targetGroupArn: string },
): CreateServiceCommandInput {
  const name = resourceName(env.prefix, input.agentName)

  return {
    cluster: env.clusterName,
    serviceName: name,
    taskDefinition: resolved.taskDefinitionArn,
    desiredCount: 1,
    launchType: 'FARGATE',
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: env.subnetIds,
        securityGroups: [env.securityGroupId],
        assignPublicIp: 'DISABLED',
      },
    },
    loadBalancers: [
      {
        targetGroupArn: resolved.targetGroupArn,
        containerName: 'gateway',
        containerPort: CONTAINER_PORT,
      },
    ],
    healthCheckGracePeriodSeconds: 60,
    tags: tagsToEcs({
      ...env.tags,
      Name: name,
      Component: 'agent-harness',
      Harness: 'companion/openclaw',
      AgentName: input.agentName,
    }),
    enableExecuteCommand: false,
  }
}

/**
 * Build the listener-rule input for the shared agents ALB. Path-based
 * routing — `/agent/{agentName}*` forwards to the per-agent target group.
 *
 * Priority is computed by the handler from a hash of the agent name (or
 * an in-handler counter); the AWS API requires unique priorities per
 * listener but doesn't care about ordering for distinct path patterns.
 */
export interface AgentListenerRuleSpec {
  pathPattern: string
  targetGroupArn: string
  priority: number
  tags: { Key: string; Value: string }[]
}

export function renderListenerRule(
  input: OpenClawAgentInput,
  env: OpenClawAgentEnv,
  resolved: { targetGroupArn: string; priority: number },
): AgentListenerRuleSpec {
  return {
    pathPattern: `/agent/${input.agentName}*`,
    targetGroupArn: resolved.targetGroupArn,
    priority: resolved.priority,
    tags: tagsToElbv2({
      ...env.tags,
      Name: `${env.prefix}-agent-${input.agentName}-rule`,
      Component: 'agent-harness',
      Harness: 'companion/openclaw',
      AgentName: input.agentName,
    }),
  }
}
