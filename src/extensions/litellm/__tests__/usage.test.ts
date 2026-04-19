import { describe, expect, it, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  bucketGranularity,
  bucketStrftimeFormat,
  computeUsageSummary,
  ensureLitellmUsageTable,
  parseWindow,
  queryUsageRecords,
  windowSinceSeconds,
} from '../usage'

function seed(db: Database.Database, rows: Partial<any>[]) {
  ensureLitellmUsageTable(db)
  const stmt = db.prepare(`
    INSERT INTO litellm_usage (
      call_id, call_type, model, model_id, api_base, user_id,
      prompt_tokens, completion_tokens, total_tokens, response_cost,
      status, cache_hit, start_time, end_time, latency_ms, metadata, created_at
    ) VALUES (
      @call_id, @call_type, @model, @model_id, @api_base, @user_id,
      @prompt_tokens, @completion_tokens, @total_tokens, @response_cost,
      @status, @cache_hit, @start_time, @end_time, @latency_ms, @metadata, @created_at
    )
  `)
  for (const r of rows) {
    stmt.run({
      call_id: null,
      call_type: 'completion',
      model: 'anthropic/claude-opus-4-7',
      model_id: null,
      api_base: null,
      user_id: 'tester',
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      response_cost: 0.01,
      status: 'success',
      cache_hit: 0,
      start_time: null,
      end_time: null,
      latency_ms: 1000,
      metadata: null,
      created_at: Math.floor(Date.now() / 1000),
      ...r,
    })
  }
}

describe('parseWindow', () => {
  it('normalizes known values', () => {
    expect(parseWindow('24h')).toBe('24h')
    expect(parseWindow('7D')).toBe('7d')
    expect(parseWindow('30d')).toBe('30d')
    expect(parseWindow('all')).toBe('all')
  })
  it('defaults to 24h for unknown / missing', () => {
    expect(parseWindow(null)).toBe('24h')
    expect(parseWindow('garbage')).toBe('24h')
    expect(parseWindow('')).toBe('24h')
  })
})

describe('bucket helpers', () => {
  it('24h and 7d use hour buckets, 30d uses day, all has no bucketing', () => {
    expect(bucketGranularity('24h')).toBe('hour')
    expect(bucketGranularity('7d')).toBe('hour')
    expect(bucketGranularity('30d')).toBe('day')
    expect(bucketGranularity('all')).toBe(null)
  })
  it('bucketStrftimeFormat returns correct strftime spec', () => {
    expect(bucketStrftimeFormat('hour')).toBe('%Y-%m-%dT%H')
    expect(bucketStrftimeFormat('day')).toBe('%Y-%m-%d')
  })
  it('windowSinceSeconds returns cutoffs in seconds relative to now', () => {
    const now = 1_000_000_000
    expect(windowSinceSeconds('24h', now)).toBe(now - 24 * 3600)
    expect(windowSinceSeconds('7d', now)).toBe(now - 7 * 24 * 3600)
    expect(windowSinceSeconds('30d', now)).toBe(now - 30 * 24 * 3600)
    expect(windowSinceSeconds('all', now)).toBeNull()
  })
})

