import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Use vi.hoisted so mock variables are available inside vi.mock() factories
const { mockLogAuditEvent, mockRequireRole, mockFetch } = vi.hoisted(() => {
  const mockLogAuditEvent = vi.fn()
  const mockRequireRole = vi.fn()
  const mockFetch = vi.fn()
  return { mockLogAuditEvent, mockRequireRole, mockFetch }
})

vi.mock('@/lib/db', () => ({
  getDatabase: vi.fn(),
  logAuditEvent: mockLogAuditEvent,
}))

vi.mock('@/lib/auth', () => ({
  requireRole: mockRequireRole,
}))

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('@/lib/event-bus', () => ({
  eventBus: { broadcast: vi.fn(), on: vi.fn(), emit: vi.fn(), setMaxListeners: vi.fn() },
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

// Replace global fetch with mock
;(globalThis as any).fetch = mockFetch

function makeRequest(options: {
  method?: string
  url?: string
  headers?: Record<string, string>
  body?: any
}) {
  const { NextRequest } = require('next/server')
  return new NextRequest(options.url ?? 'http://localhost/api/oap/approvals', {
    method: options.method ?? 'GET',
    headers: options.headers ?? {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
}

// Simulated OAP sidecar response
function mockOapResponse(data: any, status = 200) {
  mockFetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data),
  })
}

describe('GET /api/oap/approvals — List Pending Approvals', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      OAP_SIDECAR_BASE_URL: 'http://localhost:8443',
    }
    vi.clearAllMocks()
    // Default: operator auth succeeds
    mockRequireRole.mockReturnValue({ user: { username: 'operator-1', role: 'operator' } })
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('returns 401/403 when auth check fails', async () => {
    mockRequireRole.mockReturnValue({ error: 'Authentication required', status: 401 })

    const { GET } = await import('@/app/api/oap/approvals/route')
    const req = makeRequest({ method: 'GET' })
    const res = await GET(req as any)
    expect(res.status).toBe(401)
  })

  it('proxies GET to OAP sidecar /approvals/pending', async () => {
    const pendingApprovals = {
      pending: [
        { decision_id: 'dec-001', capability: 'exec', reason: 'shell_exec', expires_at: 9999999 },
      ],
    }
    mockOapResponse(pendingApprovals)

    const { GET } = await import('@/app/api/oap/approvals/route')
    const req = makeRequest({ method: 'GET' })
    const res = await GET(req as any)

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/approvals/pending'),
      expect.objectContaining({ method: 'GET' }),
    )
    expect(res.status).toBe(200)
    expect(res.body).toEqual(pendingApprovals)
  })

  it('returns 502 when OAP sidecar is unreachable (fetch throws)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'))

    const { GET } = await import('@/app/api/oap/approvals/route')
    const req = makeRequest({ method: 'GET' })
    const res = await GET(req as any)

    expect(res.status).toBe(502)
    expect(res.body.error).toMatch(/sidecar unreachable/i)
  })

  it('returns 502 when AbortSignal times out', async () => {
    mockFetch.mockRejectedValueOnce(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))

    const { GET } = await import('@/app/api/oap/approvals/route')
    const req = makeRequest({ method: 'GET' })
    const res = await GET(req as any)

    expect(res.status).toBe(502)
  })

  it('forwards non-200 OAP sidecar status codes correctly', async () => {
    mockOapResponse({ error: 'Internal sidecar error' }, 503)

    const { GET } = await import('@/app/api/oap/approvals/route')
    const req = makeRequest({ method: 'GET' })
    const res = await GET(req as any)

    expect(res.status).toBe(503)
  })

  it('uses OAP_SIDECAR_BASE_URL env var for the upstream URL', async () => {
    process.env.OAP_SIDECAR_BASE_URL = 'http://oap-sidecar.internal:9000'
    mockOapResponse({ pending: [] })

    const { GET } = await import('@/app/api/oap/approvals/route')
    const req = makeRequest({ method: 'GET' })
    await GET(req as any)

    expect(mockFetch).toHaveBeenCalledWith(
      'http://oap-sidecar.internal:9000/approvals/pending',
      expect.any(Object),
    )
  })

  it('falls back to default OAP URL when env var is not set', async () => {
    delete process.env.OAP_SIDECAR_BASE_URL
    mockOapResponse({ pending: [] })

    const { GET } = await import('@/app/api/oap/approvals/route')
    const req = makeRequest({ method: 'GET' })
    await GET(req as any)

    expect(mockFetch).toHaveBeenCalledWith(
      'http://host.docker.internal:8443/approvals/pending',
      expect.any(Object),
    )
  })

  it('returns empty pending array when OAP returns null body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '', // empty body
    })

    const { GET } = await import('@/app/api/oap/approvals/route')
    const req = makeRequest({ method: 'GET' })
    const res = await GET(req as any)
    expect(res.status).toBe(200)
    // Should return { pending: [] } as the default
    expect(res.body).toEqual({ pending: [] })
  })
})

