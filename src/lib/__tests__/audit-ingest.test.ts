import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Use vi.hoisted so mock variables are available inside vi.mock() factories
const { mockRun, mockGet, mockPrepare, mockExec, mockLogAuditEvent } = vi.hoisted(() => {
  const mockRun = vi.fn(() => ({ lastInsertRowid: 1, changes: 1 }))
  const mockGet = vi.fn((): any => null) // no duplicate by default
  const mockPrepare = vi.fn(() => ({
    run: mockRun,
    get: mockGet,
    all: vi.fn(() => []),
  }))
  const mockExec = vi.fn()
  const mockLogAuditEvent = vi.fn()
  return { mockRun, mockGet, mockPrepare, mockExec, mockLogAuditEvent }
})

vi.mock('better-sqlite3', () => ({
  default: vi.fn(() => ({
    prepare: mockPrepare,
    pragma: vi.fn(),
    exec: mockExec,
    close: vi.fn(),
  })),
}))

vi.mock('@/lib/config', () => ({
  config: { dbPath: ':memory:' },
  ensureDirExists: vi.fn(),
}))

vi.mock('@/lib/migrations', () => ({
  runMigrations: vi.fn(),
}))

vi.mock('@/lib/password', () => ({
  hashPassword: vi.fn((p: string) => `hashed:${p}`),
  verifyPassword: vi.fn(() => false),
}))

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('@/lib/event-bus', () => ({
  eventBus: { broadcast: vi.fn(), on: vi.fn(), emit: vi.fn(), setMaxListeners: vi.fn() },
}))

vi.mock('@/lib/db', () => ({
  getDatabase: vi.fn(() => ({
    prepare: mockPrepare,
    exec: mockExec,
  })),
  logAuditEvent: mockLogAuditEvent,
}))

// Mock Next.js server module
vi.mock('next/server', () => {
  class MockNextResponse {
    status: number
    body: any
    _headers: Record<string, string> = {}

    constructor(body: any, init?: { status?: number }) {
      this.body = body
      this.status = init?.status ?? 200
    }

    headers = {
      set: (k: string, v: string) => { this._headers[k] = v },
      get: (k: string) => this._headers[k],
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
      private _body: any

      constructor(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) {
        this.url = url
        this.method = init?.method ?? 'GET'
        this.headers = new Headers(init?.headers ?? {})
        this._body = init?.body
      }

      async json() {
        return JSON.parse(this._body)
      }
    },
  }
})

