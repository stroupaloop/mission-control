import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// NOTE: The route captures env vars as top-level const at module-load time,
// so we must vi.resetModules() + re-import on each test to pick up env changes.
// This is the same pattern used in src/proxy.test.ts.
// ---------------------------------------------------------------------------

const VALID_TOKEN = 'litellm-token-xyz789'
const FALLBACK_TOKEN = 'audit-fallback-token'

// Shared mock state — reset before each test
let mockRunFn = vi.fn(() => ({ lastInsertRowid: 1, changes: 1 }))
let mockGetFn = vi.fn((): any => ({ count: 0 }))
let mockAllFn = vi.fn((): any[] => [])
let mockPrepareFn = vi.fn(() => ({ run: mockRunFn, get: mockGetFn, all: mockAllFn }))
let mockExecFn = vi.fn()

function resetMocks() {
  mockRunFn = vi.fn(() => ({ lastInsertRowid: 1, changes: 1 }))
  mockGetFn = vi.fn((): any => ({ count: 0, total_calls: 0, total_cost: null, total_prompt_tokens: null, total_completion_tokens: null, avg_latency_ms: null }))
  mockAllFn = vi.fn((): any[] => [])
  mockPrepareFn = vi.fn(() => ({ run: mockRunFn, get: mockGetFn, all: mockAllFn }))
  mockExecFn = vi.fn()
}

function setupMocks() {
  vi.doMock('next/server', () => {
    class MockNextResponse {
      status: number
      body: any
      constructor(body: any, init?: { status?: number }) {
        this.body = body
        this.status = init?.status ?? 200
      }
      static json(data: any, init?: { status?: number }) {
        const r = new MockNextResponse(data, init)
        r.body = data
        return r
      }
    }
    return {
      NextResponse: MockNextResponse,
      NextRequest: class MockNextRequest {
        url: string
        method: string
        headers: Headers
        _body: any
        constructor(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) {
          this.url = url
          this.method = init?.method ?? 'GET'
          this.headers = new Headers(init?.headers ?? {})
          this._body = init?.body
        }
        async json() { return JSON.parse(this._body) }
      },
    }
  })

  vi.doMock('@/lib/db', () => ({
    getDatabase: vi.fn(() => ({
      prepare: mockPrepareFn,
      exec: mockExecFn,
    })),
    logAuditEvent: vi.fn(),
  }))

  vi.doMock('@/lib/logger', () => ({
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  }))

  vi.doMock('@/lib/config', () => ({
    config: { dbPath: ':memory:' },
    ensureDirExists: vi.fn(),
  }))

  vi.doMock('@/lib/migrations', () => ({ runMigrations: vi.fn() }))
  vi.doMock('@/lib/password', () => ({
    hashPassword: vi.fn((p: string) => `hashed:${p}`),
    verifyPassword: vi.fn(() => false),
  }))
  vi.doMock('@/lib/event-bus', () => ({
    eventBus: { broadcast: vi.fn(), on: vi.fn(), emit: vi.fn(), setMaxListeners: vi.fn() },
  }))
  vi.doMock('better-sqlite3', () => ({
    default: vi.fn(() => ({
      prepare: mockPrepareFn,
      pragma: vi.fn(),
      exec: mockExecFn,
      close: vi.fn(),
    })),
  }))
}

function makeRequest(options: { method?: string; url?: string; headers?: Record<string, string>; body?: any }) {
  const { NextRequest } = require('next/server')
  return new NextRequest(options.url ?? 'http://localhost/api/litellm/usage', {
    method: options.method ?? 'POST',
    headers: options.headers ?? {},
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  })
}

