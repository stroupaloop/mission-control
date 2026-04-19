/**
 * GET /api/resolver/timeseries/weekly?weeks=12
 *
 * Returns last N weeks from resolver_weekly_metrics with drift flags.
 * Empty-state safe: returns { weeks, rows: [], hasData: false } when no data yet.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { logger } from '@/lib/logger'
import { ensureResolverTables } from '../telemetry'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const rawWeeks = Number(searchParams.get('weeks') ?? '12')
    const weeks = Number.isFinite(rawWeeks) ? Math.min(Math.max(Math.floor(rawWeeks), 1), 52) : 12

    const db = getDatabase()
    ensureResolverTables(db)

    const rows = db
      .prepare(
        `SELECT week_start, must_include_recall_curated, must_include_recall_live,
                drift_delta_pp, flagged_drift, top_miss_tools, auto_proposed_overrides,
                tokens_saved_total, dollars_saved_total, ingested_at, source_file
         FROM resolver_weekly_metrics
         ORDER BY week_start DESC
         LIMIT ?`,
      )
      .all(weeks)

    return NextResponse.json({ weeks, rows, hasData: rows.length > 0 })
  } catch (err: any) {
    logger.error({ err }, 'resolver timeseries/weekly failed')
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
