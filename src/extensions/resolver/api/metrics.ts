/**
 * GET /api/resolver/metrics?days=N
 *
 * Returns daily aggregate metrics + totals + telemetry cursor for the last N
 * days. Column names match resolver_metrics_daily schema in telemetry.ts.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { ensureResolverTables } from '../telemetry'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const daysParam = searchParams.get('days')
    const days = Math.max(1, Math.min(365, parseInt(daysParam ?? '14', 10) || 14))

    const db = getDatabase()
    ensureResolverTables(db)

    const rows = db
      .prepare(
        `SELECT day, classifications, llm_calls, llm_errors,
                avg_confidence, avg_llm_latency_ms, tools_narrowed,
                tokens_saved_est, prompt_tokens_observed, cost_usd_observed,
                updated_at
         FROM resolver_metrics_daily
         WHERE day >= date('now', ? || ' days')
         ORDER BY day ASC`,
      )
      .all(`-${days - 1}`)

    const totals = db
      .prepare(
        `SELECT
           COALESCE(SUM(classifications), 0)        AS classifications,
           COALESCE(SUM(llm_calls), 0)              AS llm_calls,
           COALESCE(SUM(llm_errors), 0)             AS llm_errors,
           COALESCE(SUM(tools_narrowed), 0)         AS tools_narrowed,
           COALESCE(SUM(tokens_saved_est), 0)       AS tokens_saved_est,
           COALESCE(SUM(prompt_tokens_observed), 0) AS prompt_tokens_observed,
           COALESCE(SUM(cost_usd_observed), 0.0)    AS cost_usd_observed,
           AVG(avg_confidence)                      AS avg_confidence,
           AVG(avg_llm_latency_ms)                  AS avg_llm_latency_ms
         FROM resolver_metrics_daily
         WHERE day >= date('now', ? || ' days')`,
      )
      .get(`-${days - 1}`) as Record<string, number | null> | undefined

    const cursor = db
      .prepare(
        `SELECT file_path, byte_offset, file_size, last_ingest_at
         FROM resolver_telemetry_cursor
         WHERE key = 'default'`,
      )
      .get() as
      | { file_path: string; byte_offset: number; file_size: number; last_ingest_at: number }
      | undefined

    return NextResponse.json({
      days,
      rows,
      totals: totals ?? {
        classifications: 0,
        llm_calls: 0,
        llm_errors: 0,
        tools_narrowed: 0,
        tokens_saved_est: 0,
        prompt_tokens_observed: 0,
        cost_usd_observed: 0,
        avg_confidence: null,
        avg_llm_latency_ms: null,
      },
      cursor: cursor ?? null,
    })
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? 'failed to load resolver metrics' },
      { status: 500 },
    )
  }
}
