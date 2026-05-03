import { NextRequest, NextResponse } from 'next/server'
import {
  ECSClient,
  DescribeServicesCommand,
} from '@aws-sdk/client-ecs'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { logSecurityEvent } from '@/lib/security-events'
import { AGENT_NAME_RE } from '@/extensions/fleet/templates/constraints'
import { resolveFleetPrefix } from '@/extensions/fleet/lib/fleet-prefix'
import { isAgentHarness } from '@/extensions/fleet/lib/ecs-guards'
import {
  getSlackBotToken,
  requireSecretsPrefix,
} from '@/extensions/fleet/lib/secrets-manager'
import {
  listChannels,
  type SlackChannel,
} from '@/extensions/fleet/lib/slack-client'

/**
 * GET /api/fleet/agents/:name/slack/channels — Phase 2.4 Beat 5b.3.
 *
 * Returns the Slack workspace's channel list for the picker UI.
 * Reads the agent's stored bot token from Secrets Manager and
 * calls Slack `conversations.list`. Pure read endpoint.
 *
 * Auth: `admin` role.
 *
 * Service-scope guard: same two-tag check used by the manifest
 * + credentials handlers — refuses to surface channels for a
 * service that isn't a `Component=agent-harness` AND
 * `ManagedBy=mission-control` agent.
 *
 * Token-non-leak guarantee (round-2 audit on ender-stack#276):
 * the bot token is read from SM, passed straight to the Slack
 * client as a Bearer header, and never logged, returned, or
 * surfaced in error payloads. Security events log the actor +
 * agent + channel count only — never the token.
 *
 * MC-as-aggregate-credential-proxy posture: the IAM grant
 * (Beat 5b.3a, ender-stack#276) scopes GetSecretValue to
 * `companion-openclaw-*-slack-bot-token*` — i.e. MC can read
 * any agent's bot token, not just the one this request targets.
 * This is intentional (the picker may open while the agent
 * task is offline, so MC can't proxy through the agent
 * container). Documented in the threat model. Recurring sweeps
 * through CloudTrail's `secretsmanager:GetSecretValue` events
 * filtered by the MC role ARN are the audit boundary.
 */

const AWS_REGION_AT_LOAD = process.env.AWS_REGION || 'us-east-1'
const ecsClient = new ECSClient({ region: AWS_REGION_AT_LOAD })

export interface SlackChannelsResponse {
  ok: true
  agentName: string
  channels: SlackChannel[]
  /** True if Slack returned a non-empty next_cursor; UI should hint at it. */
  truncated: boolean
}

export interface SlackChannelsErrorResponse {
  error: string
  detail?: string
}