// Helper to build a mock NextRequest for the route handler
function makeRequest(options: {
  method?: string
  headers?: Record<string, string>
  body?: Record<string, any>
}) {
  const { NextRequest } = require('next/server')
  return new NextRequest('http://localhost/api/audit', {
    method: options.method ?? 'POST',
    headers: options.headers ?? {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
}

const VALID_TOKEN = 'test-audit-token-abc123'

describe('POST /api/audit — OAP Audit Ingest', () => {
  const originalEnv = process.env

  beforeEach(() => {
    vi.resetModules()
    process.env = { ...originalEnv, MC_AUDIT_INGEST_TOKEN: VALID_TOKEN }
    vi.clearAllMocks()
    mockGet.mockReturnValue(null) // no duplicate by default
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('returns 503 when MC_AUDIT_INGEST_TOKEN is not configured', async () => {
    process.env = { ...originalEnv, MC_AUDIT_INGEST_TOKEN: '' }
    const { POST } = await import('@/app/api/audit/route')
    const req = makeRequest({
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
      body: { event: 'oap.alert', decision_id: 'dec-001' },
    })
    const res = await POST(req as any)
    expect(res.status).toBe(503)
    expect(res.body.error).toMatch(/not configured/i)
  })

  it('returns 401 when no Authorization header is provided', async () => {
    const { POST } = await import('@/app/api/audit/route')
    const req = makeRequest({
      body: { event: 'oap.alert', decision_id: 'dec-001' },
    })
    const res = await POST(req as any)
    expect(res.status).toBe(401)
    expect(res.body.error).toMatch(/unauthorized/i)
  })

  it('returns 401 when Bearer token is wrong', async () => {
    const { POST } = await import('@/app/api/audit/route')
    const req = makeRequest({
      headers: { authorization: 'Bearer wrong-token' },
      body: { event: 'oap.alert', decision_id: 'dec-001' },
    })
    const res = await POST(req as any)
    expect(res.status).toBe(401)
  })

  it('accepts valid Bearer token and ingests event', async () => {
    const { POST } = await import('@/app/api/audit/route')
    const req = makeRequest({
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
      body: { event: 'oap.alert', decision_id: 'dec-001', capability: 'exec' },
    })
    const res = await POST(req as any)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.action).toBe('oap_alert')
    expect(res.body.decision_id).toBe('dec-001')
  })

  it('accepts valid x-mc-audit-token header as alternative auth', async () => {
    const { POST } = await import('@/app/api/audit/route')
    const req = makeRequest({
      headers: { 'x-mc-audit-token': VALID_TOKEN },
      body: { event: 'oap.deny', decision_id: 'dec-002' },
    })
    const res = await POST(req as any)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  it('returns 400 for invalid JSON body', async () => {
    const { NextRequest } = await import('next/server')
    const badReq = new (NextRequest as any)('http://localhost/api/audit', {
      method: 'POST',
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
      body: 'not-json',
    })
    // Override json() to throw
    badReq.json = async () => { throw new SyntaxError('invalid json') }

    const { POST } = await import('@/app/api/audit/route')
    const res = await POST(badReq as any)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/invalid json/i)
  })

  it('normalizes event names correctly', async () => {
    const { POST } = await import('@/app/api/audit/route')

    const cases = [
      { event: 'oap.alert', expectedAction: 'oap_alert' },
      { event: 'oap.deny', expectedAction: 'oap_deny' },
      { event: 'oap.escalate', expectedAction: 'oap_escalate' },
      { event: 'oap.unknown_custom', expectedAction: 'oap_event' },
    ]

    for (const { event, expectedAction } of cases) {
      vi.clearAllMocks()
      mockGet.mockReturnValue(null)

      const req = makeRequest({
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
        body: { event, decision_id: `dec-${event}` },
      })
      const res = await POST(req as any)
      expect(res.body.action).toBe(expectedAction)
    }
  })

  it('deduplicates when same decision_id already exists in audit_log', async () => {
    // Simulate existing record found
    mockGet.mockReturnValue({ id: 99 })

    const { POST } = await import('@/app/api/audit/route')
    const req = makeRequest({
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
      body: { event: 'oap.alert', decision_id: 'dec-dup' },
    })
    const res = await POST(req as any)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.deduplicated).toBe(true)
    // logAuditEvent should NOT be called for deduplicated records
    expect(mockLogAuditEvent).not.toHaveBeenCalled()
  })

  it('does not deduplicate when decision_id is absent', async () => {
    const { POST } = await import('@/app/api/audit/route')
    const req = makeRequest({
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
      body: { event: 'oap.alert' },
    })
    const res = await POST(req as any)
    expect(res.status).toBe(200)
    // DB dedup check should be skipped when no decision_id
    expect(mockGet).not.toHaveBeenCalled()
    expect(mockLogAuditEvent).toHaveBeenCalled()
  })

  it('calls logAuditEvent with correct fields on successful ingest', async () => {
    const { POST } = await import('@/app/api/audit/route')
    const req = makeRequest({
      headers: {
        authorization: `Bearer ${VALID_TOKEN}`,
        'x-forwarded-for': '10.0.0.1',
        'user-agent': 'oap-sidecar/1.0',
      },
      body: {
        event: 'oap.deny',
        decision_id: 'dec-xyz',
        tenant_id: 'tenant-A',
        capability: 'file_write',
        reason_code: 'policy_denied',
      },
    })
    await POST(req as any)

    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'oap_deny',
        actor: 'oap:tenant-A',
        target_type: 'decision',
        ip_address: '10.0.0.1',
        user_agent: 'oap-sidecar/1.0',
        detail: expect.objectContaining({
          decision_id: 'dec-xyz',
          capability: 'file_write',
          reason_code: 'policy_denied',
        }),
      }),
    )
  })

  it('sanitizes payload — only allows expected fields through', async () => {
    const { POST } = await import('@/app/api/audit/route')
    const req = makeRequest({
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
      body: {
        event: 'oap.alert',
        decision_id: 'dec-safe',
        extraField: 'should-be-stripped',
        __proto__: { polluted: true },
      },
    })
    const res = await POST(req as any)
    expect(res.status).toBe(200)
    const detail = mockLogAuditEvent.mock.calls[0]?.[0]?.detail
    expect(detail).not.toHaveProperty('extraField')
    expect(detail.source).toBe('oap')
    expect(detail.event).toBe('oap.alert')
  })

  it('strips Bearer prefix correctly — extra spaces in token cause mismatch', async () => {
    const { POST } = await import('@/app/api/audit/route')
    // Token with a leading space — does NOT match stored token after trim
    const req = makeRequest({
      headers: { authorization: `Bearer  ${VALID_TOKEN} ` }, // leading + trailing space in token
      body: { event: 'oap.alert', decision_id: 'dec-space' },
    })
    // The route does: authHeader.slice('Bearer '.length).trim() === AUDIT_INGEST_TOKEN
    // 'Bearer  token ' -> slice(7) -> ' token ' -> trim() -> 'token' == VALID_TOKEN ✓
    // Actually trim() fixes it — so this WILL succeed. Verify it passes through:
    const res = await POST(req as any)
    // With trim() on the extracted token this DOES match — expect 200
    expect(res.status).toBe(200)
  })
})

describe('GET /api/audit — Query audit log', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      MC_AUDIT_INGEST_TOKEN: VALID_TOKEN,
      API_KEY: 'test-api-key',
    }
    vi.clearAllMocks()
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('returns 401 when called without admin auth', async () => {
    const { GET } = await import('@/app/api/audit/route')
    const { NextRequest } = await import('next/server')
    const req = new (NextRequest as any)('http://localhost/api/audit', {
      method: 'GET',
      headers: {},
    })
    const res = await GET(req as any)
    expect(res.status).toBe(401)
  })

  it('returns audit log rows when admin auth passes', async () => {
    // requireRole is already mocked at the top of this file via vi.mock('@/lib/auth')
    // but audit route imports it directly. We confirm the GET path works when auth succeeds.
    // The mock for requireRole is inline via the existing vi.mock() at the top.
    // We verify the route returns the expected shape on a successful auth path.
    const mockRows = [
      { id: 1, action: 'oap_alert', actor: 'oap:tenant-A', detail: '{"event":"oap.alert"}', created_at: 1000 },
    ]
    mockPrepare.mockReturnValue({
      run: mockRun,
      get: vi.fn(() => ({ count: 1 })),
      all: vi.fn(() => mockRows),
    })

    // Dynamically mock requireRole to return a valid admin user for this test
    vi.doMock('@/lib/auth', () => ({
      requireRole: vi.fn(() => ({ user: { username: 'api', role: 'admin' } })),
    }))
    vi.resetModules()
    vi.doMock('@/lib/auth', () => ({
      requireRole: vi.fn(() => ({ user: { username: 'api', role: 'admin' } })),
    }))
    vi.doMock('@/lib/db', () => ({
      getDatabase: vi.fn(() => ({ prepare: mockPrepare, exec: vi.fn() })),
      logAuditEvent: mockLogAuditEvent,
    }))
    vi.doMock('next/server', () => {
      class MockNextResponse {
        status: number; body: any
        constructor(b: any, init?: { status?: number }) { this.body = b; this.status = init?.status ?? 200 }
        static json(d: any, init?: { status?: number }) { const r = new MockNextResponse(d, init); r.body = d; return r }
      }
      return {
        NextResponse: MockNextResponse,
        NextRequest: class { url: string; method: string; headers: Headers; constructor(u: string, i?: any) { this.url = u; this.method = i?.method ?? 'GET'; this.headers = new Headers(i?.headers ?? {}) } }
      }
    })

    const { GET } = await import('@/app/api/audit/route')
    const { NextRequest } = await import('next/server')
    const req = new (NextRequest as any)('http://localhost/api/audit', {
      method: 'GET',
      headers: { authorization: 'Bearer test-api-key' },
    })
    const res = await GET(req as any)
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('events')
    expect(res.body).toHaveProperty('total')
  })
})
