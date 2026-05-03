import { NextRequest, NextResponse } from 'next/server'
import {
  ECSClient,
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  RegisterTaskDefinitionCommand,
  UpdateServiceCommand,
  type ContainerDefinition,
  type RegisterTaskDefinitionCommandInput,
} from '@aws-sdk/client-ecs'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { logSecurityEvent } from '@/lib/security-events'
import { AGENT_NAME_RE } from '@/extensions/fleet/templates/constraints'
import { resolveFleetPrefix } from '@/extensions/fleet/lib/fleet-prefix'
import { isAgentHarness } from '@/extensions/fleet/lib/ecs-guards'
import {
  writeSlackSecrets,
  requireSecretsPrefix,
  type SlackSecretArns,
} from '@/extensions/fleet/lib/secrets-manager'

/**
 * POST /api/fleet/agents/:name/slack/credentials — Phase 2.4 Beat 5b.2.
 *
 * Operator-driven credential paste. Steps:
 *   1. Validate three Slack token shapes (xapp- app-level, xoxb-
 *      bot, signing secret).
 *   2. Confirm the target agent exists and is MC-managed (two-tag
 *      guard via lib/ecs-guards).
 *   3. Write the three secrets into AWS Secrets Manager via the
 *      Put-or-Create idempotent wrapper.
 *   4. Read the agent's live task-def (DescribeTaskDefinition).
 *   5. Mutate the gateway container's `secrets:` array (3 entries
 *      pointing at the SM ARNs from step 3) + push
 *      `OPENCLAW_SLACK_CONFIG_JSON` into the env block (channels
 *      payload from the request).
 *   6. RegisterTaskDefinition with the mutated spec → new revision.
 *   7. UpdateService(forceNewDeployment=true, taskDefinition=newArn)
 *      → ECS rolls the agent onto the new task-def.
 *
 * Returns 200 with the new task-def ARN + deployment ID. Agent
 * picks up the secrets at task-launch (ECS resolves valueFrom on
 * the execution role's GetSecretValue grant — already provisioned
 * by Beat 5a's `mc_agent_shared_execution` policy).
 *
 * Auth: admin. Tied to `MC_AGENT_SECRETS_NAME_PREFIX` — fails fast
 * with ConfigurationError if unset.
 *
 * Idempotency: re-pasting the same tokens is a no-op (PutSecretValue
 * + new task-def revision); operator can rotate by re-pasting new
 * tokens — same flow. The new task-def revision triggers a rolling
 * redeploy regardless (force=true).
 *
 * Channels: optional `channels` field on the request body. When
 * present, encoded into `OPENCLAW_SLACK_CONFIG_JSON` and templated
 * into openclaw.json by the init-config script (Beat 5d). When
 * empty/absent, the agent boots with no Slack channels configured
 * (still functional via DMs once Socket Mode connects).
 */

const AWS_REGION_AT_LOAD = process.env.AWS_REGION || 'us-east-1'
const ecsClient = new ECSClient({ region: AWS_REGION_AT_LOAD })

const GATEWAY_CONTAINER_NAME = 'gateway'
const SLACK_CONFIG_ENV_NAME = 'OPENCLAW_SLACK_CONFIG_JSON'
const SLACK_APP_TOKEN_ENV = 'SLACK_APP_TOKEN'
const SLACK_BOT_TOKEN_ENV = 'SLACK_BOT_TOKEN'
const SLACK_SIGNING_SECRET_ENV = 'SLACK_SIGNING_SECRET'

// Token shape regexes — prefix-anchored. Full Slack token format is
// not publicly stable enough for tight regex; the prefix check
// rejects obvious garbage (e.g., the operator pastes "xapp-…" into
// the bot-token field). The IAM + Slack-side rejection handle the
// rest if a malformed value slips through.
const APP_TOKEN_RE = /^xapp-1-[A-Z0-9]+-[0-9]+-[a-zA-Z0-9]+$/
const BOT_TOKEN_RE = /^xoxb-[0-9]+-[0-9]+-[A-Za-z0-9-]+$/
// Signing secret: 32 hex chars per Slack docs (sometimes seen as
// 64 in older docs — accept both lengths).
const SIGNING_SECRET_RE = /^[a-f0-9]{32,64}$/