export async function GET(
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
      } satisfies SlackChannelsErrorResponse,
      { status: 400 },
    )
  }

  // Pre-check the secrets prefix env var BEFORE any AWS call —
  // ConfigurationError surfaces as a 500 (server misconfigured),
  // not a 502 (upstream failure). Round-2 audit on PR #49: a
  // missing MC_AGENT_SECRETS_NAME_PREFIX would have surfaced as
  // 502 deep in the SM call's catch block, sending the operator
  // hunting Slack/AWS errors when the real fix is in their MC
  // container env config. Mirrors slack-credentials.ts:322.
  try {
    requireSecretsPrefix()
  } catch (err) {
    return NextResponse.json(
      {
        error: 'ConfigurationError',
        detail: (err as Error).message,
      } satisfies SlackChannelsErrorResponse,
      { status: 500 },
    )
  }

  const fleetPrefix = resolveFleetPrefix()
  const clusterName = fleetPrefix.clusterName
  const serviceName = `${fleetPrefix.prefix}-companion-openclaw-${agentName}`

  // Step 1: verify the agent service exists + is MC-managed.
  // Same two-tag guard as slack-manifest / slack-credentials so
  // this endpoint can't be used to enumerate platform services.
  try {
    const describe = await ecsClient.send(
      new DescribeServicesCommand({
        cluster: clusterName,
        services: [serviceName],
        include: ['TAGS'],
      }),
    )
    if (describe.failures && describe.failures.length > 0) {
      logger.warn(
        {
          cluster: clusterName,
          serviceName,
          failures: describe.failures,
        },
        '[fleet] slack-channels: DescribeServices returned failures',
      )
    }
    const target = describe.services?.[0]
    // Round-2 audit on PR #49: tighten to `!== 'ACTIVE'` so
    // DRAINING services (mid-stop / mid-deploy) are also
    // rejected. Same fix shape as PR #48 round-2. Read endpoint
    // blast radius is lower than credentials-write but the guard
    // logic shouldn't diverge between sibling handlers.
    if (!target || target.status !== 'ACTIVE') {
      return NextResponse.json(
        {
          error: 'ServiceNotFoundException',
          detail: `agent "${agentName}" not found`,
        } satisfies SlackChannelsErrorResponse,
        { status: 404 },
      )
    }
    if (!isAgentHarness(target)) {
      return NextResponse.json(
        {
          error: 'ServiceNotFoundException',
          detail: `agent "${agentName}" not found`,
        } satisfies SlackChannelsErrorResponse,
        { status: 404 },
      )
    }
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
      '[fleet] slack-channels: AWS ECS error',
    )
    return NextResponse.json(
      { error: error.name || 'AWSError' } satisfies SlackChannelsErrorResponse,
      { status: 502 },
    )
  }

  // Step 2: read the bot token + call Slack. Wrapped in its own
  // try/catch so SM and Slack errors get distinct status codes
  // and the security-event detail can capture which side failed.
  try {
    const botToken = await getSlackBotToken(agentName)
    const result = await listChannels(botToken)

    logSecurityEvent({
      event_type: 'fleet.slack-channels.listed',
      severity: 'info',
      source: 'fleet',
      agent_name: agentName,
      detail: `actor=${auth.user.id} channels=${result.channels.length} truncated=${result.truncated}`,
    })

    return NextResponse.json(
      {
        ok: true,
        agentName,
        channels: result.channels,
        truncated: result.truncated,
      } satisfies SlackChannelsResponse,
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    const error = err as { name?: string; message?: string; retryAfter?: string }

    // Token-non-leak: log error.name + error.message but NEVER
    // any field of the bot-token value. The error.message strings
    // emitted by getSlackBotToken + listChannels deliberately
    // don't contain token material. This is the audit boundary.
    logger.error(
      {
        agentName,
        errorName: error.name,
        errorMessage: error.message,
      },
      '[fleet] slack-channels: bot-token or Slack-API error',
    )

    logSecurityEvent({
      event_type: 'fleet.slack-channels.failed',
      severity: 'warning',
      source: 'fleet',
      agent_name: agentName,
      detail: `actor=${auth.user.id} error=${error.name ?? 'AWSError'}`,
    })

    if (error.name === 'SlackBotTokenNotFound') {
      return NextResponse.json(
        {
          error: 'SlackBotTokenNotFound',
          detail: `No Slack bot token stored for agent "${agentName}". Run the credential-paste flow first.`,
        } satisfies SlackChannelsErrorResponse,
        { status: 404 },
      )
    }
    if (error.name === 'SlackAuthError') {
      return NextResponse.json(
        {
          error: 'SlackAuthError',
          detail:
            'Slack rejected the stored bot token. Re-paste credentials in the agent panel.',
        } satisfies SlackChannelsErrorResponse,
        { status: 502 },
      )
    }
    if (error.name === 'SlackMissingScope') {
      return NextResponse.json(
        {
          error: 'SlackMissingScope',
          detail:
            'Bot is missing required scopes (channels:read + groups:read). Reinstall the app from the manifest, then re-paste credentials.',
        } satisfies SlackChannelsErrorResponse,
        { status: 502 },
      )
    }
    if (error.name === 'SlackRateLimited') {
      const headers: Record<string, string> = {}
      if (error.retryAfter) headers['Retry-After'] = error.retryAfter
      return NextResponse.json(
        {
          error: 'SlackRateLimited',
          detail: 'Slack rate-limited the request. Retry after the indicated interval.',
        } satisfies SlackChannelsErrorResponse,
        { status: 429, headers },
      )
    }
    return NextResponse.json(
      {
        error: error.name || 'AWSError',
      } satisfies SlackChannelsErrorResponse,
      { status: 502 },
    )
  }
}
