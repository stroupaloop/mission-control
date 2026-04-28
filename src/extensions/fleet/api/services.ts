import { NextRequest, NextResponse } from 'next/server'
import {
  ECSClient,
  ListServicesCommand,
  DescribeServicesCommand,
  type Service,
} from '@aws-sdk/client-ecs'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'

/**
 * GET /api/fleet/services — list ECS services in the configured cluster.
 *
 * Phase-2.0 read-only foundation for the MC "Fleet" page (production
 * agents deployed to ECS Fargate, distinct from upstream's /agents page
 * which serves the local/docker dev-iteration workflow). Calls
 * `ecs:ListServices` + `ecs:DescribeServices` against a single cluster
 * (per-deployment OSS-fork model — each consuming org's MC sees its own
 * cluster only). The companion task role's IAM grant for these actions
 * is provisioned in the ender-stack repo (PR #150).
 *
 * Cluster name comes from MC_FLEET_CLUSTER_NAME with a sensible default
 * (`ender-stack-dev`). Region from AWS_REGION (set automatically on
 * Fargate task metadata; falls back to us-east-1 for local dev).
 *
 * Auth: gated by `requireRole(request, 'viewer')` — same minimum tier
 * as other read-only extension endpoints (litellm/cache, etc.).
 *
 * Error responses return only the SDK error name (no message detail) to
 * avoid leaking IAM ARNs / account IDs into the browser. Full stack
 * remains in CloudWatch via the logger.error call.
 */

const CLUSTER_NAME = process.env.MC_FLEET_CLUSTER_NAME || 'ender-stack-dev'
const AWS_REGION = process.env.AWS_REGION || 'us-east-1'

// Service-arn page size cap on DescribeServicesCommand is 10 (AWS-side
// limit). For deployments with more services we'd need to chunk; the
// current ender-stack-dev has well under 10. If this ever grows, the
// chunked-paginate dance lands in a follow-up PR.
const MAX_SERVICES_PER_DESCRIBE = 10

// ListServices first-page cap. Past this size, the response is marked
// truncated and the UI warns; nextToken pagination is a follow-up.
const LIST_SERVICES_MAX_RESULTS = 100

// Module-level singleton — reuses connection pool + credential cache
// across requests. (Per-request `new ECSClient()` triggers fresh IMDS
// resolution on Fargate.)
const ecsClient = new ECSClient({ region: AWS_REGION })

export interface FleetServiceSummary {
  name: string
  status: string | undefined
  desiredCount: number | undefined
  runningCount: number | undefined
  pendingCount: number | undefined
  taskDefinition: string | undefined
  launchType: string | undefined
  /** Number of active deployments (>1 means a rollout is mid-flight). */
  activeDeployments: number
}

export interface FleetServicesResponse {
  cluster: string
  region: string
  services: FleetServiceSummary[]
  /** True when ListServices hit its first-page cap; UI should warn. */
  truncated: boolean
}

export interface FleetServicesErrorResponse {
  error: string
}

function summarizeService(service: Service): FleetServiceSummary {
  // ECS service ARN format (post-2023): arn:aws:ecs:region:account:service/cluster/name
  // Extract the friendly name (the last path segment).
  const arn = service.serviceArn || ''
  const name = arn.split('/').pop() || service.serviceName || '(unknown)'

  return {
    name,
    status: service.status,
    desiredCount: service.desiredCount,
    runningCount: service.runningCount,
    pendingCount: service.pendingCount,
    taskDefinition: service.taskDefinition,
    launchType: service.launchType,
    activeDeployments: service.deployments?.length ?? 0,
  }
}

export async function GET(
  request: NextRequest,
): Promise<NextResponse<FleetServicesResponse | FleetServicesErrorResponse>> {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth && auth.error) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  try {
    const listResp = await ecsClient.send(
      new ListServicesCommand({
        cluster: CLUSTER_NAME,
        maxResults: LIST_SERVICES_MAX_RESULTS,
      }),
    )

    const arns = listResp.serviceArns ?? []
    const truncated = arns.length === LIST_SERVICES_MAX_RESULTS

    if (arns.length === 0) {
      return NextResponse.json({
        cluster: CLUSTER_NAME,
        region: AWS_REGION,
        services: [],
        truncated,
      })
    }

    // DescribeServices caps at 10 ARNs per call. Chunk and concat.
    const chunks: string[][] = []
    for (let i = 0; i < arns.length; i += MAX_SERVICES_PER_DESCRIBE) {
      chunks.push(arns.slice(i, i + MAX_SERVICES_PER_DESCRIBE))
    }

    const all: Service[] = []
    for (const chunk of chunks) {
      const desc = await ecsClient.send(
        new DescribeServicesCommand({
          cluster: CLUSTER_NAME,
          services: chunk,
        }),
      )
      if (desc.services) {
        all.push(...desc.services)
      }
      // Surface any per-ARN failures (e.g. service deleted between
      // ListServices and DescribeServices) so they don't silently vanish.
      if (desc.failures && desc.failures.length > 0) {
        logger.warn(
          {
            cluster: CLUSTER_NAME,
            failures: desc.failures,
          },
          '[fleet] DescribeServices reported per-ARN failures',
        )
      }
    }

    return NextResponse.json({
      cluster: CLUSTER_NAME,
      region: AWS_REGION,
      services: all.map(summarizeService),
      truncated,
    })
  } catch (err) {
    const error = err as { name?: string; message?: string; stack?: string }
    logger.error(
      {
        err,
        cluster: CLUSTER_NAME,
        region: AWS_REGION,
      },
      '[fleet] failed to list/describe ECS services',
    )
    return NextResponse.json(
      {
        error: error.name || 'AWSError',
      },
      { status: 502 },
    )
  }
}