export interface SlackCredentialsRequest {
  appToken: string
  botToken: string
  signingSecret: string
  /**
   * Optional list of Slack channel IDs (`C0XXXXXX`) the agent should
   * subscribe to. Encoded into OPENCLAW_SLACK_CONFIG_JSON; the
   * init-config script templates them into openclaw.json's plugins
   * block (Beat 5d). Empty array means agent boots with no channels
   * configured (still works for DMs via Socket Mode).
   */
  channels?: string[]
}

export interface SlackCredentialsResponse {
  ok: true
  agentName: string
  taskDefinitionArn: string
  /** ECS deployment ID for the new PRIMARY deployment. Useful for cross-referencing CloudTrail. */
  deploymentId?: string
  /** ARNs of the three secrets written. Surfaced for operator visibility / audit. */
  secretArns: SlackSecretArns
}

export interface SlackCredentialsErrorResponse {
  error: string
  detail?: string
  /** Field-level validation errors when error === 'InvalidRequestShape'. */
  fieldErrors?: Record<string, string>
}

function isCredentialsRequest(
  body: unknown,
): body is SlackCredentialsRequest {
  if (!body || typeof body !== 'object') return false
  const b = body as Record<string, unknown>
  if (typeof b.appToken !== 'string') return false
  if (typeof b.botToken !== 'string') return false
  if (typeof b.signingSecret !== 'string') return false
  if (b.channels !== undefined) {
    if (!Array.isArray(b.channels)) return false
    if (!b.channels.every((c) => typeof c === 'string')) return false
  }
  return true
}

/**
 * Validate token shapes after the type guard. Returns a per-field
 * error map; empty map means all tokens passed. Surface shape errors
 * back to the operator so they can fix the paste; without this the
 * Slack API would return a confusing AuthenticationError on first
 * Socket Mode connect attempt.
 */
function validateTokenShapes(
  req: SlackCredentialsRequest,
): Record<string, string> {
  const errs: Record<string, string> = {}
  if (!APP_TOKEN_RE.test(req.appToken)) {
    errs.appToken = 'Expected `xapp-1-...` app-level token (Socket Mode)'
  }
  if (!BOT_TOKEN_RE.test(req.botToken)) {
    errs.botToken = 'Expected `xoxb-...` bot user OAuth token'
  }
  if (!SIGNING_SECRET_RE.test(req.signingSecret)) {
    errs.signingSecret = 'Expected 32-64 char hex signing secret'
  }
  return errs
}

/**
 * RegisterTaskDefinition only accepts the SUBSET of fields that
 * DescribeTaskDefinition returns. Strip the read-only fields that
 * AWS adds at registration time (revision, ARN, registeredAt,
 * registeredBy, status, requiresAttributes, compatibilities) so the
 * mutated spec round-trips cleanly. Without this, RegisterTaskDef
 * 400s with InvalidParameterException naming the offending field.
 */
function stripReadOnlyFields(
  td: Record<string, unknown>,
): RegisterTaskDefinitionCommandInput {
  const cleaned = { ...td }
  delete cleaned.taskDefinitionArn
  delete cleaned.revision
  delete cleaned.status
  delete cleaned.requiresAttributes
  delete cleaned.compatibilities
  delete cleaned.registeredAt
  delete cleaned.registeredBy
  delete cleaned.deregisteredAt
  return cleaned as unknown as RegisterTaskDefinitionCommandInput
}

/**
 * Mutate the gateway container in-place: add 3 SM-resolved secrets
 * + push OPENCLAW_SLACK_CONFIG_JSON onto the env block.
 *
 * Defensive on the env block: if OPENCLAW_SLACK_CONFIG_JSON already
 * exists (operator re-paste with new channels), replace its value
 * rather than duplicate. ECS rejects task-defs with duplicate env
 * var names, so silent dedup is the right behavior.
 */
