/**
 * GET /api/resolver/cost-split?days=30
 *
 * Returns resolver spend vs total LiteLLM spend, split by source.
 * Resolver spend is identified by metadata containing "openclaw-resolver" in request_tags.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { logger } from '@/lib/logger'
import { ensureLitellmUsageTable } from '../../litellm/usage'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const rawDays = Number(searchParams.get('days') ?? '30')
    const days = Number.isFinite(rawDays) ? Math.min(Math.max(Math.floor(rawDays), 1), 365) : 30

    const db = getDatabase()
    ensureLitellmUsageTable(db)

    const sinceTs = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60

    const totals = db
      .prepare(
        `SELECT
           COUNT(*) AS total_calls,
           COALESCE(SUM(response_cost), 0) AS total_cost_usd,
           COUNT(CASE WHEN metadata LIKE '%openclaw-resolver%' THEN 1 END) AS resolver_calls,
           COALESCE(SUM(CASE WHEN metadata LIKE '%openclaw-resolver%' THEN response_cost ELSE 0 END), 0) AS resolver_cost_usd
         FROM litellm_usage
         WHERE created_at >= ?`,
      )
      .get(sinceTs) as {
        total_calls: number
        total_cost_usd: number
        resolver_calls: number
        resolver_cost_usd: number
      }

    const resolverCost = totals?.resolver_cost_usd ?? 0
    const totalCost = totals?.total_cost_usd ?? 0
    const otherCost = Math.max(0, totalCost - resolverCost)
    const resolverPct = totalCost > 0 ? (resolverCost / totalCost) * 100 : 0

    return NextResponse.json({
      days,
      total_cost_usd: totalCost,
      resolver_cost_usd: resolverCost,
      other_cost_usd: otherCost,
      resolver_pct: Math.round(resolverPct * 10) / 10,
      resolver_calls: totals?.resolver_calls ?? 0,
      total_calls: totals?.total_calls ?? 0,
    })
  } catch (err: any) {
    logger.error({ err }, 'resolver cost-split failed')
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