describe('POST /api/litellm/usage — LiteLLM Usage Ingest', () => {
  const originalEnv = process.env

  beforeEach(() => {
    resetMocks()
  })

  afterEach(() => {
    process.env = originalEnv
    vi.resetModules()
  })

  it('returns 503 when no ingest token is configured', async () => {
    process.env = { ...originalEnv, MC_LITELLM_INGEST_TOKEN: '', MC_AUDIT_INGEST_TOKEN: '' }
    vi.resetModules()
    setupMocks()
    const { POST } = await import('@/app/api/litellm/usage/route')
    const req = makeRequest({
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
      body: { model: 'gpt-4o', prompt_tokens: 100 },
    })
    const res = await POST(req as any)
    expect(res.status).toBe(503)
    expect(res.body.error).toMatch(/not configured/i)
  })

  it('returns 401 when no auth header provided', async () => {
    process.env = { ...originalEnv, MC_LITELLM_INGEST_TOKEN: VALID_TOKEN }
    vi.resetModules()
    setupMocks()
    const { POST } = await import('@/app/api/litellm/usage/route')
    const req = makeRequest({ body: { model: 'gpt-4o' } })
    const res = await POST(req as any)
    expect(res.status).toBe(401)
    expect(res.body.error).toMatch(/unauthorized/i)
  })

  it('returns 401 when Bearer token is wrong', async () => {
    process.env = { ...originalEnv, MC_LITELLM_INGEST_TOKEN: VALID_TOKEN }
    vi.resetModules()
    setupMocks()
    const { POST } = await import('@/app/api/litellm/usage/route')
    const req = makeRequest({
      headers: { authorization: 'Bearer wrong-token' },
      body: { model: 'gpt-4o' },
    })
    const res = await POST(req as any)
    expect(res.status).toBe(401)
  })

  it('accepts valid MC_LITELLM_INGEST_TOKEN via Bearer auth', async () => {
    process.env = { ...originalEnv, MC_LITELLM_INGEST_TOKEN: VALID_TOKEN }
    vi.resetModules()
    setupMocks()
    const { POST } = await import('@/app/api/litellm/usage/route')
    const req = makeRequest({
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
      body: {
        litellm_call_id: 'call-001',
        model: 'gpt-4o',
        prompt_tokens: 100,
        completion_tokens: 50,
        response_cost: 0.002,
      },
    })
    const res = await POST(req as any)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.ingested).toBe(1)
  })

  it('falls back to MC_AUDIT_INGEST_TOKEN when MC_LITELLM_INGEST_TOKEN is not set', async () => {
    process.env = {
      ...originalEnv,
      MC_LITELLM_INGEST_TOKEN: '',
      MC_AUDIT_INGEST_TOKEN: FALLBACK_TOKEN,
    }
    vi.resetModules()
    setupMocks()
    const { POST } = await import('@/app/api/litellm/usage/route')
    const req = makeRequest({
      headers: { authorization: `Bearer ${FALLBACK_TOKEN}` },
      body: { model: 'claude-3-5-sonnet', prompt_tokens: 200 },
    })
    const res = await POST(req as any)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  it('accepts x-mc-token header as alternative to Authorization', async () => {
    process.env = { ...originalEnv, MC_LITELLM_INGEST_TOKEN: VALID_TOKEN }
    vi.resetModules()
    setupMocks()
    const { POST } = await import('@/app/api/litellm/usage/route')
    const req = makeRequest({
      headers: { 'x-mc-token': VALID_TOKEN },
      body: { model: 'gpt-4o-mini' },
    })
    const res = await POST(req as any)
    expect(res.status).toBe(200)
    expect(res.body.ingested).toBe(1)
  })

  it('accepts an array of usage records and ingests all', async () => {
    process.env = { ...originalEnv, MC_LITELLM_INGEST_TOKEN: VALID_TOKEN }
    vi.resetModules()
    setupMocks()
    const { POST } = await import('@/app/api/litellm/usage/route')
    const records = [
      { model: 'gpt-4o', prompt_tokens: 100, completion_tokens: 50 },
      { model: 'claude-3-5-sonnet', prompt_tokens: 200, completion_tokens: 100 },
      { model: 'gemini-pro', prompt_tokens: 50, completion_tokens: 25 },
    ]
    const req = makeRequest({
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
      body: records,
    })
    const res = await POST(req as any)
    expect(res.status).toBe(200)
    expect(res.body.ingested).toBe(3)
    expect(mockRunFn).toHaveBeenCalledTimes(3)
  })

  it('wraps single object in array automatically', async () => {
    process.env = { ...originalEnv, MC_LITELLM_INGEST_TOKEN: VALID_TOKEN }
    vi.resetModules()
    setupMocks()
    const { POST } = await import('@/app/api/litellm/usage/route')
    const req = makeRequest({
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
      body: { model: 'gpt-4o', prompt_tokens: 10 },
    })
    const res = await POST(req as any)
    expect(res.body.ingested).toBe(1)
  })

  it('returns 400 for invalid JSON', async () => {
    process.env = { ...originalEnv, MC_LITELLM_INGEST_TOKEN: VALID_TOKEN }
    vi.resetModules()
    setupMocks()
    const { NextRequest } = await import('next/server')
    const badReq = new (NextRequest as any)('http://localhost/api/litellm/usage', {
      method: 'POST',
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
      body: '{bad json',
    })
    badReq.json = async () => { throw new SyntaxError('bad json') }
    const { POST } = await import('@/app/api/litellm/usage/route')
    const res = await POST(badReq as any)
    expect(res.status).toBe(400)
  })

  it('computes latency_ms from startTime and endTime', async () => {
    process.env = { ...originalEnv, MC_LITELLM_INGEST_TOKEN: VALID_TOKEN }
    vi.resetModules()
    setupMocks()
    const { POST } = await import('@/app/api/litellm/usage/route')
    const startTime = '2026-04-18T10:00:00.000Z'
    const endTime = '2026-04-18T10:00:01.500Z' // 1500ms later
    const req = makeRequest({
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
      body: { model: 'gpt-4o', startTime, endTime },
    })
    await POST(req as any)
    // stmt.run args: (call_id, call_type, model, model_id, api_base, user_id,
    //   prompt_tokens, completion_tokens, total_tokens, cost,
    //   status, cache_hit, start_time, end_time, latency_ms, metadata)
    // latency_ms is the 15th arg (index 14)
    const runArgs = mockRunFn.mock.calls[0]
    expect(Array.isArray(runArgs)).toBe(true)
    expect(runArgs).toContain(1500)
  })

  it('handles nested usage object (usage.prompt_tokens)', async () => {
    process.env = { ...originalEnv, MC_LITELLM_INGEST_TOKEN: VALID_TOKEN }
    vi.resetModules()
    setupMocks()
    const { POST } = await import('@/app/api/litellm/usage/route')
    const req = makeRequest({
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
      body: {
        model: 'gpt-4o',
        usage: { prompt_tokens: 77, completion_tokens: 33, total_tokens: 110 },
        response_cost: 0.003,
      },
    })
    await POST(req as any)
    const runArgs = mockRunFn.mock.calls[0]
    expect(Array.isArray(runArgs)).toBe(true)
    expect(runArgs).toContain(77)
    expect(runArgs).toContain(33)
  })

  it('skips non-object records in array gracefully', async () => {
    process.env = { ...originalEnv, MC_LITELLM_INGEST_TOKEN: VALID_TOKEN }
    vi.resetModules()
    setupMocks()
    const { POST } = await import('@/app/api/litellm/usage/route')
    const req = makeRequest({
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
      body: [
        { model: 'gpt-4o', prompt_tokens: 50 },
        null,
        'bad-string',
        { model: 'claude-3-5-sonnet', prompt_tokens: 100 },
      ],
    })
    const res = await POST(req as any)
    expect(res.status).toBe(200)
    expect(res.body.ingested).toBe(2)
  })

  it('creates litellm_usage table if not exists (db.exec called)', async () => {
    process.env = { ...originalEnv, MC_LITELLM_INGEST_TOKEN: VALID_TOKEN }
    vi.resetModules()
    setupMocks()
    const { POST } = await import('@/app/api/litellm/usage/route')
    const req = makeRequest({
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
      body: { model: 'gpt-4o' },
    })
    await POST(req as any)
    expect(mockExecFn).toHaveBeenCalledWith(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS litellm_usage'),
    )
  })
})

describe('GET /api/litellm/usage — Query Usage Records', () => {
  const originalEnv = process.env

  beforeEach(() => {
    resetMocks()
  })

  afterEach(() => {
    process.env = originalEnv
    vi.resetModules()
  })

  it('returns 401 without auth token', async () => {
    process.env = { ...originalEnv, MC_LITELLM_INGEST_TOKEN: VALID_TOKEN }
    vi.resetModules()
    setupMocks()
    const { GET } = await import('@/app/api/litellm/usage/route')
    const req = makeRequest({ method: 'GET' })
    const res = await GET(req as any)
    expect(res.status).toBe(401)
  })

  it('returns 401 with wrong token', async () => {
    process.env = { ...originalEnv, MC_LITELLM_INGEST_TOKEN: VALID_TOKEN }
    vi.resetModules()
    setupMocks()
    const { GET } = await import('@/app/api/litellm/usage/route')
    const req = makeRequest({
      method: 'GET',
      headers: { authorization: 'Bearer wrong' },
    })
    const res = await GET(req as any)
    expect(res.status).toBe(401)
  })

  it('returns records and summary with valid auth', async () => {
    process.env = { ...originalEnv, MC_LITELLM_INGEST_TOKEN: VALID_TOKEN }
    vi.resetModules()

    const mockRows = [
      { id: 1, model: 'gpt-4o', prompt_tokens: 100, completion_tokens: 50, response_cost: 0.002 },
    ]
    const mockSummary = {
      total_calls: 1, total_cost: 0.002,
      total_prompt_tokens: 100, total_completion_tokens: 50, avg_latency_ms: 300,
    }

    // First prepare().get() returns {count:1}, second returns summary
    let getCallCount = 0
    mockGetFn = vi.fn(() => {
      getCallCount++
      return getCallCount === 1 ? { count: 1 } : mockSummary
    })
    mockAllFn = vi.fn(() => mockRows)
    mockPrepareFn = vi.fn(() => ({ run: mockRunFn, get: mockGetFn, all: mockAllFn }))
    setupMocks()

    const { GET } = await import('@/app/api/litellm/usage/route')
    const req = makeRequest({
      method: 'GET',
      url: 'http://localhost/api/litellm/usage',
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    })
    const res = await GET(req as any)
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('records')
    expect(res.body).toHaveProperty('summary')
    expect(res.body).toHaveProperty('total')
    expect(res.body).toHaveProperty('limit')
    expect(res.body).toHaveProperty('offset')
  })

  it('applies model filter via query param', async () => {
    process.env = { ...originalEnv, MC_LITELLM_INGEST_TOKEN: VALID_TOKEN }
    vi.resetModules()
    setupMocks()
    const { GET } = await import('@/app/api/litellm/usage/route')
    const req = makeRequest({
      method: 'GET',
      url: 'http://localhost/api/litellm/usage?model=gpt-4o',
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    })
    await GET(req as any)
    // The SQL query built by the route should include model filtering
    // mockPrepareFn.mock.calls contains the SQL strings passed to prepare()
    const allSqlCalls = mockPrepareFn.mock.calls.map((c: any[]) => String(c[0])).join(' ')
    expect(allSqlCalls).toContain('model')
  })

  it('respects limit cap at 1000', async () => {
    process.env = { ...originalEnv, MC_LITELLM_INGEST_TOKEN: VALID_TOKEN }
    vi.resetModules()
    setupMocks()
    const { GET } = await import('@/app/api/litellm/usage/route')
    const req = makeRequest({
      method: 'GET',
      url: 'http://localhost/api/litellm/usage?limit=9999',
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    })
    const res = await GET(req as any)
    expect(res.body.limit).toBe(1000)
  })
})
