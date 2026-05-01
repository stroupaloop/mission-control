import { NextRequest, NextResponse } from 'next/server'
import {
  ECSClient,
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
} from '@aws-sdk/client-ecs'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'
import {
  AGENT_NAME_MIN_LENGTH,
  HARNESS_TYPES,
  type HarnessType,
} from '@/extensions/fleet/templates/constraints'
import { maxAgentNameLengthForPrefix } from '@/extensions/fleet/templates/openclaw'

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
  /**
   * Maximum legal `agentName` length for THIS deployment. Computed
   * server-side from the actual `{prefix}` so the form's input
   * `maxLength` is accurate per-deployment (different forks have
   * different prefixes; `ender-stack-dev` allows 10 chars, a shorter
   * fork prefix would allow more). Capped server-side regardless;
   * this just gives the form an honest hint.
   *
   * For OpenClaw: derived from the AWS target-group-name 32-char
   * limit minus the `{prefix}-agent-` overhead. See
   * `maxAgentNameLengthForPrefix` in templates/openclaw.ts.
   */
  agentNameMaxLength: number
}

export interface HarnessDefaultsResponse {
  defaults: Record<HarnessType, HarnessDefault>
}

export interface HarnessDefaultsErrorResponse {
  error: string
  /** Operator-actionable detail (admin-only endpoint). For
   *  PrefixTooLongForHarness: names the offending prefix so operators
   *  without log access can self-diagnose. */
  detail?: string
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

interface TimeoutHandle {
  signal: AbortSignal
  /** Clear the underlying timer to avoid orphaned setTimeout callbacks
   *  on the happy path (timer would fire 4.85-4.95s later, abort an
   *  already-settled signal, and only then be GC'd). Round-2 audit
   *  flagged this as P3 cleanup. */
  clear: () => void
}

function withTimeout(): TimeoutHandle {
  const ac = new AbortController()
  const id = setTimeout(() => ac.abort(), ECS_CALL_TIMEOUT_MS)
  return { signal: ac.signal, clear: () => clearTimeout(id) }
}

function clusterName(): string {
  return process.env.MC_FLEET_CLUSTER_NAME || 'ender-stack-dev'
}

/**
 * Resolve the `{project}-{env}` prefix used for service-name
 * templating. Mirrors agents.ts's derivation:
 *   - MC_FLEET_PROJECT_NAME wins if set
 *   - else fall back to all-but-last segment of MC_FLEET_CLUSTER_NAME
 *     (default cluster `ender-stack-dev` → project `ender-stack`)
 *   - same for MC_FLEET_ENVIRONMENT, but tail segment instead
 *
 * The previous hardcoded `'ender-stack'` fallback drifted from
 * agents.ts and would have produced wrong service names for
 * deployments that set ONLY MC_FLEET_CLUSTER_NAME (without
 * project/env). Round-3 audit P2.
 *
 * KEEP IN SYNC with `resolveEnv()` in api/agents.ts. The form's
 * client-side caps (driven by this endpoint) must match the
 * server's enforced caps (driven by agents.ts). If agents.ts ever
 * gains a new fallback or env var, update both files together.
 */
function projectPrefix(): string {
  const cluster = clusterName()
  const project =
    process.env.MC_FLEET_PROJECT_NAME ||
    cluster.split('-').slice(0, -1).join('-')
  const env =
    process.env.MC_FLEET_ENVIRONMENT || cluster.split('-').pop() || 'dev'
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
  const t1 = withTimeout()
  try {
    const resp = await ecsClient.send(
      new DescribeServicesCommand({
        cluster,
        services: [serviceName],
      }),
      { abortSignal: t1.signal },
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
  } finally {
    t1.clear()
  }

  if (!taskDefArn) {
    // Service doesn't exist OR is in DRAINING/INACTIVE state. Either
    // way, no current default to surface — operator gets placeholder.
    return null
  }

  const t2 = withTimeout()
  try {
    const tdResp = await ecsClient.send(
      new DescribeTaskDefinitionCommand({ taskDefinition: taskDefArn }),
      { abortSignal: t2.signal },
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
  } finally {
    t2.clear()
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
  const prefix = projectPrefix()

  // Defensive: catch the degenerate case where the deployment
  // prefix is so long that no legal agent name fits under the AWS
  // 32-char target-group-name limit. Threshold is `<
  // AGENT_NAME_MIN_LENGTH` (not `<= 0`) — round-4 audit caught that
  // a 23-24 char prefix produces maxLen=1 or 2, which passes a
  // `<= 0` guard but is structurally impossible (regex min is 3).
  // Form would silently fall back to maxLength=32 and every submit
  // would 400 with a confusing AGENT_NAME_RE rejection. Surface the
  // misconfig at the endpoint instead.
  const openclawMaxLen = maxAgentNameLengthForPrefix(prefix)
  if (openclawMaxLen < AGENT_NAME_MIN_LENGTH) {
    logger.error(
      { prefix, openclawMaxLen, minRequired: AGENT_NAME_MIN_LENGTH },
      '[fleet] harness-defaults: deployment prefix leaves insufficient room for any legal agent name (computed max < regex min)',
    )
    return NextResponse.json(
      {
        error: 'PrefixTooLongForHarness',
        // Surface prefix in detail so operators without log access
        // can self-diagnose. Admin-only endpoint; reflected value
        // is server config, not user input. Round-4 audit.
        detail: `prefix "${prefix}" leaves only ${openclawMaxLen} chars for the agent-name segment, but agent names require at least ${AGENT_NAME_MIN_LENGTH}`,
      } satisfies HarnessDefaultsErrorResponse,
      { status: 500 },
    )
  }

  const defaults: Record<HarnessType, HarnessDefault> = {
    'companion/openclaw': {
      defaultImage: await openclawDefaultImage(),
      agentNameMaxLength: openclawMaxLen,
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
