/**
 * GET /api/resolver/timeseries
 *
 * Dispatcher for /timeseries/daily and /timeseries/weekly. Kept for backwards
 * compatibility with callers that pattern-match on URL suffix. New callers
 * should hit the dedicated sub-routes directly.
 */

import { NextRequest, NextResponse } from 'next/server'
import { GET as getDaily } from './timeseries-daily'
import { GET as getWeekly } from './timeseries-weekly'

export async function GET(request: NextRequest) {
  const { pathname } = new URL(request.url)

  if (pathname.endsWith('/daily')) {
    return getDaily(request)
  }
  if (pathname.endsWith('/weekly')) {
    return getWeekly(request)
  }

  return NextResponse.json(
    { error: 'Use /api/resolver/timeseries/daily or /api/resolver/timeseries/weekly' },
    { status: 400 },
  )
}
