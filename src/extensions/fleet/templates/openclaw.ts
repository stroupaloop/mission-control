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
 * KNOWN GAP — runtime config wiring:
 *   This template emits a single-container (gateway-only) task. The
 *   canonical Terraform-bootstrapped openclaw module
 *   (ender-stack/terraform/modules/companion/openclaw/main.tf) ships a
 *   TWO-container task with an init-config sidecar that templates
 *   `openclaw.json` onto an EFS access point before the gateway
 *   starts; the gateway mounts that EFS read-only and reads its
 *   config from disk.
 *
 *   MC-deployed agents created via this template do NOT get that
 *   wiring. The endpoint creates the ECS service successfully, but
 *   the gateway task will fail to start cleanly until one of the
 *   following lands as a follow-up:
 *
 *     (a) OpenClaw runtime gains env-var-only config mode (no EFS
 *         dependency). Requires an upstream change to OpenClaw.
 *     (b) MC handler wires EFS volumes + an init-config container
 *         when rendering the task-def. Requires either a pool of
 *         pre-provisioned EFS access points OR an `efs:CreateAccessPoint`
 *         IAM grant on MC's task role.
 *
 *   Tracked as ender-stack#215. The endpoint is shipping in Beat 3a
 *   so the API surface, IAM permissions, ALB integration, and
 *   tagging conventions can be exercised + reviewed without blocking
 *   on the runtime resolution. The first /fleet/new dev validation
 *   will fail health checks until #215 closes.
 *
 * Per-agent extensions, persona configs, and channel-token binding
 * are out of scope for Phase 2.2 (deferred to Phase 2.3).
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
  // Note: slackWebhookUrl removed in this template version. A Slack
  // webhook is a bearer token; storing it as a plaintext env var on a
  // task-def revision means anyone with `ecs:DescribeTaskDefinition`
  // (CI, monitoring, dev roles) can read it, and revisions are
  // immutable + retained indefinitely. Slack provisioning lands with
  // Phase 2.5's secrets-manager-aware Slack-app-factory work
  // (memory: project_phase2_platform_decisions.md). For Phase 2.2
  // operator-driven deploys, attach the Slack webhook via task-def
  // edit + Secrets Manager binding after the agent is running.
}

/**
 * Environment / cluster context resolved by the handler from
 * MC_FLEET_* env vars before calling the template. Decoupling these
 * from the template lets unit tests render with stable fixture values.
 */
export interface OpenClawAgentEnv {
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
          // OPENCLAW_ROLE_DESCRIPTION becomes part of the agent's runtime
          // role prompt. It is admin-supplied free text written into a
          // task-def revision, which AWS retains indefinitely and
          // anyone with `ecs:DescribeTaskDefinition` can read. Treat
          // this as a permanent prompt-injection surface: a crafted
          // description survives container restarts AND survives the
          // agent itself (deregistered task-def revisions still serve
          // describe calls until deleted out-of-band). The
          // ROLE_DESCRIPTION_MAX_BYTES cap in templates/index.ts is
          // the only Phase-2.2 mitigation; tighter content review +
          // a secondary approval step are tracked for the Beat 3b UI.
          { name: 'OPENCLAW_ROLE_DESCRIPTION', value: input.roleDescription },
          { name: 'OPENCLAW_MODEL', value: input.modelTier },
          // http:// is intentional — the LiteLLM ALB is internal-only
          // (private subnets, internal=true) with no ACM cert. Same
          // disposition as every other VPC-internal service in the
          // platform. Don't "fix" this to https:// without coordinating
          // with ACM Private CA provisioning.
          { name: 'LITELLM_API_BASE', value: `http://${env.litellmAlbDnsName}` },
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
 * routing — two explicit patterns forward to the per-agent target group:
 *   - `/agent/{agentName}`        — exact-name root
 *   - `/agent/{agentName}/*`      — any subpath under the agent
 *
 * The two-pattern shape is load-bearing for prefix-pair agent names.
 * A single `/agent/{name}*` glob would also match a different agent
 * whose name starts with `{name}` (e.g., `bot` + `bot-test` → a
 * request to `/agent/bot-test/api` matches BOTH `/agent/bot*` and
 * `/agent/bot-test*`, and AWS resolves by priority, not specificity —
 * so `bot-test` traffic could silently land on `bot`'s target group).
 * Anchoring with `/{name}` (exact) and `/{name}/*` (subtree) makes the
 * patterns mutually exclusive across distinct agent names. The
 * agentName regex `^[a-z0-9-]{3,32}$` permits hyphenated names that
 * would trigger this overlap, so the anchoring is required.
 *
 * Priority is computed by the handler from a hash of the agent name;
 * AWS requires unique priorities per listener (collisions are
 * tracked as ender-stack#214).
 */
export interface AgentListenerRuleSpec {
  pathPatterns: string[]
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
    pathPatterns: [
      `/agent/${input.agentName}`,
      `/agent/${input.agentName}/*`,
    ],
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
