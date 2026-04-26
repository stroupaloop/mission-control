/**
 * Shared aggregation + query helpers for the litellm_usage table.
 *
 * Used by both the tokened machine API (/api/litellm/usage/summary)
 * and the role-authed dashboard proxy (/api/litellm/dashboard/*).
 */

import type Database from 'better-sqlite3'

export type UsageWindow = '24h' | '7d' | '30d' | 'all'

export interface UsageTotals {
  calls: number
  cost_usd: number
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  avg_latency_ms: number
  cache_hit_rate: number
  error_rate: number
  success_rate: number
}

export interface ByModelRow {
  model: string
  calls: number
  cost_usd: number
  total_tokens: number
  avg_tokens: number
  avg_latency_ms: number
}

export interface ByUserRow {
  user_id: string
  calls: number
  cost_usd: number
  total_tokens: number
}

export interface ByBucketRow {
  bucket: string
  calls: number
  cost_usd: number
  total_tokens: number
}

export interface UsageSummary {
  window: UsageWindow
  totals: UsageTotals
  by_model: ByModelRow[]
  by_user: ByUserRow[]
  by_hour: ByBucketRow[]
}

export interface UsageRecord {
  id: number
  call_id: string | null
  call_type: string | null
  model: string | null
  model_id: string | null
  api_base: string | null
  user_id: string | null
  prompt_tokens: number | null
  completion_tokens: number | null
  total_tokens: number | null
  response_cost: number | null
  status: string | null
  cache_hit: number
  start_time: string | null
  end_time: string | null
  latency_ms: number | null
  metadata: string | null
  created_at: number
}

export interface RecordsQueryParams {
  model?: string
  user?: string
  since?: number
  until?: number
  limit?: number
  offset?: number
}

export interface RecordsQueryResult {
  records: UsageRecord[]
  total: number
  limit: number
  offset: number
}

/**
 * Normalize a window value from query string into a typed UsageWindow.
 */
export function parseWindow(raw: string | null | undefined): UsageWindow {
  const v = String(raw || '24h').toLowerCase()
  if (v === '7d' || v === '30d' || v === 'all') return v
  return '24h'
}

/**
 * Return the `since` cutoff (unix seconds) for a window, or null for 'all'.
 */
export function windowSinceSeconds(window: UsageWindow, nowSeconds: number = Math.floor(Date.now() / 1000)): number | null {
  if (window === 'all') return null
  if (window === '24h') return nowSeconds - 24 * 3600
  if (window === '7d') return nowSeconds - 7 * 24 * 3600
  if (window === '30d') return nowSeconds - 30 * 24 * 3600
  return null
}

/**
 * Bucket granularity for time-series chart.
 */
export function bucketGranularity(window: UsageWindow): 'hour' | 'day' | null {
  if (window === '24h') return 'hour'
  if (window === '7d') return 'hour'
  if (window === '30d') return 'day'
  return null
}

/**
 * SQL fragment for the strftime expression on `created_at` (stored as unix seconds).
 */
export function bucketStrftimeFormat(granularity: 'hour' | 'day'): string {
  return granularity === 'hour' ? '%Y-%m-%dT%H' : '%Y-%m-%d'
}

/**
 * Ensure table exists (idempotent). Safe to call before queries when DB might be empty.
 */