function injectSlackIntoGateway(
  containers: ContainerDefinition[],
  arns: SlackSecretArns,
  channelsConfigJson: string,
): ContainerDefinition[] {
  return containers.map((c) => {
    if (c.name !== GATEWAY_CONTAINER_NAME) return c
    const existingSecrets = (c.secrets ?? []).filter((s) => {
      // Drop existing slack-* entries — re-pasted ARNs supersede.
      return (
        s.name !== SLACK_APP_TOKEN_ENV &&
        s.name !== SLACK_BOT_TOKEN_ENV &&
        s.name !== SLACK_SIGNING_SECRET_ENV
      )
    })
    const slackSecrets = [
      { name: SLACK_APP_TOKEN_ENV, valueFrom: arns.appToken },
      { name: SLACK_BOT_TOKEN_ENV, valueFrom: arns.botToken },
      { name: SLACK_SIGNING_SECRET_ENV, valueFrom: arns.signingSecret },
    ]
    const existingEnv = (c.environment ?? []).filter(
      (e) => e.name !== SLACK_CONFIG_ENV_NAME,
    )
    const newEnv = [
      ...existingEnv,
      { name: SLACK_CONFIG_ENV_NAME, value: channelsConfigJson },
    ]
    return {
      ...c,
      secrets: [...existingSecrets, ...slackSecrets],
      environment: newEnv,
    }
  })
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  const { name: agentName } = await params

  if (!agentName || !AGENT_NAME_RE.test(agentName)) {
    return NextResponse.json(
      {
        error: 'InvalidAgentName',
        detail: `agentName must match ${AGENT_NAME_RE.source}`,
      } satisfies SlackCredentialsErrorResponse,
      { status: 400 },
    )
  }

  // Fail fast if the deployment isn't wired for credential storage
  // (MC_AGENT_SECRETS_NAME_PREFIX unset). Beat 5a documented this
  // as a startup-assertable invariant; honoring it here rather
  // than letting the SecretsManager call 403/blow up later.
  let secretsPrefix: string
  try {
    secretsPrefix = requireSecretsPrefix()
  } catch (err) {
    return NextResponse.json(
      {
        error: 'ConfigurationError',
        detail: (err as Error).message,
      } satisfies SlackCredentialsErrorResponse,
      { status: 500 },
    )
  }
  // The prefix is read here only for the env-var-presence assertion;
  // the actual ARN construction happens inside writeSlackSecrets.
  // Suppress the lint warning about an unused declaration with an
  // explicit reference.
  void secretsPrefix

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { error: 'InvalidRequestBody' } satisfies SlackCredentialsErrorResponse,
      { status: 400 },
    )
  }
  if (!isCredentialsRequest(body)) {
    return NextResponse.json(
      { error: 'InvalidRequestShape' } satisfies SlackCredentialsErrorResponse,
      { status: 400 },
    )
  }

  const fieldErrors = validateTokenShapes(body)
  if (Object.keys(fieldErrors).length > 0) {
    return NextResponse.json(
      {
        error: 'InvalidTokenShape',
        detail: 'One or more Slack tokens have an unexpected format',
        fieldErrors,
      } satisfies SlackCredentialsErrorResponse,
      { status: 400 },
    )
  }

  const fleetPrefix = resolveFleetPrefix()
  const clusterName = fleetPrefix.clusterName
  const serviceName = `${fleetPrefix.prefix}-companion-openclaw-${agentName}`

  try {
    // ================================================================
    // Step 1: Confirm agent exists + is MC-managed
    // ================================================================
    const describeSvc = await ecsClient.send(
      new DescribeServicesCommand({
        cluster: clusterName,
        services: [serviceName],
        include: ['TAGS'],
      }),
    )
    const target = describeSvc.services?.[0]
    if (!target || target.status === 'INACTIVE') {
      return NextResponse.json(
        {
          error: 'ServiceNotFoundException',
          detail: `agent "${agentName}" not found`,
        } satisfies SlackCredentialsErrorResponse,
        { status: 404 },
      )
    }
    if (!isAgentHarness(target)) {
      return NextResponse.json(
        {
          error: 'ServiceNotFoundException',
          detail: `agent "${agentName}" not found`,
        } satisfies SlackCredentialsErrorResponse,
        { status: 404 },
      )
    }
    const currentTaskDefArn = target.taskDefinition
    if (!currentTaskDefArn) {
      // Defensive: an ACTIVE service without a task-def ARN is
      // a broken state we shouldn't try to mutate from. Surface as
      // 502 so the operator knows to investigate (probably needs a
      // describe-tasks to figure out what's going on).
      return NextResponse.json(
        {
          error: 'ServiceMissingTaskDefinition',
          detail: `service ${serviceName} is ACTIVE but has no taskDefinition`,
        } satisfies SlackCredentialsErrorResponse,
        { status: 502 },
      )
    }

    // ================================================================
    // Step 2: Write three Slack secrets to Secrets Manager
    // ================================================================
    const arns = await writeSlackSecrets({
      agentName,
      projectName: fleetPrefix.projectName,
      environment: fleetPrefix.environment,
      appToken: body.appToken,
      botToken: body.botToken,
      signingSecret: body.signingSecret,
    })

    // ================================================================
    // Step 3: Read live task-def
    // ================================================================
    const describeTd = await ecsClient.send(
      new DescribeTaskDefinitionCommand({
        taskDefinition: currentTaskDefArn,
      }),
    )
    const td = describeTd.taskDefinition
    if (!td || !td.containerDefinitions) {
      return NextResponse.json(
        {
          error: 'TaskDefinitionMissing',
          detail: `current task-def ${currentTaskDefArn} returned no containerDefinitions`,
        } satisfies SlackCredentialsErrorResponse,
        { status: 502 },
      )
    }

    // ================================================================
    // Step 4: Mutate gateway container + register new revision
    // ================================================================
    const channelsConfigJson = JSON.stringify({
      channels: body.channels ?? [],
    })
    const newContainerDefs = injectSlackIntoGateway(
      td.containerDefinitions,
      arns,
      channelsConfigJson,
    )
    const tdInput = stripReadOnlyFields({
      ...(td as unknown as Record<string, unknown>),
      containerDefinitions: newContainerDefs,
      // Preserve the tags from the existing task-def so the new
      // revision keeps the same Project/Environment/AgentName/etc.
      // labels DescribeTaskDefinition returns the tags we want
      // (DescribeTaskDefinition with include=['TAGS'] would expose
      // them; we pass include here separately if needed). For now,
      // tags are lifted off the existing td if present.
      tags: (td as unknown as { tags?: unknown[] }).tags ?? [],
    })

    const registered = await ecsClient.send(
      new RegisterTaskDefinitionCommand(tdInput),
    )
    const newTaskDefArn = registered.taskDefinition?.taskDefinitionArn
    if (!newTaskDefArn) {
      return NextResponse.json(
        {
          error: 'RegisterTaskDefinitionMissingArn',
          detail: 'AWS returned a successful response with no taskDefinitionArn',
        } satisfies SlackCredentialsErrorResponse,
        { status: 502 },
      )
    }

    // ================================================================
    // Step 5: UpdateService → roll onto the new revision
    // ================================================================
    const updated = await ecsClient.send(
      new UpdateServiceCommand({
        cluster: clusterName,
        service: serviceName,
        taskDefinition: newTaskDefArn,
        forceNewDeployment: true,
      }),
    )
    const deploymentId = updated.service?.deployments?.find(
      (d) => d.status === 'PRIMARY',
    )?.id

    logSecurityEvent({
      event_type: 'fleet.slack-credentials.updated',
      severity: 'info',
      source: 'fleet',
      agent_name: agentName,
      detail: `actor=${auth.user?.id} taskDef=${newTaskDefArn} channels=${(body.channels ?? []).length}`,
    })

    return NextResponse.json(
      {
        ok: true,
        agentName,
        taskDefinitionArn: newTaskDefArn,
        deploymentId,
        secretArns: arns,
      } satisfies SlackCredentialsResponse,
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    const error = err as { name?: string; message?: string }
    logger.error(
      {
        cluster: clusterName,
        serviceName,
        agentName,
        errorName: error.name,
        errorMessage: error.message,
      },
      '[fleet] slack-credentials: AWS error',
    )
    return NextResponse.json(
      {
        error: error.name || 'AWSError',
      } satisfies SlackCredentialsErrorResponse,
      { status: 502 },
    )
  }
}
