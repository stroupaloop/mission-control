import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import Database from 'better-sqlite3'
import { ensureLitellmUsageTable } from '@/extensions/litellm/usage'

// In-memory DB shared across tests in this file. We mock @/lib/db.getDatabase
// to return this instance.
let db: Database.Database

vi.mock('@/lib/db', () => ({
  getDatabase: () => db,
}))

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

function makeRequest(url: string, headers?: Record<string, string>): NextRequest {
  return new NextRequest(url, { headers: headers || {} } as any)
}

function seed(rows: Partial<any>[]) {
  ensureLitellmUsageTable(db)
  const stmt = db.prepare(`
    INSERT INTO litellm_usage (
      call_id, call_type, model, user_id,
      prompt_tokens, completion_tokens, total_tokens, response_cost,
      status, cache_hit, latency_ms, created_at
    ) VALUES (?, 'completion', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const r of rows) {
    stmt.run(
      r.call_id ?? null,
      r.model ?? 'anthropic/claude-opus-4-7',
      r.user_id ?? 'tester',
      r.prompt_tokens ?? 100,
      r.completion_tokens ?? 50,
      r.total_tokens ?? 150,
      r.response_cost ?? 0.01,
      r.status ?? 'success',
      r.cache_hit ?? 0,
      r.latency_ms ?? 1000,
      r.created_at ?? Math.floor(Date.now() / 1000)
    )
  }
}

beforeEach(() => {
  db = new Database(':memory:')
  vi.resetModules()
  process.env.MC_LITELLM_INGEST_TOKEN = 'test-token-123'
})

afterEach(() => {
  try { db.close() } catch {}
  vi.clearAllMocks()
})

describe('GET /api/litellm/usage/summary', () => {
  it('returns 401 without a token', async () => {
    const mod = await import('../api/usage-summary')
    const res = await mod.GET(makeRequest('http://localhost/api/litellm/usage/summary?window=24h'))
    expect(res.status).toBe(401)
  })

  it('returns 401 with wrong token', async () => {
    const mod = await import('../api/usage-summary')
    const res = await mod.GET(
      makeRequest('http://localhost/api/litellm/usage/summary?window=24h', {
        authorization: 'Bearer wrong-token',
      })
    )
    expect(res.status).toBe(401)
  })

  it('returns empty totals with valid token and no data', async () => {
    const mod = await import('../api/usage-summary')
    const res = await mod.GET(
      makeRequest('http://localhost/api/litellm/usage/summary?window=24h', {
        authorization: 'Bearer test-token-123',
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.window).toBe('24h')
    expect(body.totals.calls).toBe(0)
    expect(body.by_model).toEqual([])
  })

  it('accepts x-mc-token header as well', async () => {
    const mod = await import('../api/usage-summary')
    const res = await mod.GET(
      makeRequest('http://localhost/api/litellm/usage/summary', {
        'x-mc-token': 'test-token-123',
      })
    )
    expect(res.status).toBe(200)
  })

  it('aggregates totals correctly with seeded data', async () => {
    seed([
      { response_cost: 1.0, total_tokens: 150, latency_ms: 1000, status: 'success' },
      { response_cost: 2.0, total_tokens: 300, latency_ms: 3000, status: 'success' },
      { response_cost: 0.5, total_tokens: 75, latency_ms: 500, status: 'failure' },
    ])
    const mod = await import('../api/usage-summary')
    const res = await mod.GET(
      makeRequest('http://localhost/api/litellm/usage/summary?window=24h', {
        authorization: 'Bearer test-token-123',
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.totals.calls).toBe(3)
    expect(body.totals.cost_usd).toBeCloseTo(3.5)
    expect(body.totals.total_tokens).toBe(525)
    expect(body.totals.error_rate).toBeCloseTo(1 / 3, 5)
  })

  it('by_model is sorted by cost desc and capped at 20', async () => {
    const rows = Array.from({ length: 25 }).map((_, i) => ({
      model: `m-${String(i).padStart(2, '0')}`,
      response_cost: i * 0.1,
    }))
    seed(rows)
    const mod = await import('../api/usage-summary')
    const res = await mod.GET(
      makeRequest('http://localhost/api/litellm/usage/summary?window=24h', {
        authorization: 'Bearer test-token-123',
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.by_model.length).toBe(20)
    expect(body.by_model[0].model).toBe('m-24')
  })

  it('window=all has no by_hour bucketing', async () => {
    seed([{ response_cost: 1.0 }])
    const mod = await import('../api/usage-summary')
    const res = await mod.GET(
      makeRequest('http://localhost/api/litellm/usage/summary?window=all', {
        authorization: 'Bearer test-token-123',
      })
    )
    const body = await res.json()
    expect(body.window).toBe('all')
    expect(body.by_hour).toEqual([])
  })

  it('filters older records out of 24h window', async () => {
    const now = Math.floor(Date.now() / 1000)
    seed([
      { response_cost: 1.0, created_at: now - 60 },
      { response_cost: 99.0, created_at: now - 25 * 3600 },
    ])
    const mod = await import('../api/usage-summary')
    const res = await mod.GET(
      makeRequest('http://localhost/api/litellm/usage/summary?window=24h', {
        authorization: 'Bearer test-token-123',
      })
    )
    const body = await res.json()
    expect(body.totals.calls).toBe(1)
    expect(body.totals.cost_usd).toBeCloseTo(1.0)
  })
})