export function ensureLitellmUsageTable(db: Database.Database): void {
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
      start_time TEXT,
      end_time TEXT,
      latency_ms REAL,
      metadata TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    )
  `)
}

function emptyTotals(): UsageTotals {
  return {
    calls: 0,
    cost_usd: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    avg_latency_ms: 0,
    cache_hit_rate: 0,
    error_rate: 0,
    success_rate: 0,
  }
}

function num(x: unknown, def = 0): number {
  const n = typeof x === 'number' ? x : Number(x)
  return Number.isFinite(n) ? n : def
}

/**
 * Compute the full summary for a given window.
 */
export function computeUsageSummary(db: Database.Database, window: UsageWindow): UsageSummary {
  ensureLitellmUsageTable(db)

  const since = windowSinceSeconds(window)
  const whereClause = since != null ? 'WHERE created_at >= ?' : ''
  const whereParams: any[] = since != null ? [since] : []

  // Totals
  const totalsRow = db
    .prepare(
      `
      SELECT
        COUNT(*) AS calls,
        COALESCE(SUM(response_cost), 0) AS cost_usd,
        COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(AVG(latency_ms), 0) AS avg_latency_ms,
        COALESCE(AVG(CASE WHEN cache_hit = 1 THEN 1.0 ELSE 0 END), 0) AS cache_hit_rate,
        COALESCE(
          AVG(
            CASE WHEN status IS NOT NULL AND status != 'success' THEN 1.0 ELSE 0 END
          ),
          0
        ) AS error_rate
      FROM litellm_usage
      ${whereClause}
    `
    )
    .get(...whereParams) as any

  const totals: UsageTotals = emptyTotals()
  if (totalsRow) {
    totals.calls = num(totalsRow.calls)
    totals.cost_usd = num(totalsRow.cost_usd)
    totals.prompt_tokens = num(totalsRow.prompt_tokens)
    totals.completion_tokens = num(totalsRow.completion_tokens)
    totals.total_tokens = num(totalsRow.total_tokens)
    totals.avg_latency_ms = num(totalsRow.avg_latency_ms)
    totals.cache_hit_rate = num(totalsRow.cache_hit_rate)
    totals.error_rate = num(totalsRow.error_rate)
    totals.success_rate = totals.calls > 0 ? 1 - totals.error_rate : 0
  }

  // By model
  const byModel = db
    .prepare(
      `
      SELECT
        COALESCE(model, 'unknown') AS model,
        COUNT(*) AS calls,
        COALESCE(SUM(response_cost), 0) AS cost_usd,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(AVG(total_tokens), 0) AS avg_tokens,
        COALESCE(AVG(latency_ms), 0) AS avg_latency_ms
      FROM litellm_usage
      ${whereClause}
      GROUP BY COALESCE(model, 'unknown')
      ORDER BY cost_usd DESC
      LIMIT 20
    `
    )
    .all(...whereParams) as any[]

  // By user
  const byUser = db
    .prepare(
      `
      SELECT
        COALESCE(user_id, 'unknown') AS user_id,
        COUNT(*) AS calls,
        COALESCE(SUM(response_cost), 0) AS cost_usd,
        COALESCE(SUM(total_tokens), 0) AS total_tokens
      FROM litellm_usage
      ${whereClause}
      GROUP BY COALESCE(user_id, 'unknown')
      ORDER BY cost_usd DESC
      LIMIT 20
    `
    )
    .all(...whereParams) as any[]

  // Time series bucket
  let byHour: ByBucketRow[] = []
  const gran = bucketGranularity(window)
  if (gran) {
    const fmt = bucketStrftimeFormat(gran)
    byHour = db
      .prepare(
        `
        SELECT
          strftime('${fmt}', created_at, 'unixepoch') AS bucket,
          COUNT(*) AS calls,
          COALESCE(SUM(response_cost), 0) AS cost_usd,
          COALESCE(SUM(total_tokens), 0) AS total_tokens
        FROM litellm_usage
        ${whereClause}
        GROUP BY bucket
        ORDER BY bucket ASC
      `
      )
      .all(...whereParams) as any[]
  }

  return {
    window,
    totals,
    by_model: byModel.map(r => ({
      model: String(r.model),
      calls: num(r.calls),
      cost_usd: num(r.cost_usd),
      total_tokens: num(r.total_tokens),
      avg_tokens: num(r.avg_tokens),
      avg_latency_ms: num(r.avg_latency_ms),
    })),
    by_user: byUser.map(r => ({
      user_id: String(r.user_id),
      calls: num(r.calls),
      cost_usd: num(r.cost_usd),
      total_tokens: num(r.total_tokens),
    })),
    by_hour: byHour.map(r => ({
      bucket: String(r.bucket),
      calls: num(r.calls),
      cost_usd: num(r.cost_usd),
      total_tokens: num(r.total_tokens),
    })),
  }
}

/**
 * Query raw records with filters (for the Recent Calls table).
 */
export function queryUsageRecords(
  db: Database.Database,
  params: RecordsQueryParams
): RecordsQueryResult {
  ensureLitellmUsageTable(db)

  const conditions: string[] = []
  const sqlParams: any[] = []

  if (params.model) {
    conditions.push('model LIKE ?')
    sqlParams.push(`%${params.model}%`)
  }
  if (params.user) {
    conditions.push('user_id LIKE ?')
    sqlParams.push(`%${params.user}%`)
  }
  if (params.since != null) {
    conditions.push('created_at >= ?')
    sqlParams.push(params.since)
  }
  if (params.until != null) {
    conditions.push('created_at <= ?')
    sqlParams.push(params.until)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = Math.max(1, Math.min(params.limit ?? 25, 1000))
  const offset = Math.max(0, params.offset ?? 0)

  const total =
    num(
      (db.prepare(`SELECT COUNT(*) AS count FROM litellm_usage ${where}`).get(...sqlParams) as any)?.count
    ) ?? 0

  const rows = db
    .prepare(
      `SELECT * FROM litellm_usage ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    )
    .all(...sqlParams, limit, offset) as UsageRecord[]

  return { records: rows, total, limit, offset }
}
