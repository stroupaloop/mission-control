/**
 * Per-agent lifecycle lock — ender-stack#480 Risk 1.
 *
 * Serializes create-agent and delete-agent for a given agent name so a
 * DELETE can't run its absent-service teardown concurrently with a
 * CREATE that's mid-provisioning. create-agent builds the IAM roles,
 * LiteLLM key/secret, log group, task-def, target group, and listener
 * rule BEFORE `CreateService` (the last step). In that window the ECS
 * service doesn't exist yet, so a concurrent DELETE sees an absent
 * service and — even with the #480 Risk 2 ownership guard — would tear
 * down the resources the create just made (the guard can't help here:
 * create writes the same MC ownership tags, so a half-built agent looks
 * identical to a finished one). A mutual-exclusion lock is the only fix.
 *
 * Mechanism: an SSM Parameter Store advisory lock at
 * `/${project}/${env}/companion-openclaw/${agent}/lifecycle-lock`.
 * `PutParameter` with `Overwrite: false` is an atomic compare-and-set —
 * it throws `ParameterAlreadyExists` if a lock is already held, which is
 * the acquire primitive. Release is `DeleteParameter`.
 *
 * Staleness: SSM parameters have no native TTL, so a handler that
 * crashes mid-op would leave a lock that blocks the name forever.
 * Guard against that by storing the acquire timestamp in the value and
 * treating a lock older than {@link LIFECYCLE_LOCK_TTL_MS} as stale +
 * reclaimable. A normal create/delete finishes in seconds; the 5-minute
 * window only ever fires after a crash. The reclaim has a narrow TOCTOU
 * (two handlers both seeing the same stale lock and both overwriting),
 * accepted because the endpoint is admin-gated and the window only
 * opens after an abandoned lock — never during normal operation.
 *
 * Authoritative, NOT best-effort: unlike `slack-ssm-bridge.ts` (which
 * pins `maxAttempts: 1` because a failed write only degrades
 * drift-resistance), a missed acquire/release here corrupts
 * serialization. We keep the SDK's default retry budget and FAIL CLOSED
 * on a genuine SSM error — the caller returns 503 rather than running
 * an unserialized lifecycle op.
 *
 * IAM grant: `task_ssm_lifecycle_lock` in ender-stack
 * `terraform/modules/iam/main.tf` grants `ssm:PutParameter` +
 * `ssm:GetParameter` + `ssm:DeleteParameter` scoped to the exact path
 * pattern below. The lock value is a plain `String` (not SecureString),
 * so no KMS grant is needed. A typo in the path here means a silent 403
 * → 503 on every create/delete, not a security hole.
 *
 * NOTE: this lib lives outside `src/extensions/fleet/api/`, so the
 * `check-iam-coverage.mjs` scanner does not see these SDK calls (it
 * scans only api/ route handlers — same as slack-ssm-bridge.ts). The
 * IAM grant is therefore enforced by dev validation + this JSDoc, not
 * the coverage gate.
 */

import {
  SSMClient,
  PutParameterCommand,
  GetParameterCommand,
  DeleteParameterCommand,
} from '@aws-sdk/client-ssm'
import { logger } from '@/lib/logger'

const AWS_REGION_AT_LOAD = process.env.AWS_REGION || 'us-east-1'
const ssmClient = new SSMClient({ region: AWS_REGION_AT_LOAD })

/**
 * A lock older than this is treated as stale and reclaimable. Normal
 * create/delete completes in seconds; this covers the slowest observed
 * teardown with wide margin while letting a crashed handler's lock be
 * reclaimed promptly.
 */
export const LIFECYCLE_LOCK_TTL_MS = 5 * 60 * 1000

/** Lifecycle operation holding (or contending for) the lock. */
export type LifecycleOp = 'create' | 'delete'

/** Decoded lock value written into the SSM parameter. */
export interface LifecycleLockHolder {
  op: LifecycleOp
  /** Diagnostic only — the requesting actor id (auth.user.id is numeric). */
  actor?: string | number
  /** Epoch ms when the lock was acquired — drives staleness. */
  ts: number
}

export type AcquireLockResult =
  | { ok: true }
  | { ok: false; reason: 'held'; heldBy: LifecycleLockHolder }
  | { ok: false; reason: 'error'; errorName: string }

export interface LifecycleLockInput {
  projectName: string
  environment: string
  agentName: string
}

export interface AcquireLockInput extends LifecycleLockInput {
  op: LifecycleOp
  actor?: string | number
}

const PARAM_ALREADY_EXISTS = 'ParameterAlreadyExists'
const PARAM_NOT_FOUND = 'ParameterNotFound'

function errName(err: unknown): string {
  return (err as { name?: string })?.name ?? 'UnknownError'
}

/**
 * Build the lock parameter name. Exported so handlers + tests share the
 * literal convention; MUST match the IAM grant's resource ARN pattern
 * in ender-stack `terraform/modules/iam/main.tf`.
 */
