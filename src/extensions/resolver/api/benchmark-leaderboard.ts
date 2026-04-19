/**
 * GET /api/resolver/benchmark/leaderboard
 *
 * Returns the latest benchmark run leaderboard (most recent run_date).
 * Empty-state safe.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { logger } from '@/lib/logger'
import { ensureResolverTables } from '../telemetry'

export async function GET(_request: NextRequest) {
  try {
    const db = getDatabase()
    ensureResolverTables(db)

    const latest = db
      .prepare('SELECT MAX(run_date) AS run_date FROM resolver_quarterly_metrics')
      .get() as { run_date: string | null } | undefined

    if (!latest?.run_date) {
      return NextResponse.json({
        hasData: false,
        runDate: null,
        rows: [],
        nextBenchmarkNote: 'First benchmark run scheduled for 2026-05-01',
      })
    }

    const rows = db
      .prepare(
        `SELECT run_date, model_id, must_include_recall, f1_score,
                latency_p50_ms, latency_p95_ms, cost_per_1k_calls_usd,
                rank_in_run, is_recommended_production, notes, source_file
         FROM resolver_quarterly_metrics
         WHERE run_date = ?
         ORDER BY rank_in_run ASC`,
      )
      .all(latest.run_date)

    return NextResponse.json({ hasData: true, runDate: latest.run_date, rows })
  } catch (err: any) {
    logger.error({ err }, 'resolver benchmark/leaderboard failed')
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
