/**
 * LiteLLM cache metrics — daily rollup and query helpers.
 *
 * Aggregates cache_read_tokens + cache_write_tokens from litellm_usage
 * into a litellm_cache_daily table for efficient time-series queries.
 */
import type Database from 'better-sqlite3'
import type { CacheDailyRow } from './usage'

const CACHE_READ_PRICE_PER_M = 1.50
const INPUT_PRICE_PER_M = 15.00
const SAVINGS_PER_M_READ = INPUT_PRICE_PER_M - CACHE_READ_PRICE_PER_M

export function ensureCacheDailyTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS litellm_cache_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT 'all',
      calls INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      est_savings_usd REAL DEFAULT 0,
      updated_at INTEGER DEFAULT (unixepoch()),
      UNIQUE(day, model)
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_litellm_cache_daily_day ON litellm_cache_daily(day)`)
}

export function rollupCacheMetrics(db: Database.Database): { rows_upserted: number } {
  ensureCacheDailyTable(db)

  const rows = db.prepare(`
    SELECT
      strftime('%Y-%m-%d', created_at, 'unixepoch') AS day,
      COALESCE(model, 'unknown') AS model,
      COUNT(*) AS calls,
      COALESCE(SUM(prompt_tokens), 0) AS input_tokens,
      COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens
    FROM litellm_usage
    WHERE cache_read_tokens > 0 OR cache_write_tokens > 0
    GROUP BY day, COALESCE(model, 'unknown')
  `).all() as any[]

  const stmt = db.prepare(`
    INSERT INTO litellm_cache_daily (day, model, calls, input_tokens, cache_read_tokens, cache_write_tokens, est_savings_usd, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(day, model) DO UPDATE SET
      calls = excluded.calls,
      input_tokens = excluded.input_tokens,
      cache_read_tokens = excluded.cache_read_tokens,
      cache_write_tokens = excluded.cache_write_tokens,
      est_savings_usd = excluded.est_savings_usd,
      updated_at = unixepoch()
  `)

  let upserted = 0
  const run = db.transaction(() => {
    for (const r of rows) {
      const savings = (Number(r.cache_read_tokens) / 1_000_000) * SAVINGS_PER_M_READ
      stmt.run(r.day, r.model, r.calls, r.input_tokens, r.cache_read_tokens, r.cache_write_tokens, savings)
      upserted++
    }
  })
  run()

  return { rows_upserted: upserted }
}

export type CacheWindow = '7d' | '30d' | 'all'

export function queryCacheDailySummary(db: Database.Database, window: CacheWindow): {
  rows: CacheDailyRow[]
  totals: {
    calls: number
    input_tokens: number
    cache_read_tokens: number
    cache_write_tokens: number
    hit_rate: number
    est_savings_usd: number
  }
} {
  ensureCacheDailyTable(db)

  const since = window === 'all' ? null
    : window === '7d' ? Math.floor(Date.now() / 1000) - 7 * 86400
    : Math.floor(Date.now() / 1000) - 30 * 86400

  const sinceDate = since ? new Date(since * 1000).toISOString().slice(0, 10) : null
  const whereClause = sinceDate ? `WHERE day >= ?` : ''
  const whereParams: any[] = sinceDate ? [sinceDate] : []

  const rows = db.prepare(`
    SELECT
      day,
      'all' AS model,
      SUM(calls) AS calls,
      SUM(input_tokens) AS input_tokens,
      SUM(cache_read_tokens) AS cache_read_tokens,
      SUM(cache_write_tokens) AS cache_write_tokens,
      SUM(est_savings_usd) AS est_savings_usd
    FROM litellm_cache_daily
    ${whereClause}
    GROUP BY day
    ORDER BY day ASC
  `).all(...whereParams) as any[]

  const totalsRow = db.prepare(`
    SELECT
      SUM(calls) AS calls,
      SUM(input_tokens) AS input_tokens,
      SUM(cache_read_tokens) AS cache_read_tokens,
      SUM(cache_write_tokens) AS cache_write_tokens,
      SUM(est_savings_usd) AS est_savings_usd
    FROM litellm_cache_daily
    ${whereClause}
  `).get(...whereParams) as any

  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
  const total_read = n(totalsRow?.cache_read_tokens)
  const total_inp = n(totalsRow?.input_tokens)

  return {
    rows: rows.map(r => ({
      day: String(r.day),
      model: 'all',
      calls: n(r.calls),
      input_tokens: n(r.input_tokens),
      cache_read_tokens: n(r.cache_read_tokens),
      cache_write_tokens: n(r.cache_write_tokens),
      est_savings_usd: n(r.est_savings_usd),
    })),
    totals: {
      calls: n(totalsRow?.calls),
      input_tokens: total_inp,
      cache_read_tokens: total_read,
      cache_write_tokens: n(totalsRow?.cache_write_tokens),
      hit_rate: total_inp > 0 ? total_read / total_inp : 0,
      est_savings_usd: n(totalsRow?.est_savings_usd),
    },
  }
}
