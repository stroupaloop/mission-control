import { test, expect } from '@playwright/test'

/**
 * E2E specs for custom API routes:
 * 1. OAP Audit Ingest   — POST /api/audit  (Bearer token auth, dedup on decision_id)
 * 2. LiteLLM Usage      — POST + GET /api/litellm/usage  (token auth, aggregation)
 * 3. OAP Approval Bridge — GET + POST /api/oap/approvals  (operator auth, sidecar proxy)
 *
 * Token values are injected via the webServer env in playwright.config.ts.
 * The e2e server starts with MISSION_CONTROL_TEST_MODE=1; custom env vars must be
 * pre-set in the environment or injected via the config before these run.
 */

const API_KEY = process.env.API_KEY || 'test-api-key-e2e-12345'
const AUDIT_TOKEN = process.env.MC_AUDIT_INGEST_TOKEN || 'test-audit-token-e2e'
const LITELLM_TOKEN = process.env.MC_LITELLM_INGEST_TOKEN || AUDIT_TOKEN

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function apiHeaders(token: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

function adminHeaders(): Record<string, string> {
  return {
    'x-api-key': API_KEY,
    'Content-Type': 'application/json',
  }
}

function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// ---------------------------------------------------------------------------
// OAP Audit Ingest — POST /api/audit
// ---------------------------------------------------------------------------

test.describe('OAP Audit Ingest (POST /api/audit)', () => {
  test('returns 401 without Authorization header', async ({ request }) => {
    const res = await request.post('/api/audit', {
      data: { event: 'oap.alert', decision_id: `dec-${uid()}` },
    })
    expect(res.status()).toBe(401)
  })

  test('returns 401 with wrong Bearer token', async ({ request }) => {
    const res = await request.post('/api/audit', {
      headers: { 'Authorization': 'Bearer wrong-token-totally-bad', 'Content-Type': 'application/json' },
      data: { event: 'oap.alert', decision_id: `dec-${uid()}` },
    })
    expect(res.status()).toBe(401)
  })

  test('accepts valid Bearer token and returns ok:true', async ({ request }) => {
    const decisionId = `dec-e2e-${uid()}`
    const res = await request.post('/api/audit', {
      headers: apiHeaders(AUDIT_TOKEN),
      data: {
        event: 'oap.alert',
        decision_id: decisionId,
        capability: 'exec',
        tenant_id: 'e2e-tenant',
        reason_code: 'test',
      },
    })
    // If token is configured, expect success; if not, 503 is acceptable
    if (res.status() === 503) {
      // MC_AUDIT_INGEST_TOKEN not configured in this test env — skip gracefully
      test.skip()
      return
    }
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.decision_id).toBe(decisionId)
    expect(body.action).toBe('oap_alert')
  })

  test('deduplicates on decision_id — second ingest returns deduplicated:true', async ({ request }) => {
    const decisionId = `dec-dedup-${uid()}`
    const payload = {
      event: 'oap.deny',
      decision_id: decisionId,
      capability: 'file_write',
      tenant_id: 'e2e-dedup',
    }
    const headers = apiHeaders(AUDIT_TOKEN)

    // First ingest
    const res1 = await request.post('/api/audit', { headers, data: payload })
    if (res1.status() === 503) { test.skip(); return }
    expect(res1.status()).toBe(200)
    const body1 = await res1.json()
    expect(body1.ok).toBe(true)
    expect(body1.deduplicated).toBeFalsy()

    // Second ingest — same decision_id
    const res2 = await request.post('/api/audit', { headers, data: payload })
    expect(res2.status()).toBe(200)
    const body2 = await res2.json()
    expect(body2.ok).toBe(true)
    expect(body2.deduplicated).toBe(true)
  })

  test('normalizes oap.escalate event to oap_escalate action', async ({ request }) => {
    const decisionId = `dec-escalate-${uid()}`
    const res = await request.post('/api/audit', {
      headers: apiHeaders(AUDIT_TOKEN),
      data: { event: 'oap.escalate', decision_id: decisionId, tenant_id: 'e2e' },
    })
    if (res.status() === 503) { test.skip(); return }
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.action).toBe('oap_escalate')
  })

  test('returns 400 for non-JSON body', async ({ request }) => {
    const res = await request.post('/api/audit', {
      headers: { 'Authorization': `Bearer ${AUDIT_TOKEN}`, 'Content-Type': 'text/plain' },
      data: 'this is not json',
    })
    if (res.status() === 503) { test.skip(); return }
    expect([400, 415]).toContain(res.status())
  })

  test('GET /api/audit returns 401 without admin auth', async ({ request }) => {
    const res = await request.get('/api/audit')
    expect(res.status()).toBe(401)
  })

  test('GET /api/audit returns audit events with admin API key', async ({ request }) => {
    const res = await request.get('/api/audit', {
      headers: { 'x-api-key': API_KEY },
    })
    // Expect 200 — events array may be empty but structure should be valid
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('events')
    expect(Array.isArray(body.events)).toBe(true)
    expect(body).toHaveProperty('total')
  })
})

