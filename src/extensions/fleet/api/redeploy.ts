import { NextRequest, NextResponse } from 'next/server'
import {
  ECSClient,
  UpdateServiceCommand,
} from '@aws-sdk/client-ecs'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'

/**
 * POST /api/fleet/services/:name/redeploy — force-new-deployment on an
 * existing ECS service.
 *
 * Phase-2.1's "thinnest MC-mutates-ECS loop": rolls the existing service
 * onto a fresh task without changing the task def or the desired count.
 * Validates the IAM grant (ecs:UpdateService, scoped per ender-stack
 * PR #187) + the API surface end-to-end before Phase-2.2's full
 * Create-agent flow.
 *
 * Auth: `operator` role required. Lower than Create/Delete (Phase-2.2+)
 * because Redeploy is reversible — it kicks the existing config back
 * onto a fresh task; nothing is created or destroyed.
 *
 * The path param `:name` is the bare ECS service name (e.g.
 * `ender-stack-dev-companion-openclaw-smoke-test`), not an ARN. The
 * handler treats it as opaque and passes it straight to
 * UpdateServiceCommand — IAM resource-level scoping (cluster + account)
 * is the actual authorization boundary, not request-side validation.
 *
 * Response 202 (deployment kicked off, not finished):
 *   { ok: true, deploymentId, taskDefinition }
 *
 * Errors return only the SDK error name, not the message — AWS messages
 * embed caller ARN / account ID. Full error stays in CloudWatch via
 * logger.error.
 */

const CLUSTER_NAME = process.env.MC_FLEET_CLUSTER_NAME || 'ender-stack-dev'
const AWS_REGION = process.env.AWS_REGION || 'us-east-1'

// Module-level singleton — same pattern as services.ts. Reuses connection
// pool + credential cache.
const ecsClient = new ECSClient({ region: AWS_REGION })

export interface FleetRedeployResponse {
  ok: true
  /** ECS deployment ID — opaque, useful for cross-referencing CloudTrail. */
  deploymentId: string | undefined
  /** family:revision of the task def the new deployment is rolling onto. */
  taskDefinition: string | undefined
}

export interface FleetRedeployErrorResponse {
  error: string
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  const { name } = await params

  try {
    const resp = await ecsClient.send(
      new UpdateServiceCommand({
        cluster: CLUSTER_NAME,
        service: name,
        forceNewDeployment: true,
      }),
    )

    // Strip account-id-bearing prefix from the task-def ARN at the response
    // boundary, same as services.ts.
    const taskDef = resp.service?.taskDefinition
    const taskDefShort = taskDef ? taskDef.split('/').pop() : undefined

    // Newest deployment is the one we just kicked off. ECS sorts deployments
    // PRIMARY-first by convention but explicit lookup is more robust.
    const newDeployment = resp.service?.deployments?.find(
      (d) => d.status === 'PRIMARY',
    )

    return NextResponse.json(
      {
        ok: true,
        deploymentId: newDeployment?.id,
        taskDefinition: taskDefShort,
      } satisfies FleetRedeployResponse,
      { status: 202, headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    const error = err as { name?: string; message?: string }
    logger.error(
      {
        err,
        cluster: CLUSTER_NAME,
        region: AWS_REGION,
        service: name,
      },
      '[fleet] failed to UpdateService',
    )
    // ServiceNotFoundException → 404 (operator typo or stale UI); other
    // SDK errors → 502 (likely IAM scope or AWS issue).
    const status = error.name === 'ServiceNotFoundException' ? 404 : 502
    return NextResponse.json(
      { error: error.name || 'AWSError' } satisfies FleetRedeployErrorResponse,
      { status },
    )
  }
}
