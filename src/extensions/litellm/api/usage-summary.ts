import crypto from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { logger } from '@/lib/logger'
import { computeUsageSummary, parseWindow } from '@/extensions/litellm/usage'

const LITELLM_INGEST_TOKEN =
  process.env.MC_LITELLM_INGEST_TOKEN || process.env.MC_AUDIT_INGEST_TOKEN || ''

/** Constant-time string compare. Returns false on length mismatch (matches src/proxy.ts safeCompare). */
function safeCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

function isValidToken(request: NextRequest): boolean {
  if (!LITELLM_INGEST_TOKEN) return false
  const auth = request.headers.get('authorization') || ''
  if (auth.startsWith('Bearer ')) return safeCompare(auth.slice(7).trim(), LITELLM_INGEST_TOKEN)
  return safeCompare((request.headers.get('x-mc-token') || '').trim(), LITELLM_INGEST_TOKEN)
}

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
