import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { logger } from '@/lib/logger'
import { computeUsageSummary, parseWindow } from '@/extensions/litellm/usage'
import { isValidToken } from '@/extensions/litellm/auth'

/**
 * GET /api/litellm/usage/summary?window=24h|7d|30d|all
 *
 * Token-authed machine API for dashboards and monitoring.
 */
export async function GET(request: NextRequest) {
  if (!isValidToken(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { searchParams } = new URL(request.url)
    const window = parseWindow(searchParams.get('window'))
    const db = getDatabase()
    const summary = computeUsageSummary(db, window)
    return NextResponse.json(summary)
  } catch (err: any) {
    logger.error({ err }, 'LiteLLM usage summary failed')
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
