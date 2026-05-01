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
 * Two-container task shape (init-config + gateway, dependsOn-gated)
 * with three ephemeral Fargate volumes (config, workspace, plugin-deps).
 * Resolves ender-stack#215. Mirrors the smoke-test pattern at
 * ender-stack/terraform/modules/companion/openclaw/main.tf except for
 * the storage backing — smoke-test uses EFS, MC-created agents use
 * Fargate ephemeral. The all-ephemeral choice fits the platform's
 * external-state architecture (durable state lives in Mem0/KB/S3,
 * not local disk); see research/openclaw-storage-convergence.md
 * (filed alongside this PR's ender-stack-side companion if any).
 *
 * Phase-1 boot mode: gateway runs with `--allow-unconfigured`
 * (baked into the image's entrypoint.sh). The init-config sidecar
 * pre-creates `OPENCLAW_STATE_DIR` and its known-required subdirs
 * (plugin-runtime-deps, agents, canvas) so OpenClaw's non-recursive
 * mkdir at startup doesn't ENOENT against an empty mount. No
 * openclaw.json is written today — schema-aware templating is its
 * own multi-day investigation deferred to a Phase-2.x follow-up.
 *
 * Per-agent extensions, persona configs, and channel-token binding
 * land in Phase 2.4 (#247) — Slack app manifest + per-agent
 * credential paste-back flow.
 */

/**
 * Validated form input for an OpenClaw create-agent request.
 *
 * agentName regex `AGENT_NAME_RE` (constraints.ts —
 * `^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$`) is enforced server-side at the
 * handler boundary BEFORE this template is rendered. The IAM policy doc
 * for `task_ecs_write` (ender-stack PR #208) explicitly cites this regex
 * as a load-bearing security control: ecs:RegisterTaskDefinition is
 * granted Resource:"*" because the AWS verb has no resource-level auth,
 * so the only thing keeping a compromised MC from registering arbitrary
 * task-def families is THIS regex. Treat it accordingly.
 */
export interface OpenClawAgentInput {
  /** Unique identifier (`AGENT_NAME_RE` from constraints.ts). Becomes the suffix on every per-agent ARN. */
  agentName: string
  /** Operator-facing role description, surfaced in MC's agent detail panel. */
  roleDescription: string
  /** Container image (full ECR or GHCR URI with digest or tag). */
  image: string
  // Note: modelTier (and the OPENCLAW_MODEL env var) was removed in
  // Beat 3b.1. LiteLLM's smart-router is the authoritative model-
  // selection layer — the agent calls LITELLM_API_BASE and the router
  // picks the optimal model per request. A pinned model tier on the
  // agent task-def would either be ignored (smart-router still routes)
  // or actively conflict (agent forces a model that smart-router
  // would have routed elsewhere for cost/latency). Either way, dead
  // surface. If a future use case needs per-agent model HINTS, add a
  // structured preference field rather than a single tier — the
  // present "tier" framing was already at the wrong abstraction
  // level vs. how the routing layer thinks about model selection.
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
/**
 * Mount path constants — used by both the init-config and gateway
 * containers. These match the upstream OpenClaw image's expected
 * layout (verified against the smoke-test task-def in
 * ender-stack/terraform/modules/companion/openclaw/main.tf): config
 * lives at `/home/node/.openclaw`, the workspace mount nests inside
 * it at `/home/node/.openclaw/workspace`, and plugin staging is a
 * dedicated mount under the workspace tree to isolate it from any
 * future workspace-storage-backing changes (smoke-test originally
 * hit stale-lock crashes when plugin staging shared an EFS volume
 * with workspace state — see ender-stack#207).
 *
 * STATE_DIR and PLUGIN_DEPS_MOUNT_PATH are derived from
 * WORKSPACE_MOUNT_PATH rather than re-declared as independent
 * literals — round-1 audit on PR #40 caught the drift risk if
 * someone changed one without the others (image layout change,
 * Terraform refactor, etc.). Single edit point per path component.
 */
const CONFIG_MOUNT_PATH = '/home/node/.openclaw'
const WORKSPACE_MOUNT_PATH = `${CONFIG_MOUNT_PATH}/workspace`
const STATE_DIR = `${WORKSPACE_MOUNT_PATH}/.openclaw`
const PLUGIN_DEPS_MOUNT_PATH = `${STATE_DIR}/plugin-runtime-deps`

/**
 * Path to the init-config script baked into the companion-openclaw
 * image at build time (see
 * ender-stack/services/companion/openclaw/Dockerfile). The image
 * COPY step pins this location; if the image build ever moves the
 * script, this template will need to update or init-config will
 * fail with ENOENT on entryPoint and gateway's `dependsOn: SUCCESS`
 * will never satisfy. A smoke-test assertion in the image's CI
 * (verifies the file exists at the expected path) is the right
 * long-term contract; until then, this constant + the comment is
 * the operational coupling. Round-1 audit on PR #40.
 */
const INIT_CONFIG_SCRIPT_PATH = '/usr/local/bin/init-config.sh'

export function renderTaskDefinition(
  input: OpenClawAgentInput,
  env: OpenClawAgentEnv,
): RegisterTaskDefinitionCommandInput {
  const name = resourceName(env.prefix, input.agentName)
  const logGroup = `${env.logGroupPrefix}/companion-openclaw-${input.agentName}`

  // Two env blocks: vars common to both containers, and gateway-only
  // additions. Round-1 audit on PR #40 caught that the prior shared
  // block placed OPENCLAW_ROLE_DESCRIPTION + LITELLM_API_BASE on
  // init-config too — same task-def-level blast radius (anyone with
  // ecs:DescribeTaskDefinition reads the whole revision regardless),
  // but a confusing surface for future maintainers since init-config.sh
  // doesn't read either. Splitting makes "what each container actually
  // needs" legible from the template.
  //
  // commonEnv: read by both containers' processes.
  //   - OPENCLAW_AGENT_NAME / AGENT_NAME — agent identity (init-config.sh
  //     reads AGENT_NAME today; OPENCLAW_AGENT_NAME kept for the
  //     namespaced form and gateway-runtime use).
  //   - OPENCLAW_STATE_DIR — load-bearing on both: init-config uses it
  //     to know where to mkdir state subdirs; gateway uses it so
  //     OpenClaw's mutable-state writes land on the RW workspace mount.
  const commonEnv = [
    { name: 'OPENCLAW_AGENT_NAME', value: input.agentName },
    { name: 'AGENT_NAME', value: input.agentName },
    { name: 'OPENCLAW_STATE_DIR', value: STATE_DIR },
  ]

  // gatewayOnlyEnv: vars the runtime gateway process consumes.
  //
  // OPENCLAW_ROLE_DESCRIPTION becomes part of the agent's runtime
  // role prompt. Admin-supplied free text written into a task-def
  // revision (AWS retains revisions indefinitely; anyone with
  // ecs:DescribeTaskDefinition can read). Treat as a permanent
  // prompt-injection surface: a crafted description survives
  // container restarts and survives the agent itself. Mitigations:
  // endpoint is admin-only; ROLE_DESCRIPTION_MAX_BYTES caps blast
  // radius; Beat 3b form surfaces operator guidance at submit time.
  // Multi-operator approval is a Phase 2.x hardening follow-up.
  //
  // http:// on LITELLM_API_BASE is intentional — internal-only ALB
  // (private subnets, internal=true, no ACM cert). Don't "fix" to
  // https without coordinating ACM Private CA provisioning.
  const gatewayOnlyEnv = [
    { name: 'OPENCLAW_ROLE_DESCRIPTION', value: input.roleDescription },
    { name: 'LITELLM_API_BASE', value: `http://${env.litellmAlbDnsName}` },
  ]

  const logConfig = (streamPrefix: string) => ({
    logDriver: 'awslogs' as const,
    options: {
      'awslogs-group': logGroup,
      'awslogs-region': env.region,
      'awslogs-stream-prefix': streamPrefix,
    },
  })

  return {
    family: name,
    networkMode: 'awsvpc',
    requiresCompatibilities: ['FARGATE'],
    cpu: '512',
    memory: '1024',
    taskRoleArn: env.taskRoleArn,
    executionRoleArn: env.executionRoleArn,
    // Three ephemeral Fargate volumes. No `efsVolumeConfiguration` ⇒
    // emptyDir-like overlay backed by Fargate's 21 GiB ephemeral
    // storage. Resets every task launch — config is rebuilt by the
    // init-config sidecar each boot, workspace state is intentionally
    // ephemeral (durable state lives in Mem0/KB/S3 per platform-
    // decisions, not local disk). plugin-deps is its own volume
    // (NOT nested under workspace) to mirror the smoke-test pattern:
    // a future workspace-EFS switch shouldn't drag plugin staging
    // onto EFS.
    volumes: [{ name: 'config' }, { name: 'workspace' }, { name: 'plugin-deps' }],
    containerDefinitions: [
      // init-config sidecar — runs the same image but overrides
      // entryPoint to invoke the bundled init-config.sh. The script:
      //  - removes any stale openclaw.json at the config mount root
      //    (Phase-1 boots --allow-unconfigured per the image's
      //    entrypoint.sh)
      //  - pre-creates OPENCLAW_STATE_DIR + state subdirs
      //    (plugin-runtime-deps, agents, canvas) so OpenClaw's
      //    non-recursive mkdir at startup doesn't ENOENT against an
      //    empty workspace mount
      // Gateway's `dependsOn` ensures it doesn't start until init-
      // config exits 0; failure here aborts the task launch cleanly.
      {
        name: 'init-config',
        image: input.image,
        essential: false,
        entryPoint: [INIT_CONFIG_SCRIPT_PATH],
        // Empty command so any image CMD is fully overridden — the
        // smoke-test pattern. Without this, a future image change
        // that adds a CMD (e.g. extra flags) would silently get
        // appended to init-config.sh and possibly break it.
        command: [],
        environment: commonEnv,
        // Note on plugin-runtime-deps: init-config.sh creates this
        // dir under STATE_DIR, but it lands on the workspace volume
        // here. The gateway then mounts a SEPARATE plugin-deps
        // volume at the same path, overlaying (and shadowing) the
        // workspace-side dir. The mkdir is therefore a no-op for
        // gateway runtime — it's the plugin-deps volume mount that
        // actually provides the empty directory OpenClaw expects.
        // If plugin-deps is ever removed as a separate volume,
        // workspace state would unexpectedly contain the init-
        // config-created dir. Round-1 audit on PR #40 flagged this
        // for documentation; behavior is correct, just non-obvious.
        mountPoints: [
          {
            sourceVolume: 'config',
            containerPath: CONFIG_MOUNT_PATH,
            readOnly: false,
          },
          {
            sourceVolume: 'workspace',
            containerPath: WORKSPACE_MOUNT_PATH,
            readOnly: false,
          },
        ],
        logConfiguration: logConfig('init-config'),
      },
      {
        name: 'gateway',
        image: input.image,
        essential: true,
        // Gateway waits for init-config to SUCCESS — task launch
        // fails fast if init-config can't prep the mounts.
        dependsOn: [{ containerName: 'init-config', condition: 'SUCCESS' }],
        portMappings: [
          {
            containerPort: CONTAINER_PORT,
            protocol: 'tcp',
          },
        ],
        environment: [...commonEnv, ...gatewayOnlyEnv],
        mountPoints: [
          // config mounts read-only — gateway reads openclaw.json
          // (or boots --allow-unconfigured if absent) from this path.
          {
            sourceVolume: 'config',
            containerPath: CONFIG_MOUNT_PATH,
            readOnly: true,
          },
          // workspace mounts RW — OpenClaw writes mutable state
          // (canvas, agents, etc) here. Nested under config's path;
          // ECS overlay handles the nesting correctly. Per-task
          // ephemeral — resets on task restart, durable state lives
          // externally (Mem0/KB/S3).
          {
            sourceVolume: 'workspace',
            containerPath: WORKSPACE_MOUNT_PATH,
            readOnly: false,
          },
          // plugin-deps at the upstream-expected plugin staging
          // path. Separate volume so a future workspace backing
          // change (ephemeral → EFS) doesn't drag plugin staging
          // with it (smoke-test originally hit stale-lock crashes
          // when plugin staging shared EFS with workspace state).
          {
            sourceVolume: 'plugin-deps',
            containerPath: PLUGIN_DEPS_MOUNT_PATH,
            readOnly: false,
          },
        ],
        healthCheck: {
          command: [
            'CMD-SHELL',
            `wget --quiet --tries=1 --spider http://localhost:${CONTAINER_PORT}${HEALTHCHECK_PATH} || exit 1`,
          ],
          interval: 30,
          timeout: 5,
          retries: 3,
          // Bumped from 20 → 180s (#215). Init-config script (~5s) +
          // gateway cold-start (~30-60s) + plugin staging (~30-90s
          // on a cold mount) adds materially on top of the bare
          // gateway-only boot the prior 20s targeted. 180s gives
          // margin without making real failures take 3+ minutes to
          // surface as unhealthy.
          startPeriod: 180,
        },
        logConfiguration: logConfig('gateway'),
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
 * AWS hard limit on `aws_lb_target_group.name`. Reaching past this
 * triggers a 400 ValidationError from `CreateTargetGroup` AFTER
 * task-def + log-group have been created — orphaning real billed
 * resources. Validate combined-name length BEFORE the AWS fan-out
 * to fail fast with a clear message.
 */
export const TARGET_GROUP_NAME_MAX_LENGTH = 32

/**
 * Computes the OpenClaw target-group name for a given prefix + agent
 * name. Single source of truth — used by both renderTargetGroup
 * (which produces the actual CreateTargetGroup input) and by the
 * handler-side length-cap pre-check + by the harness-defaults
 * endpoint to compute the per-deployment max agent name length.
 */
export function targetGroupName(prefix: string, agentName: string): string {
  return `${prefix}-agent-${agentName}`
}

/**
 * Returns the maximum legal `agentName` length for a given deployment
 * prefix, accounting for the `{prefix}-agent-` overhead and the AWS
 * 32-char target-group-name limit. Negative or zero result indicates
 * the prefix itself is too long for any usable agent name (the
 * caller should surface a deployment-config error rather than try
 * to validate user input against an impossible limit).
 *
 * For the canonical `ender-stack-dev` prefix: `32 - 22 = 10` chars
 * available for the agent name segment.
 */
export function maxAgentNameLengthForPrefix(prefix: string): number {
  // `{prefix}-agent-` overhead = prefix.length + 1 (dash) + 5 ('agent') + 1 (dash) = prefix.length + 7
  return TARGET_GROUP_NAME_MAX_LENGTH - prefix.length - '-agent-'.length
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
    Name: targetGroupName(env.prefix, input.agentName),
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
    // Service-level grace ≥ task-level startPeriod. Task healthCheck
    // startPeriod is 180s (#215) to cover init-config + gateway cold
    // start + plugin staging. ECS would mark tasks unhealthy and
    // start replacing them at the service-level boundary, so the
    // service grace must be ≥ the task health-check start window or
    // the rollout enters a kill-loop before the task ever has a
    // chance to come up. 300s gives 120s margin over the task start
    // period for the first /healthz pass after the start window
    // expires.
    healthCheckGracePeriodSeconds: 300,
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
 * agentName regex `AGENT_NAME_RE` (constraints.ts —
 * `^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$`) permits hyphenated names that
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
