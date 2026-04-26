import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getDatabase } from '@/lib/db'
import { logger } from '@/lib/logger'
import { ensureResolverTables } from '@/extensions/resolver/telemetry'
import { getWeakDescriptionRecommendations } from '@/extensions/resolver/recommendations'

/**
 * GET /api/resolver/recommendations?days=7&minOccurrences=5
 *
 * Returns weak-description recommendations derived from resolver_telemetry.
 * Surfaced in the Resolver Intelligence panel to guide operators in creating
 * tool/skill description overrides.
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  try {
    const { searchParams } = new URL(request.url)
    const rawDays = Number(searchParams.get('days') ?? '7')
    const rawMin = Number(searchParams.get('minOccurrences') ?? '5')

    const days = Number.isFinite(rawDays) ? Math.min(Math.max(Math.floor(rawDays), 1), 90) : 7
    const minOccurrences = Number.isFinite(rawMin) ? Math.min(Math.max(Math.floor(rawMin), 1), 100) : 5

    const db = getDatabase()
    ensureResolverTables(db)

    const recommendations = getWeakDescriptionRecommendations(db, { days, minOccurrences })

    return NextResponse.json({ days, minOccurrences, recommendations })
  } catch (err: any) {
    logger.error({ err }, 'Resolver recommendations failed')
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
