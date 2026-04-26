import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getDatabase } from '@/lib/db'
import { logger } from '@/lib/logger'
import { computeUsageSummary, parseWindow } from '@/extensions/litellm/usage'

/**
 * GET /api/litellm/dashboard/summary?window=24h|7d|30d|all
 *
 * Role-authed proxy for the Mission Control LLM Usage dashboard.
 * Reuses the same aggregation logic as /api/litellm/usage/summary, but
 * authenticates via operator role instead of the machine ingest token.
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  try {
    const { searchParams } = new URL(request.url)
    const window = parseWindow(searchParams.get('window'))
    const db = getDatabase()
    const summary = computeUsageSummary(db, window)
    return NextResponse.json(summary)
  } catch (err: any) {
    logger.error({ err }, 'LiteLLM dashboard summary failed')
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