describe('POST /api/oap/approvals — Action an Approval', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      OAP_SIDECAR_BASE_URL: 'http://localhost:8443',
      MC_TG_BOT_TOKEN: '',
      TELEGRAM_BOT_TOKEN: '',
    }
    vi.clearAllMocks()
    mockRequireRole.mockReturnValue({ user: { username: 'operator-1', role: 'operator' } })
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('returns 401/403 when auth check fails', async () => {
    mockRequireRole.mockReturnValue({ error: 'Unauthorized', status: 401 })

    const { POST } = await import('@/app/api/oap/approvals/route')
    const req = makeRequest({
      method: 'POST',
      body: { decision_id: 'dec-001', action: 'approve' },
    })
    const res = await POST(req as any)
    expect(res.status).toBe(401)
  })

  it('returns 400 for missing decision_id', async () => {
    const { POST } = await import('@/app/api/oap/approvals/route')
    const req = makeRequest({
      method: 'POST',
      body: { action: 'approve' }, // no decision_id
    })
    const res = await POST(req as any)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/decision_id/i)
  })

  it('returns 400 for invalid action value', async () => {
    const { POST } = await import('@/app/api/oap/approvals/route')
    const req = makeRequest({
      method: 'POST',
      body: { decision_id: 'dec-001', action: 'invalid-action' },
    })
    const res = await POST(req as any)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/action/i)
  })

  it('returns 400 for missing action', async () => {
    const { POST } = await import('@/app/api/oap/approvals/route')
    const req = makeRequest({
      method: 'POST',
      body: { decision_id: 'dec-001' }, // no action
    })
    const res = await POST(req as any)
    expect(res.status).toBe(400)
  })

  it('returns 400 for invalid JSON body', async () => {
    const { NextRequest } = await import('next/server')
    const badReq = new (NextRequest as any)('http://localhost/api/oap/approvals', {
      method: 'POST',
      body: 'not-json',
    })
    badReq.json = async () => { throw new SyntaxError('bad json') }

    const { POST } = await import('@/app/api/oap/approvals/route')
    const res = await POST(badReq as any)
    expect(res.status).toBe(400)
  })

  it('accepts "approve" action and forwards to OAP sidecar', async () => {
    mockOapResponse({ ok: true, capability: 'exec' })

    const { POST } = await import('@/app/api/oap/approvals/route')
    const req = makeRequest({
      method: 'POST',
      body: { decision_id: 'dec-001', action: 'approve' },
    })
    const res = await POST(req as any)

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/approve'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ decision_id: 'dec-001', action: 'approve' }),
      }),
    )
    expect(res.status).toBe(200)
  })

  it('accepts "deny" action', async () => {
    mockOapResponse({ ok: true })

    const { POST } = await import('@/app/api/oap/approvals/route')
    const req = makeRequest({
      method: 'POST',
      body: { decision_id: 'dec-002', action: 'deny' },
    })
    const res = await POST(req as any)
    expect(res.status).toBe(200)
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({ decision_id: 'dec-002', action: 'deny' }),
      }),
    )
  })

  it('accepts "approve_and_add" action', async () => {
    mockOapResponse({ ok: true })

    const { POST } = await import('@/app/api/oap/approvals/route')
    const req = makeRequest({
      method: 'POST',
      body: { decision_id: 'dec-003', action: 'approve_and_add' },
    })
    const res = await POST(req as any)
    expect(res.status).toBe(200)
  })

  it('calls logAuditEvent after successful OAP sidecar response', async () => {
    mockOapResponse({ ok: true, capability: 'file_read' })

    const { POST } = await import('@/app/api/oap/approvals/route')
    const req = makeRequest({
      method: 'POST',
      body: { decision_id: 'dec-audit', action: 'approve' },
    })
    await POST(req as any)

    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'oap_approve',
        actor: 'operator-1',
        target_type: 'decision',
        detail: expect.objectContaining({
          decision_id: 'dec-audit',
          action: 'approve',
          capability: 'file_read',
          source: 'mission-control',
        }),
      }),
    )
  })

  it('does NOT call logAuditEvent when OAP sidecar returns non-OK status', async () => {
    mockOapResponse({ error: 'Decision not found' }, 404)

    const { POST } = await import('@/app/api/oap/approvals/route')
    const req = makeRequest({
      method: 'POST',
      body: { decision_id: 'dec-notfound', action: 'deny' },
    })
    const res = await POST(req as any)

    expect(res.status).toBe(404)
    expect(mockLogAuditEvent).not.toHaveBeenCalled()
  })

  it('returns 502 when OAP sidecar is unreachable', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'))

    const { POST } = await import('@/app/api/oap/approvals/route')
    const req = makeRequest({
      method: 'POST',
      body: { decision_id: 'dec-down', action: 'approve' },
    })
    const res = await POST(req as any)
    expect(res.status).toBe(502)
    expect(res.body.error).toMatch(/sidecar unreachable/i)
  })

  it('uses actor username from auth in the audit log', async () => {
    mockRequireRole.mockReturnValue({ user: { username: 'admin-user', role: 'admin' } })
    mockOapResponse({ ok: true })

    const { POST } = await import('@/app/api/oap/approvals/route')
    const req = makeRequest({
      method: 'POST',
      body: { decision_id: 'dec-actor', action: 'deny' },
    })
    await POST(req as any)

    expect(mockLogAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ actor: 'admin-user' }),
    )
  })
})
