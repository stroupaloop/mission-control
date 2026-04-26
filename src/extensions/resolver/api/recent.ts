/**
 * GET /api/resolver/recent?limit=N
 *
 * Returns the most recent N resolver telemetry rows plus aggregates grouped
 * by source / agent / confidence bucket. tools_before/after_count is computed
 * from the JSON arrays stored in available_tools / final_tools.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { ensureResolverTables } from '../telemetry'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const limitParam = searchParams.get('limit')
    const limit = Math.max(1, Math.min(500, parseInt(limitParam ?? '50', 10) || 50))

    const db = getDatabase()
    ensureResolverTables(db)

    const recent = db
      .prepare(
        `SELECT turn, session_id, agent_id, source, confidence, reasoning,
                llm_latency_ms, llm_error, validation_action,
                COALESCE(json_array_length(available_tools), 0) AS tools_before_count,
                COALESCE(json_array_length(final_tools), 0)     AS tools_after_count,
                ts
         FROM resolver_telemetry
         ORDER BY ts DESC
         LIMIT ?`,
      )
      .all(limit)

    const bySource = db
      .prepare(
        `SELECT source,
                COUNT(*)        AS count,
                AVG(confidence) AS avg_confidence,
                AVG(
                  CASE
                    WHEN COALESCE(json_array_length(available_tools), 0) > 0
                    THEN 1.0 - CAST(COALESCE(json_array_length(final_tools), 0) AS REAL)
                                 / json_array_length(available_tools)
                    ELSE NULL
                  END
                ) AS avg_narrowed
         FROM resolver_telemetry
         GROUP BY source
         ORDER BY count DESC`,
      )
      .all()

    const byAgent = db
      .prepare(
        `SELECT agent_id, COUNT(*) AS count
         FROM resolver_telemetry
         WHERE agent_id IS NOT NULL
         GROUP BY agent_id
         ORDER BY count DESC
         LIMIT 10`,
      )
      .all()

    const confidenceBuckets = db
      .prepare(
        `SELECT
           CASE
             WHEN confidence IS NULL THEN 'unknown'
             WHEN confidence < 0.3 THEN '0.0–0.3'
             WHEN confidence < 0.6 THEN '0.3–0.6'
             WHEN confidence < 0.8 THEN '0.6–0.8'
             ELSE '0.8–1.0'
           END AS bucket,
           COUNT(*) AS count
         FROM resolver_telemetry
         GROUP BY bucket
         ORDER BY bucket ASC`,
      )
      .all()

    return NextResponse.json({ recent, bySource, byAgent, confidenceBuckets })
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? 'failed to load resolver recent activity' },
      { status: 500 },
    )
  }
}
