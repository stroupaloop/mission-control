/**
 * GET /api/resolver/timeseries/daily?days=30
 *
 * Returns last N days of resolver_metrics_daily (prebuilt by the rollup scheduler tick).
 */

import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { logger } from '@/lib/logger'
import { ensureResolverTables } from '../telemetry'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const rawDays = Number(searchParams.get('days') ?? '30')
    const days = Number.isFinite(rawDays) ? Math.min(Math.max(Math.floor(rawDays), 1), 365) : 30

    const db = getDatabase()
    ensureResolverTables(db)

    const rows = db
      .prepare(
        `SELECT day, classifications, llm_calls, llm_errors, avg_confidence,
                avg_llm_latency_ms, tools_narrowed, tokens_saved_est,
                prompt_tokens_observed, cost_usd_observed, updated_at
         FROM resolver_metrics_daily
         ORDER BY day DESC
         LIMIT ?`,
      )
      .all(days)

    return NextResponse.json({ days, rows })
  } catch (err: any) {
    logger.error({ err }, 'resolver timeseries/daily failed')
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
