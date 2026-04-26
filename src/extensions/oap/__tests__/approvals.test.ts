import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({
  requireRole: vi.fn(() => ({ user: { username: 'tester', role: 'operator' } })),
}))

vi.mock('@/lib/db', () => ({
  logAuditEvent: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

let fetchMock: any

beforeEach(() => {
  vi.resetModules()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  delete process.env.TELEGRAM_BOT_TOKEN
  delete process.env.MC_TG_BOT_TOKEN
  delete process.env.MC_TG_ESCALATION_CHAT_ID
  delete process.env.MC_TG_ESCALATION_THREAD_ID
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function makeRequest(url: string, init?: RequestInit): NextRequest {
  return new NextRequest(url, init as any)
}

describe('GET /api/oap/approvals', () => {
  it('returns the pending list proxied from the sidecar', async () => {
    const pending = [
      { decision_id: 'd1', capability: 'exec:read:filesystem', risk: 'low' },
      { decision_id: 'd2', capability: 'net:outbound', risk: 'medium' },
    ]
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ pending }),
    })

    const mod = await import('../api/approvals')
    const res = await mod.GET(makeRequest('http://localhost/api/oap/approvals'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toEqual({ pending })
  })

  it('returns 502 if the sidecar is unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const mod = await import('../api/approvals')
    const res = await mod.GET(makeRequest('http://localhost/api/oap/approvals'))
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error).toMatch(/unreachable/i)
  })
})

describe('POST /api/oap/approvals', () => {
  it('forwards a valid approve action to the sidecar and returns 200', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, capability: 'exec:read:filesystem' }),
    })

    const mod = await import('../api/approvals')
    const res = await mod.POST(
      makeRequest('http://localhost/api/oap/approvals', {
        method: 'POST',
        body: JSON.stringify({ decision_id: 'd1', action: 'approve' }),
        headers: { 'Content-Type': 'application/json' },
      })
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0]
    expect(init.method).toBe('POST')
    const payload = JSON.parse(init.body)
    expect(payload).toEqual({ decision_id: 'd1', action: 'approve' })
  })

  it('forwards a valid deny action', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true }),
    })

    const mod = await import('../api/approvals')
    const res = await mod.POST(
      makeRequest('http://localhost/api/oap/approvals', {
        method: 'POST',
        body: JSON.stringify({ decision_id: 'd7', action: 'deny' }),
        headers: { 'Content-Type': 'application/json' },
      })
    )
    expect(res.status).toBe(200)
  })

  it('forwards approve_and_add', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, capability: 'net:outbound:*' }),
    })

    const mod = await import('../api/approvals')
    const res = await mod.POST(
      makeRequest('http://localhost/api/oap/approvals', {
        method: 'POST',
        body: JSON.stringify({ decision_id: 'd9', action: 'approve_and_add' }),
        headers: { 'Content-Type': 'application/json' },
      })
    )
    expect(res.status).toBe(200)
  })

  it('returns 400 when action is invalid', async () => {
    const mod = await import('../api/approvals')
    const res = await mod.POST(
      makeRequest('http://localhost/api/oap/approvals', {
        method: 'POST',
        body: JSON.stringify({ decision_id: 'd1', action: 'nuke' }),
        headers: { 'Content-Type': 'application/json' },
      })
    )
    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns 400 when decision_id is missing', async () => {
    const mod = await import('../api/approvals')
    const res = await mod.POST(
      makeRequest('http://localhost/api/oap/approvals', {
        method: 'POST',
        body: JSON.stringify({ action: 'approve' }),
        headers: { 'Content-Type': 'application/json' },
      })
    )
    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns 400 when body is not JSON', async () => {
    const mod = await import('../api/approvals')
    const res = await mod.POST(
      makeRequest('http://localhost/api/oap/approvals', {
        method: 'POST',
        body: 'not-json',
        headers: { 'Content-Type': 'application/json' },
      })
    )
    expect(res.status).toBe(400)
  })
})