// ---------------------------------------------------------------------------
// LiteLLM Usage — POST /api/litellm/usage
// ---------------------------------------------------------------------------

test.describe('LiteLLM Usage Ingest (POST /api/litellm/usage)', () => {
  test('returns 401 without auth token', async ({ request }) => {
    const res = await request.post('/api/litellm/usage', {
      data: { model: 'gpt-4o', prompt_tokens: 100 },
    })
    expect(res.status()).toBe(401)
  })

  test('returns 401 with wrong token', async ({ request }) => {
    const res = await request.post('/api/litellm/usage', {
      headers: { 'Authorization': 'Bearer completely-wrong', 'Content-Type': 'application/json' },
      data: { model: 'gpt-4o', prompt_tokens: 100 },
    })
    expect(res.status()).toBe(401)
  })

  test('accepts valid token and ingests a single usage record', async ({ request }) => {
    const res = await request.post('/api/litellm/usage', {
      headers: apiHeaders(LITELLM_TOKEN),
      data: {
        litellm_call_id: `call-e2e-${uid()}`,
        model: 'gpt-4o',
        prompt_tokens: 150,
        completion_tokens: 80,
        total_tokens: 230,
        response_cost: 0.003,
        status: 'success',
        startTime: new Date(Date.now() - 500).toISOString(),
        endTime: new Date().toISOString(),
        user: 'e2e-test-user',
      },
    })
    if (res.status() === 503) { test.skip(); return }
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.ingested).toBe(1)
  })

  test('accepts an array of usage records', async ({ request }) => {
    const records = [
      { model: 'gpt-4o', prompt_tokens: 100, completion_tokens: 50, response_cost: 0.001, litellm_call_id: `call-${uid()}` },
      { model: 'claude-3-5-sonnet', prompt_tokens: 200, completion_tokens: 100, response_cost: 0.002, litellm_call_id: `call-${uid()}` },
    ]
    const res = await request.post('/api/litellm/usage', {
      headers: apiHeaders(LITELLM_TOKEN),
      data: records,
    })
    if (res.status() === 503) { test.skip(); return }
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.ingested).toBe(2)
  })

  test('returns 400 for invalid JSON body', async ({ request }) => {
    const res = await request.post('/api/litellm/usage', {
      headers: { 'Authorization': `Bearer ${LITELLM_TOKEN}`, 'Content-Type': 'text/plain' },
      data: 'bad-json-data',
    })
    if (res.status() === 503) { test.skip(); return }
    expect([400, 415]).toContain(res.status())
  })
})

// ---------------------------------------------------------------------------
// LiteLLM Usage — GET /api/litellm/usage
// ---------------------------------------------------------------------------

test.describe('LiteLLM Usage Query (GET /api/litellm/usage)', () => {
  test('returns 401 without auth token', async ({ request }) => {
    const res = await request.get('/api/litellm/usage')
    expect(res.status()).toBe(401)
  })

  test('returns 401 with wrong token', async ({ request }) => {
    const res = await request.get('/api/litellm/usage', {
      headers: { 'Authorization': 'Bearer totally-wrong-token' },
    })
    expect(res.status()).toBe(401)
  })

  test('returns records and summary with valid auth token', async ({ request }) => {
    const res = await request.get('/api/litellm/usage', {
      headers: { 'Authorization': `Bearer ${LITELLM_TOKEN}` },
    })
    if (res.status() === 503) { test.skip(); return }
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('records')
    expect(Array.isArray(body.records)).toBe(true)
    expect(body).toHaveProperty('summary')
    expect(body).toHaveProperty('total')
    expect(body).toHaveProperty('limit')
    expect(body).toHaveProperty('offset')
  })

  test('supports model filter query param', async ({ request }) => {
    const res = await request.get('/api/litellm/usage?model=gpt-4o', {
      headers: { 'Authorization': `Bearer ${LITELLM_TOKEN}` },
    })
    if (res.status() === 503) { test.skip(); return }
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.records)).toBe(true)
    // If records returned, all should match the model filter
    for (const record of body.records) {
      expect(record.model).toContain('gpt-4o')
    }
  })

  test('respects limit query param', async ({ request }) => {
    const res = await request.get('/api/litellm/usage?limit=5', {
      headers: { 'Authorization': `Bearer ${LITELLM_TOKEN}` },
    })
    if (res.status() === 503) { test.skip(); return }
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.limit).toBe(5)
    expect(body.records.length).toBeLessThanOrEqual(5)
  })

  test('end-to-end: ingest then query returns the record', async ({ request }) => {
    const callId = `call-e2e-roundtrip-${uid()}`
    const model = `test-model-${uid()}`

    // Ingest
    const ingestRes = await request.post('/api/litellm/usage', {
      headers: apiHeaders(LITELLM_TOKEN),
      data: { litellm_call_id: callId, model, prompt_tokens: 42, completion_tokens: 21 },
    })
    if (ingestRes.status() === 503) { test.skip(); return }
    expect(ingestRes.status()).toBe(200)

    // Query with model filter
    const queryRes = await request.get(`/api/litellm/usage?model=${encodeURIComponent(model)}`, {
      headers: { 'Authorization': `Bearer ${LITELLM_TOKEN}` },
    })
    expect(queryRes.status()).toBe(200)
    const body = await queryRes.json()
    expect(body.records.length).toBeGreaterThan(0)
    expect(body.records[0].model).toBe(model)
    expect(body.records[0].prompt_tokens).toBe(42)
  })
})

