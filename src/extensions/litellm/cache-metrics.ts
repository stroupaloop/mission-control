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
  // Partial index to speed up the rollup query — only rows with cache activity
  db.exec(`CREATE INDEX IF NOT EXISTS idx_litellm_usage_cache ON litellm_usage(created_at) WHERE cache_read_tokens > 0 OR cache_write_tokens > 0`)
  // Full index on created_at for the workload query in queryCacheDailySummary().
  // The partial index above only covers cache-eligible rows; the workload query
  // scans ALL rows (cache + non-cache) by created_at and would do a full table
  // scan without this. Critical as litellm_usage grows on EFS-backed SQLite.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_litellm_usage_created_at ON litellm_usage(created_at)`)
}

// Roll up the last N days to avoid unbounded full-table scans as the table grows.
// Historical data older than this is already in litellm_cache_daily and won't change.
const ROLLUP_WINDOW_DAYS = 90

export function rollupCacheMetrics(db: Database.Database): { rows_upserted: number } {
  ensureCacheDailyTable(db)

  const cutoffDate = new Date(Date.now() - ROLLUP_WINDOW_DAYS * 86400 * 1000)
    .toISOString().slice(0, 10)

  const rows = db.prepare(`
    SELECT
      strftime('%Y-%m-%d', created_at, 'unixepoch') AS day,
      COALESCE(model, 'unknown') AS model,
      COUNT(*) AS calls,
      COALESCE(SUM(prompt_tokens), 0) AS input_tokens,
      COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens
    FROM litellm_usage
    WHERE (cache_read_tokens > 0 OR cache_write_tokens > 0)
      AND created_at >= unixepoch(?)
    GROUP BY day, COALESCE(model, 'unknown')
  `).all(cutoffDate) as any[]

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
    /** Hit rate computed across cache-eligible calls only (cache_read / (cache_read + cache_write)). */
    hit_rate: number
    /**
     * Effective hit rate computed across ALL calls in the window — includes calls
     * with no cache activity in the denominator. cache_read / SUM(prompt_tokens).
     * This is the headline number the dashboard should show: "of all input tokens
     * we sent, X% came from cache". The classic hit_rate (above) is the cache-eligible
     * subset rate — useful for diagnosing cache quality but inflates ROI vs. total spend.
     */
    effective_hit_rate: number
    /** Total prompt tokens across ALL calls (not just cache-eligible). Denominator for effective_hit_rate. */
    total_prompt_tokens_workload: number
    /** Total calls in the window across ALL calls (not just cache-eligible). */
    total_calls_workload: number
    est_savings_usd: number
  }
} {
  ensureCacheDailyTable(db)

  // Window bounds. Both the cache-daily numerator and the workload denominator
  // MUST anchor to the same UTC-midnight boundary, otherwise the daily query
  // (truncated to YYYY-MM-DD) covers up to 24h more than the workload query
  // (exact seconds), which inflates effective_hit_rate by ~3% on 30d / ~14% on 7d.
  // Fix: derive sinceUnix from the same UTC midnight as sinceDate so both queries
  // start at the same moment.
  const rawSince = window === 'all' ? null
    : window === '7d' ? Math.floor(Date.now() / 1000) - 7 * 86400
    : Math.floor(Date.now() / 1000) - 30 * 86400

  const sinceDate = rawSince ? new Date(rawSince * 1000).toISOString().slice(0, 10) : null
  // Re-derive sinceUnix from sinceDate so both queries share the same UTC midnight anchor.
  const since = sinceDate ? Math.floor(new Date(sinceDate + 'T00:00:00Z').getTime() / 1000) : null
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
  const total_write = n(totalsRow?.cache_write_tokens)
  // Hit rate (cache-eligible subset only) = cache_read / (cache_read + cache_write).
  // Used as the denominator for the per-row daily breakdown so the chart shows
  // cache quality on cached calls.
  const cache_denominator = total_read + total_write

  // Effective hit rate (full workload) = cache_read / SUM(prompt_tokens) across ALL
  // litellm_usage rows in the window — not just cache-eligible ones. This includes
  // calls that didn't hit cache at all (non-Anthropic, cold cache, etc.).
  // We have to query litellm_usage directly because litellm_cache_daily only
  // aggregates rows where cache_read > 0 OR cache_write > 0.
  const sinceUnix = since ?? null
  const workloadWhereClause = sinceUnix ? `WHERE created_at >= ?` : ''
  const workloadParams: any[] = sinceUnix ? [sinceUnix] : []
  const workloadRow = db.prepare(`
    SELECT
      COALESCE(SUM(prompt_tokens), 0) AS total_prompt_tokens,
      COUNT(*) AS total_calls
    FROM litellm_usage
    ${workloadWhereClause}
  `).get(...workloadParams) as any
  const total_prompt_tokens_workload = n(workloadRow?.total_prompt_tokens)
  const total_calls_workload = n(workloadRow?.total_calls)

  return {
    rows: rows.map(r => {
      const row_read = n(r.cache_read_tokens)
      const row_write = n(r.cache_write_tokens)
      const row_denom = row_read + row_write
      return {
        day: String(r.day),
        model: 'all',
        calls: n(r.calls),
        input_tokens: n(r.input_tokens),
        cache_read_tokens: row_read,
        cache_write_tokens: row_write,
        est_savings_usd: n(r.est_savings_usd),
        hit_rate: row_denom > 0 ? row_read / row_denom : 0,
      }
    }),
    totals: {
      calls: n(totalsRow?.calls),
      input_tokens: n(totalsRow?.input_tokens),
      cache_read_tokens: total_read,
      cache_write_tokens: total_write,
      hit_rate: cache_denominator > 0 ? total_read / cache_denominator : 0,
      effective_hit_rate: total_prompt_tokens_workload > 0
        ? total_read / total_prompt_tokens_workload
        : 0,
      total_prompt_tokens_workload,
      total_calls_workload,
      est_savings_usd: n(totalsRow?.est_savings_usd),
    },
  }
}
