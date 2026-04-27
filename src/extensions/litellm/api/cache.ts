import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getDatabase } from '@/lib/db'
import { queryCacheDailySummary, type CacheWindow } from '../cache-metrics'

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const { searchParams } = new URL(request.url)
  const rawWindow = searchParams.get('window') || '30d'
  const window: CacheWindow = rawWindow === '7d' ? '7d' : rawWindow === 'all' ? 'all' : '30d'

  try {
    const db = getDatabase()
    const result = queryCacheDailySummary(db, window)
    return NextResponse.json(result)
  } catch (err: any) {
    return NextResponse.json({ rows: [], totals: {}, error: err.message }, { status: 500 })
  }
}
