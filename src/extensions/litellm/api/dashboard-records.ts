import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getDatabase } from '@/lib/db'
import { logger } from '@/lib/logger'
import { queryUsageRecords } from '@/extensions/litellm/usage'

/**
 * GET /api/litellm/dashboard/records?limit=X&offset=X&model=X&user=X
 *
 * Role-authed proxy for the recent-calls table on the LLM Usage dashboard.
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  try {
    const { searchParams } = new URL(request.url)
    const model = searchParams.get('model') || undefined
    const user = searchParams.get('user') || undefined
    const limit = Math.min(parseInt(searchParams.get('limit') || '25', 10) || 25, 1000)
    const offset = parseInt(searchParams.get('offset') || '0', 10) || 0
    const since = searchParams.get('since') ? parseInt(searchParams.get('since')!, 10) : undefined
    const until = searchParams.get('until') ? parseInt(searchParams.get('until')!, 10) : undefined

    const db = getDatabase()
    const result = queryUsageRecords(db, { model, user, limit, offset, since, until })

    return NextResponse.json(result)
  } catch (err: any) {
    logger.error({ err }, 'LiteLLM dashboard records failed')
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