export function lifecycleLockParamName(
  projectName: string,
  environment: string,
  agentName: string,
): string {
  return `/${projectName}/${environment}/companion-openclaw/${agentName}/lifecycle-lock`
}

function parseHolder(raw: string | undefined): LifecycleLockHolder | undefined {
  if (!raw) return undefined
  try {
    const v = JSON.parse(raw) as Partial<LifecycleLockHolder>
    if (typeof v.ts === 'number' && typeof v.op === 'string') {
      return v as LifecycleLockHolder
    }
  } catch {
    // Unparseable value — treat as a corrupt/stale lock (caller reclaims).
  }
  return undefined
}

/**
 * Acquire the per-agent lifecycle lock.
 *
 *   - `{ ok: true }`                      — lock held by this caller; the
 *                                           caller MUST {@link releaseLifecycleLock}
 *                                           in a `finally`.
 *   - `{ ok: false, reason: 'held' }`     — another lifecycle op holds a
 *                                           fresh lock; caller returns 409.
 *   - `{ ok: false, reason: 'error' }`    — genuine SSM failure; caller
 *                                           returns 503 (fail closed).
 */
export async function acquireLifecycleLock(
  input: AcquireLockInput,
): Promise<AcquireLockResult> {
  const name = lifecycleLockParamName(
    input.projectName,
    input.environment,
    input.agentName,
  )
  const value: LifecycleLockHolder = {
    op: input.op,
    actor: input.actor,
    ts: Date.now(),
  }

  // Atomic acquire: Overwrite=false throws ParameterAlreadyExists if a
  // lock is already held.
  try {
    await ssmClient.send(
      new PutParameterCommand({
        Name: name,
        Type: 'String',
        Value: JSON.stringify(value),
        Overwrite: false,
      }),
    )
    return { ok: true }
  } catch (err) {
    if (errName(err) !== PARAM_ALREADY_EXISTS) {
      logger.error(
        { agentName: input.agentName, op: input.op, errorName: errName(err) },
        '[fleet] lifecycle-lock: acquire failed on a non-contention SSM error — failing closed',
      )
      return { ok: false, reason: 'error', errorName: errName(err) }
    }
  }

  // A lock exists — read it to decide held-vs-stale.
  let heldBy: LifecycleLockHolder | undefined
  try {
    const got = await ssmClient.send(new GetParameterCommand({ Name: name }))
    heldBy = parseHolder(got.Parameter?.Value)
  } catch (err) {
    if (errName(err) === PARAM_NOT_FOUND) {
      // Released between our PutParameter and this read — the slot is
      // free now. Fall through to the reclaim path (heldBy=undefined).
      heldBy = undefined
    } else {
      logger.error(
        { agentName: input.agentName, op: input.op, errorName: errName(err) },
        '[fleet] lifecycle-lock: GetParameter failed while resolving contention — failing closed',
      )
      return { ok: false, reason: 'error', errorName: errName(err) }
    }
  }

  const ageMs = heldBy ? Date.now() - heldBy.ts : Infinity
  if (heldBy && ageMs < LIFECYCLE_LOCK_TTL_MS) {
    return { ok: false, reason: 'held', heldBy }
  }

  // Stale (or vanished, or corrupt) — reclaim with Overwrite=true. This
  // is the documented TOCTOU window: only reachable after an abandoned
  // lock, never during normal sub-TTL operation.
  try {
    await ssmClient.send(
      new PutParameterCommand({
        Name: name,
        Type: 'String',
        Value: JSON.stringify(value),
        Overwrite: true,
      }),
    )
    logger.warn(
      {
        agentName: input.agentName,
        op: input.op,
        reclaimedAgeMs: Number.isFinite(ageMs) ? ageMs : undefined,
        priorHolder: heldBy,
      },
      '[fleet] lifecycle-lock: reclaimed a stale/abandoned lock',
    )
    return { ok: true }
  } catch (err) {
    logger.error(
      { agentName: input.agentName, op: input.op, errorName: errName(err) },
      '[fleet] lifecycle-lock: stale-lock reclaim failed — failing closed',
    )
    return { ok: false, reason: 'error', errorName: errName(err) }
  }
}

/**
 * Release the per-agent lifecycle lock. Best-effort + idempotent: a
 * missing parameter (already released, or never acquired) is fine. A
 * release failure is logged but not raised — the lock self-expires
 * after {@link LIFECYCLE_LOCK_TTL_MS} via the staleness path, so a
 * dropped release degrades to a delayed unlock, never a permanent one.
 */
export async function releaseLifecycleLock(
  input: LifecycleLockInput,
): Promise<void> {
  const name = lifecycleLockParamName(
    input.projectName,
    input.environment,
    input.agentName,
  )
  try {
    await ssmClient.send(new DeleteParameterCommand({ Name: name }))
  } catch (err) {
    if (errName(err) === PARAM_NOT_FOUND) return
    logger.error(
      { agentName: input.agentName, errorName: errName(err) },
      `[fleet] lifecycle-lock: release failed — lock will self-expire after ${LIFECYCLE_LOCK_TTL_MS}ms`,
    )
  }
}
