import { NextRequest, NextResponse } from 'next/server'
import {
  ECSClient,
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
} from '@aws-sdk/client-ecs'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { HARNESS_TYPES, type HarnessType } from '@/extensions/fleet/templates/constraints'

/**
 * GET /api/fleet/harness-defaults — per-harness defaults the
 * create-agent form pre-fills.
 *
 * Phase 2.2 Beat 3b.1. Today the only field with a useful default is
 * `image` (operators were retyping the OpenClaw image URI from
 * memory). We derive the default by looking up an existing companion-
 * service's currently-deployed image — self-updating as the cluster
 * gets newer images, no env-var or hardcoded sha required.
 *
 * For `companion/openclaw`:
 *   1. List companion-openclaw-* services (via cached services-API
 *      pattern would be ideal, but for a low-volume admin endpoint a
 *      direct DescribeServices is fine).
 *   2. Pick the smoke-test service if present (canonical reference).
 *   3. Read its task-def → return the gateway container's image as
 *      the default.
 *   4. If none of the lookups succeed, return `defaultImage: null` —
 *      form falls back to an example placeholder. Endpoint never 5xx
 *      on a missing default; that would block the form.
 *
 * Auth: `viewer` (matches services.ts) — anyone who can view the
 * Fleet panel can see what the defaults would be.
 *
 * Cache-friendly: defaults change rarely (only when ECS rolls). Form
 * fetches once on mount; no polling.
 */

interface HarnessDefault {
  /** Pre-fill value for the create-agent form's image field; null when unknown. */
  defaultImage: string | null
}

export interface HarnessDefaultsResponse {
  defaults: Record<HarnessType, HarnessDefault>
}

export interface HarnessDefaultsErrorResponse {
  error: string
}

const AWS_REGION_AT_LOAD = process.env.AWS_REGION || 'us-east-1'
const ecsClient = new ECSClient({ region: AWS_REGION_AT_LOAD })

// Per-call timeout for the two ECS lookups. Form is operator-facing;
// a stuck handler would block the form's pre-fill effect with no
// error visible to the operator (catch is silent by design — falls
// back to placeholder example). 5s gives ECS plenty of headroom over
// the realistic ~50-150ms happy path while preventing indefinite
// hangs during AWS throttling or transient network issues. Round-1
// audit on PR #38.
const ECS_CALL_TIMEOUT_MS = 5_000

function withTimeout(): AbortSignal {
  const ac = new AbortController()
  setTimeout(() => ac.abort(), ECS_CALL_TIMEOUT_MS)
  return ac.signal
}

function clusterName(): string {
  return process.env.MC_FLEET_CLUSTER_NAME || 'ender-stack-dev'
}

function projectPrefix(): string {
  const env = process.env.MC_FLEET_ENVIRONMENT || 'dev'
  const project = process.env.MC_FLEET_PROJECT_NAME || 'ender-stack'
  return `${project}-${env}`
}

/**
 * Lookup the OpenClaw smoke-test service's currently-deployed image.
 * Returns null on any lookup failure (service missing, AWS error,
 * task-def missing the gateway container) — caller treats null as
 * "no default known."
 */
async function openclawDefaultImage(): Promise<string | null> {
  const cluster = clusterName()
  const serviceName = `${projectPrefix()}-companion-openclaw-smoke-test`

  let taskDefArn: string | undefined
  try {
    const resp = await ecsClient.send(
      new DescribeServicesCommand({
        cluster,
        services: [serviceName],
      }),
      { abortSignal: withTimeout() },
    )
    // Filter to ACTIVE only — DescribeServices returns DRAINING +
    // INACTIVE records too, with their last-known taskDefinition.
    // A torn-down smoke-test would otherwise pre-fill a stale image
    // (the operator sees a sha that's no longer running anywhere).
    // Round-1 audit on PR #38 (Greptile P2).
    const activeService = resp.services?.find((s) => s.status === 'ACTIVE')
    taskDefArn = activeService?.taskDefinition
  } catch (err) {
    logger.warn(
      { err, cluster, serviceName },
      '[fleet] harness-defaults: DescribeServices failed; falling back to null default',
    )
    return null
  }

  if (!taskDefArn) {
    // Service doesn't exist OR is in DRAINING/INACTIVE state. Either
    // way, no current default to surface — operator gets placeholder.
    return null
  }

  try {
    const tdResp = await ecsClient.send(
      new DescribeTaskDefinitionCommand({ taskDefinition: taskDefArn }),
      { abortSignal: withTimeout() },
    )
    const gateway = tdResp.taskDefinition?.containerDefinitions?.find(
      (c) => c.name === 'openclaw-gateway',
    )
    return gateway?.image ?? null
  } catch (err) {
    logger.warn(
      { err, taskDefArn },
      '[fleet] harness-defaults: DescribeTaskDefinition failed; falling back to null default',
    )
    return null
  }
}

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  // Per-harness lookup. Today only OpenClaw; structured as a record
  // keyed by HARNESS_TYPES so adding Hermes (or any other harness)
  // is a single-line extension.
  const defaults: Record<HarnessType, HarnessDefault> = {
    'companion/openclaw': {
      defaultImage: await openclawDefaultImage(),
    },
  }

  // Belt-and-suspenders: if HARNESS_TYPES grows but the lookup map
  // doesn't, the response is incomplete. Validate at runtime so the
  // mismatch surfaces in a CI test rather than as a silent UI gap.
  for (const t of HARNESS_TYPES) {
    if (!(t in defaults)) {
      logger.error(
        { harnessType: t },
        '[fleet] harness-defaults: HARNESS_TYPES contains a harness not present in the defaults lookup map',
      )
      return NextResponse.json(
        { error: 'IncompleteDefaults' } satisfies HarnessDefaultsErrorResponse,
        { status: 500 },
      )
    }
  }

  return NextResponse.json(
    { defaults } satisfies HarnessDefaultsResponse,
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  )
}