// ---------------------------------------------------------------------------
// OAP Approval Bridge — /api/oap/approvals
// ---------------------------------------------------------------------------

test.describe('OAP Approval Bridge (GET /api/oap/approvals)', () => {
  test('returns 401 without auth', async ({ request }) => {
    const res = await request.get('/api/oap/approvals')
    expect(res.status()).toBe(401)
  })

  test('returns list of pending approvals (or 502 if sidecar not running)', async ({ request }) => {
    const res = await request.get('/api/oap/approvals', {
      headers: { 'x-api-key': API_KEY },
    })
    // Either OAP sidecar is reachable (200) or not (502)
    // Both are correct API behaviors in CI — we just verify auth gate passed
    expect([200, 502]).toContain(res.status())
    if (res.status() === 200) {
      const body = await res.json()
      expect(body).toHaveProperty('pending')
    }
    if (res.status() === 502) {
      const body = await res.json()
      expect(body.error).toMatch(/sidecar unreachable/i)
    }
  })
})

test.describe('OAP Approval Bridge (POST /api/oap/approvals)', () => {
  test('returns 401 without auth', async ({ request }) => {
    const res = await request.post('/api/oap/approvals', {
      data: { decision_id: 'dec-001', action: 'approve' },
    })
    expect(res.status()).toBe(401)
  })

  test('returns 400 for missing decision_id', async ({ request }) => {
    const res = await request.post('/api/oap/approvals', {
      headers: adminHeaders(),
      data: { action: 'approve' }, // no decision_id
    })
    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/decision_id/i)
  })

  test('returns 400 for invalid action', async ({ request }) => {
    const res = await request.post('/api/oap/approvals', {
      headers: adminHeaders(),
      data: { decision_id: `dec-${uid()}`, action: 'invalid-action' },
    })
    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/action/i)
  })

  test('returns 400 for empty decision_id', async ({ request }) => {
    const res = await request.post('/api/oap/approvals', {
      headers: adminHeaders(),
      data: { decision_id: '', action: 'approve' },
    })
    expect(res.status()).toBe(400)
  })

  test('returns 400 for invalid JSON body', async ({ request }) => {
    const res = await request.post('/api/oap/approvals', {
      headers: { 'x-api-key': API_KEY, 'Content-Type': 'text/plain' },
      data: 'totally not json',
    })
    expect([400, 415]).toContain(res.status())
  })

  test('forwards valid approve action to OAP sidecar (or 502 if not running)', async ({ request }) => {
    const res = await request.post('/api/oap/approvals', {
      headers: adminHeaders(),
      data: { decision_id: `dec-approve-${uid()}`, action: 'approve' },
    })
    // Valid body + valid auth — should either succeed (200) or fail at sidecar level (502)
    expect([200, 502]).toContain(res.status())
    if (res.status() === 502) {
      const body = await res.json()
      expect(body.error).toMatch(/sidecar unreachable/i)
    }
  })

  test('forwards valid deny action to OAP sidecar (or 502 if not running)', async ({ request }) => {
    const res = await request.post('/api/oap/approvals', {
      headers: adminHeaders(),
      data: { decision_id: `dec-deny-${uid()}`, action: 'deny' },
    })
    expect([200, 502]).toContain(res.status())
  })

  test('forwards valid approve_and_add action to OAP sidecar (or 502 if not running)', async ({ request }) => {
    const res = await request.post('/api/oap/approvals', {
      headers: adminHeaders(),
      data: { decision_id: `dec-add-${uid()}`, action: 'approve_and_add' },
    })
    expect([200, 502]).toContain(res.status())
  })
})
