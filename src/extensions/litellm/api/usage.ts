import crypto from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { deriveAttribution } from '@/extensions/litellm/attribution'
import { logger } from '@/lib/logger'

const LITELLM_INGEST_TOKEN = process.env.MC_LITELLM_INGEST_TOKEN || process.env.MC_AUDIT_INGEST_TOKEN || ''

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
 * POST /api/litellm/usage — Ingest per-request usage records from LiteLLM callback
 *
 * LiteLLM success_callback sends:
 *   call_type, model, model_id, api_base, response_cost,
 *   completion_tokens, prompt_tokens, total_tokens,
 *   startTime, endTime, user, metadata, litellm_call_id, status, cache_hit
 */
export async function POST(request: NextRequest) {
  if (!LITELLM_INGEST_TOKEN) {
    return NextResponse.json({ error: 'LiteLLM ingest not configured' }, { status: 503 })
  }
  if (!isValidToken(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let rawBody: any
  try {
    rawBody = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Handle both single object and array (LiteLLM generic_api sends arrays or single)
  const records = Array.isArray(rawBody) ? rawBody : [rawBody]

  const db = getDatabase()

  db.exec(`
    CREATE TABLE IF NOT EXISTS litellm_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      call_id TEXT,
      call_type TEXT,
      model TEXT,
      model_id TEXT,
      api_base TEXT,
      user_id TEXT,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER,
      response_cost REAL,
      status TEXT,
      cache_hit INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      start_time TEXT,
      end_time TEXT,
      latency_ms REAL,
      metadata TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    )
  `)

  // Migrate existing tables — add cache columns if missing
  const existingCols = (db.prepare("PRAGMA table_info(litellm_usage)").all() as any[]).map((r: any) => r.name)
  if (!existingCols.includes('cache_read_tokens')) {
    db.exec('ALTER TABLE litellm_usage ADD COLUMN cache_read_tokens INTEGER DEFAULT 0')
  }
  if (!existingCols.includes('cache_write_tokens')) {
    db.exec('ALTER TABLE litellm_usage ADD COLUMN cache_write_tokens INTEGER DEFAULT 0')
  }

  const stmt = db.prepare(`
    INSERT INTO litellm_usage (
      call_id, call_type, model, model_id, api_base, user_id,
      prompt_tokens, completion_tokens, total_tokens, response_cost,
      status, cache_hit, cache_read_tokens, cache_write_tokens,
      start_time, end_time, latency_ms, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  let ingested = 0
  try {
    for (const body of records) {
      if (!body || typeof body !== 'object') continue

      // StandardLoggingPayload fields
      const startTime = body.startTime || body.start_time || null
      const endTime = body.endTime || body.end_time || null
      let latencyMs: number | null = null
      if (startTime && endTime) {
        try { latencyMs = new Date(endTime).getTime() - new Date(startTime).getTime() } catch {}
      }

      // Extract usage from nested or flat fields
      const usage = body.usage || {}
      const promptTokens = body.prompt_tokens ?? usage.prompt_tokens ?? null
      const completionTokens = body.completion_tokens ?? usage.completion_tokens ?? null
      const totalTokens = body.total_tokens ?? usage.total_tokens ?? (promptTokens != null && completionTokens != null ? promptTokens + completionTokens : null)
      const cost = body.response_cost ?? body.cost ?? null

      const attribution = deriveAttribution({ user: body.user, metadata: body.metadata })

      // Anthropic cache tokens (sent by openclaw_cache_split callback in metadata)
      const metaObj = typeof body.metadata === 'object' && body.metadata !== null ? body.metadata : {}
      const cacheReadTokens: number = typeof metaObj.cache_read_tokens === 'number' ? metaObj.cache_read_tokens : 0
      const cacheWriteTokens: number = typeof metaObj.cache_write_tokens === 'number' ? metaObj.cache_write_tokens : 0

      stmt.run(
        body.id || body.litellm_call_id || null,
        body.call_type || 'completion',
        body.model || null,
        body.model_id || null,
        body.api_base || null,
        attribution.userId,
        promptTokens,
        completionTokens,
        totalTokens,
        cost,
        body.status || (body.call_type?.includes('failure') ? 'failure' : 'success'),
        body.cache_hit ? 1 : 0,
        cacheReadTokens,
        cacheWriteTokens,
        startTime,
        endTime,
        latencyMs,
        body.metadata ? JSON.stringify(body.metadata) : null,
      )
      ingested++
    }

    return NextResponse.json({ ok: true, ingested })
  } catch (err: any) {
    logger.error({ err }, 'LiteLLM usage ingest failed')
    return NextResponse.json({ error: err.message, ingested }, { status: 500 })
  }
}

/**
 * GET /api/litellm/usage — Query usage records
 * Params: model, user, since, until, limit, offset
 */
export async function GET(request: NextRequest) {
  if (!isValidToken(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = getDatabase()
  const { searchParams } = new URL(request.url)
  const model = searchParams.get('model')
  const user = searchParams.get('user')
  const since = searchParams.get('since')
  const until = searchParams.get('until')
  const limit = Math.min(parseInt(searchParams.get('limit') || '100'), 1000)
  const offset = parseInt(searchParams.get('offset') || '0')

  const conditions: string[] = []
  const params: any[] = []

  if (model) { conditions.push('model LIKE ?'); params.push(`%${model}%`) }
  if (user) { conditions.push('user_id = ?'); params.push(user) }
  if (since) { conditions.push('created_at >= ?'); params.push(parseInt(since)) }
  if (until) { conditions.push('created_at <= ?'); params.push(parseInt(until)) }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  try {
    const total = (db.prepare(`SELECT COUNT(*) as count FROM litellm_usage ${where}`).get(...params) as any)?.count ?? 0
    const rows = db.prepare(`SELECT * FROM litellm_usage ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset)

    const summary = db.prepare(`
      SELECT
        COUNT(*) as total_calls,
        SUM(response_cost) as total_cost,
        SUM(prompt_tokens) as total_prompt_tokens,
        SUM(completion_tokens) as total_completion_tokens,
        AVG(latency_ms) as avg_latency_ms
      FROM litellm_usage ${where}
    `).get(...params) as any

    return NextResponse.json({ records: rows, total, summary, limit, offset })
  } catch (err: any) {
    logger.error({ err }, 'LiteLLM GET usage failed')
    return NextResponse.json({ records: [], total: 0, summary: {}, limit, offset, error: err.message })
  }
}
