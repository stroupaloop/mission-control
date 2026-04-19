/**
 * GET /api/resolver/benchmark/model-history
 *
 * Returns resolver_production_model_history — the audit log of which model
 * was in production and when. Empty-state safe.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { logger } from '@/lib/logger'
import { ensureResolverTables } from '../telemetry'

export async function GET(_request: NextRequest) {
  try {
    const db = getDatabase()
    ensureResolverTables(db)

    const rows = db
      .prepare(
        `SELECT id, effective_from, effective_to, model_id, reason, source_file
         FROM resolver_production_model_history
         ORDER BY effective_from DESC`,
      )
      .all()

    const current = rows.find((r: any) => r.effective_to === null) as
      | { model_id: string; effective_from: string }
      | undefined

    return NextResponse.json({
      hasData: rows.length > 0,
      currentModel: current?.model_id ?? null,
      currentSince: current?.effective_from ?? null,
      rows,
    })
  } catch (err: any) {
    logger.error({ err }, 'resolver benchmark/model-history failed')
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