describe('computeUsageSummary', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
  })

  it('returns empty totals on empty table', () => {
    const s = computeUsageSummary(db, '24h')
    expect(s.totals.calls).toBe(0)
    expect(s.totals.cost_usd).toBe(0)
    expect(s.by_model).toEqual([])
    expect(s.by_user).toEqual([])
  })

  it('aggregates totals correctly', () => {
    const now = Math.floor(Date.now() / 1000)
    seed(db, [
      { response_cost: 1.0, prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, latency_ms: 1000, status: 'success', cache_hit: 1, created_at: now - 60 },
      { response_cost: 2.0, prompt_tokens: 200, completion_tokens: 100, total_tokens: 300, latency_ms: 3000, status: 'success', cache_hit: 0, created_at: now - 120 },
      { response_cost: 0.5, prompt_tokens: 50, completion_tokens: 25, total_tokens: 75, latency_ms: 500, status: 'failure', cache_hit: 0, created_at: now - 180 },
    ])
    const s = computeUsageSummary(db, '24h')
    expect(s.totals.calls).toBe(3)
    expect(s.totals.cost_usd).toBeCloseTo(3.5)
    expect(s.totals.prompt_tokens).toBe(350)
    expect(s.totals.completion_tokens).toBe(175)
    expect(s.totals.total_tokens).toBe(525)
    expect(s.totals.avg_latency_ms).toBeCloseTo(1500)
    expect(s.totals.cache_hit_rate).toBeCloseTo(1 / 3, 5)
    expect(s.totals.error_rate).toBeCloseTo(1 / 3, 5)
    expect(s.totals.success_rate).toBeCloseTo(2 / 3, 5)
  })

  it('by_model is sorted by cost desc and capped at 20', () => {
    const now = Math.floor(Date.now() / 1000)
    // 25 distinct models
    const rows = Array.from({ length: 25 }).map((_, i) => ({
      model: `model-${String(i).padStart(2, '0')}`,
      response_cost: i * 0.1,
      created_at: now - 60,
    }))
    seed(db, rows)
    const s = computeUsageSummary(db, '24h')
    expect(s.by_model.length).toBe(20)
    // Highest cost first
    expect(s.by_model[0].model).toBe('model-24')
    for (let i = 1; i < s.by_model.length; i++) {
      expect(s.by_model[i - 1].cost_usd).toBeGreaterThanOrEqual(s.by_model[i].cost_usd)
    }
  })

  it('window filter excludes records older than cutoff', () => {
    const now = Math.floor(Date.now() / 1000)
    seed(db, [
      { response_cost: 1.0, created_at: now - 60 }, // in window
      { response_cost: 99.0, created_at: now - (25 * 3600) }, // out of 24h window
    ])
    const s24 = computeUsageSummary(db, '24h')
    expect(s24.totals.calls).toBe(1)
    expect(s24.totals.cost_usd).toBeCloseTo(1.0)

    const sAll = computeUsageSummary(db, 'all')
    expect(sAll.totals.calls).toBe(2)
    expect(sAll.totals.cost_usd).toBeCloseTo(100.0)
    // 'all' has no time bucketing
    expect(sAll.by_hour).toEqual([])
  })

  it('error_rate counts status != success', () => {
    const now = Math.floor(Date.now() / 1000)
    seed(db, [
      { status: 'success', created_at: now - 10 },
      { status: 'failure', created_at: now - 10 },
      { status: 'timeout', created_at: now - 10 },
      { status: 'success', created_at: now - 10 },
    ])
    const s = computeUsageSummary(db, '24h')
    expect(s.totals.error_rate).toBeCloseTo(0.5)
    expect(s.totals.success_rate).toBeCloseTo(0.5)
  })

  it('by_hour buckets for 24h window', () => {
    const now = Math.floor(Date.now() / 1000)
    seed(db, [
      { response_cost: 0.1, created_at: now - 60 },
      { response_cost: 0.2, created_at: now - 120 },
      { response_cost: 0.3, created_at: now - 3700 }, // next hour bucket
    ])
    const s = computeUsageSummary(db, '24h')
    expect(s.by_hour.length).toBeGreaterThanOrEqual(1)
    // Each bucket format is YYYY-MM-DDTHH
    for (const b of s.by_hour) {
      expect(b.bucket).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}$/)
    }
  })

  it('by_hour buckets for 30d are day-formatted', () => {
    const now = Math.floor(Date.now() / 1000)
    seed(db, [{ response_cost: 0.1, created_at: now - 60 }])
    const s = computeUsageSummary(db, '30d')
    expect(s.by_hour.length).toBeGreaterThan(0)
    for (const b of s.by_hour) {
      expect(b.bucket).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })
})

describe('queryUsageRecords', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
  })

  it('returns empty result on empty table', () => {
    const r = queryUsageRecords(db, {})
    expect(r.records).toEqual([])
    expect(r.total).toBe(0)
  })

  it('respects limit/offset and filters by model', () => {
    const now = Math.floor(Date.now() / 1000)
    const rows = Array.from({ length: 5 }).map((_, i) => ({
      model: i % 2 === 0 ? 'gpt-5' : 'claude-opus',
      response_cost: i * 0.1,
      created_at: now - i,
    }))
    seed(db, rows)
    const r = queryUsageRecords(db, { model: 'gpt', limit: 10, offset: 0 })
    expect(r.total).toBe(3)
    expect(r.records.every(x => x.model?.includes('gpt'))).toBe(true)
  })

  it('caps limit at 1000', () => {
    seed(db, [{ created_at: Math.floor(Date.now() / 1000) }])
    const r = queryUsageRecords(db, { limit: 999999 })
    expect(r.limit).toBe(1000)
  })
})
