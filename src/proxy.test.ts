import { describe, expect, it, vi } from 'vitest'

function setNodeEnv(value: string) {
  ;(process.env as Record<string, string | undefined>).NODE_ENV = value
}

describe('proxy host matching', () => {
  it('allows the system hostname implicitly', async () => {
    vi.resetModules()
    vi.doMock('node:os', () => ({
      default: { hostname: () => 'hetzner-jarv' },
      hostname: () => 'hetzner-jarv',
    }))

    const { proxy } = await import('./proxy')
    const request = {
      headers: new Headers({ host: 'hetzner-jarv' }),
      nextUrl: { host: 'hetzner-jarv', hostname: 'hetzner-jarv', pathname: '/login', clone: () => ({ pathname: '/login' }) },
      method: 'GET',
      cookies: { get: () => undefined },
    } as any

    setNodeEnv('production')
    process.env.MC_ALLOWED_HOSTS = 'localhost,127.0.0.1'
    delete process.env.MC_ALLOW_ANY_HOST

    const response = proxy(request)
    expect(response.status).not.toBe(403)
  })

  it('keeps blocking unrelated hosts in production', async () => {
    vi.resetModules()
    vi.doMock('node:os', () => ({
      default: { hostname: () => 'hetzner-jarv' },
      hostname: () => 'hetzner-jarv',
    }))

    const { proxy } = await import('./proxy')
    const request = {
      headers: new Headers({ host: 'evil.example.com' }),
      nextUrl: { host: 'evil.example.com', hostname: 'evil.example.com', pathname: '/login', clone: () => ({ pathname: '/login' }) },
      method: 'GET',
      cookies: { get: () => undefined },
    } as any

    setNodeEnv('production')
    process.env.MC_ALLOWED_HOSTS = 'localhost,127.0.0.1'
    delete process.env.MC_ALLOW_ANY_HOST

    const response = proxy(request)
    expect(response.status).toBe(403)
  })

  it('allows unauthenticated health probe for /api/status?action=health', async () => {
    vi.resetModules()
    vi.doMock('node:os', () => ({
      default: { hostname: () => 'hetzner-jarv' },
      hostname: () => 'hetzner-jarv',
    }))

    const { proxy } = await import('./proxy')
    const request = {
      headers: new Headers({ host: 'localhost:3000' }),
      nextUrl: {
        host: 'localhost:3000',
        hostname: 'localhost',
        pathname: '/api/status',
        searchParams: new URLSearchParams('action=health'),
        clone: () => ({ pathname: '/api/status' }),
      },
      method: 'GET',
      cookies: { get: () => undefined },
    } as any

    setNodeEnv('production')
    process.env.MC_ALLOWED_HOSTS = 'localhost,127.0.0.1'
    delete process.env.MC_ALLOW_ANY_HOST

    const response = proxy(request)
    expect(response.status).not.toBe(401)
  })

  it('still blocks unauthenticated non-health status API calls', async () => {
    vi.resetModules()
    vi.doMock('node:os', () => ({
      default: { hostname: () => 'hetzner-jarv' },
      hostname: () => 'hetzner-jarv',
    }))

    const { proxy } = await import('./proxy')
    const request = {
      headers: new Headers({ host: 'localhost:3000' }),
      nextUrl: {
        host: 'localhost:3000',
        hostname: 'localhost',
        pathname: '/api/status',
        searchParams: new URLSearchParams('action=overview'),
        clone: () => ({ pathname: '/api/status' }),
      },
      method: 'GET',
      cookies: { get: () => undefined },
    } as any

    setNodeEnv('production')
    process.env.MC_ALLOWED_HOSTS = 'localhost,127.0.0.1'
    delete process.env.MC_ALLOW_ANY_HOST

    const response = proxy(request)
    expect(response.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// Proxy token bypass tests — custom routes
// /api/audit POST + /api/litellm/* with valid Bearer token bypass session auth
// ---------------------------------------------------------------------------

describe('proxy token bypass — /api/audit ingest', () => {
  const AUDIT_TOKEN = 'test-audit-ingest-token-proxy'

  function makeAuditRequest(headers: Record<string, string>, method = 'POST') {
    return {
      headers: new Headers({ host: 'localhost:3000', ...headers }),
      nextUrl: {
        host: 'localhost:3000',
        hostname: 'localhost',
        pathname: '/api/audit',
        searchParams: new URLSearchParams(),
        clone: () => ({ pathname: '/api/audit' }),
      },
      method,
      cookies: { get: () => undefined },
    } as any
  }

  it('allows /api/audit POST with valid Bearer token (no session)', async () => {
    vi.resetModules()
    vi.doMock('node:os', () => ({
      default: { hostname: () => 'hetzner-jarv' },
      hostname: () => 'hetzner-jarv',
    }))
    process.env.MC_AUDIT_INGEST_TOKEN = AUDIT_TOKEN
    process.env.MC_ALLOWED_HOSTS = 'localhost,127.0.0.1'
    delete process.env.MC_ALLOW_ANY_HOST
    setNodeEnv('production')

    const { proxy } = await import('./proxy')
    const request = makeAuditRequest({ authorization: `Bearer ${AUDIT_TOKEN}` })
    const response = proxy(request)
    // Should NOT be 401 — token bypass should allow it through
    expect(response.status).not.toBe(401)
  })

  it('blocks /api/audit POST without a token (no session, no bearer)', async () => {
    vi.resetModules()
    vi.doMock('node:os', () => ({
      default: { hostname: () => 'hetzner-jarv' },
      hostname: () => 'hetzner-jarv',
    }))
    process.env.MC_AUDIT_INGEST_TOKEN = AUDIT_TOKEN
    process.env.MC_ALLOWED_HOSTS = 'localhost,127.0.0.1'
    delete process.env.MC_ALLOW_ANY_HOST
    setNodeEnv('production')

    const { proxy } = await import('./proxy')
    const request = makeAuditRequest({}) // no authorization header
    const response = proxy(request)
    expect(response.status).toBe(401)
  })

  it('blocks /api/audit POST with wrong token', async () => {
    vi.resetModules()
    vi.doMock('node:os', () => ({
      default: { hostname: () => 'hetzner-jarv' },
      hostname: () => 'hetzner-jarv',
    }))
    process.env.MC_AUDIT_INGEST_TOKEN = AUDIT_TOKEN
    process.env.MC_ALLOWED_HOSTS = 'localhost,127.0.0.1'
    delete process.env.MC_ALLOW_ANY_HOST
    setNodeEnv('production')

    const { proxy } = await import('./proxy')
    const request = makeAuditRequest({ authorization: 'Bearer wrong-token' })
    const response = proxy(request)
    expect(response.status).toBe(401)
  })

  it('does NOT apply token bypass to /api/audit GET (requires session/API key)', async () => {
    vi.resetModules()
    vi.doMock('node:os', () => ({
      default: { hostname: () => 'hetzner-jarv' },
      hostname: () => 'hetzner-jarv',
    }))
    process.env.MC_AUDIT_INGEST_TOKEN = AUDIT_TOKEN
    process.env.MC_ALLOWED_HOSTS = 'localhost,127.0.0.1'
    delete process.env.MC_ALLOW_ANY_HOST
    setNodeEnv('production')

    const { proxy } = await import('./proxy')
    // GET /api/audit with the ingest token — proxy should NOT grant bypass for GET
    const request = {
      headers: new Headers({ host: 'localhost:3000', authorization: `Bearer ${AUDIT_TOKEN}` }),
      nextUrl: {
        host: 'localhost:3000',
        hostname: 'localhost',
        pathname: '/api/audit',
        searchParams: new URLSearchParams(),
        clone: () => ({ pathname: '/api/audit' }),
      },
      method: 'GET',
      cookies: { get: () => undefined },
    } as any
    const response = proxy(request)
    // GET /api/audit is admin-only; ingest token is POST-only bypass
    expect(response.status).toBe(401)
  })
})

describe('proxy token bypass — /api/litellm/*', () => {
  const LITELLM_TOKEN = 'litellm-proxy-token-test'

  function makeLitellmRequest(
    pathname: string,
    method: string,
    headers: Record<string, string> = {},
  ) {
    return {
      headers: new Headers({ host: 'localhost:3000', ...headers }),
      nextUrl: {
        host: 'localhost:3000',
        hostname: 'localhost',
        pathname,
        searchParams: new URLSearchParams(),
        clone: () => ({ pathname }),
      },
      method,
      cookies: { get: () => undefined },
    } as any
  }

  it('allows /api/litellm/usage POST with valid Bearer token', async () => {
    vi.resetModules()
    vi.doMock('node:os', () => ({
      default: { hostname: () => 'hetzner-jarv' },
      hostname: () => 'hetzner-jarv',
    }))
    process.env.MC_LITELLM_INGEST_TOKEN = LITELLM_TOKEN
    process.env.MC_AUDIT_INGEST_TOKEN = ''
    process.env.MC_ALLOWED_HOSTS = 'localhost,127.0.0.1'
    delete process.env.MC_ALLOW_ANY_HOST
    setNodeEnv('production')

    const { proxy } = await import('./proxy')
    const request = makeLitellmRequest(
      '/api/litellm/usage',
      'POST',
      { authorization: `Bearer ${LITELLM_TOKEN}` },
    )
    const response = proxy(request)
    expect(response.status).not.toBe(401)
  })

  it('allows /api/litellm/usage GET with valid Bearer token', async () => {
    vi.resetModules()
    vi.doMock('node:os', () => ({
      default: { hostname: () => 'hetzner-jarv' },
      hostname: () => 'hetzner-jarv',
    }))
    process.env.MC_LITELLM_INGEST_TOKEN = LITELLM_TOKEN
    process.env.MC_AUDIT_INGEST_TOKEN = ''
    process.env.MC_ALLOWED_HOSTS = 'localhost,127.0.0.1'
    delete process.env.MC_ALLOW_ANY_HOST
    setNodeEnv('production')

    const { proxy } = await import('./proxy')
    const request = makeLitellmRequest(
      '/api/litellm/usage',
      'GET',
      { authorization: `Bearer ${LITELLM_TOKEN}` },
    )
    const response = proxy(request)
    expect(response.status).not.toBe(401)
  })

  it('blocks /api/litellm/usage GET without any token', async () => {
    vi.resetModules()
    vi.doMock('node:os', () => ({
      default: { hostname: () => 'hetzner-jarv' },
      hostname: () => 'hetzner-jarv',
    }))
    process.env.MC_LITELLM_INGEST_TOKEN = LITELLM_TOKEN
    process.env.MC_AUDIT_INGEST_TOKEN = ''
    process.env.MC_ALLOWED_HOSTS = 'localhost,127.0.0.1'
    delete process.env.MC_ALLOW_ANY_HOST
    setNodeEnv('production')

    const { proxy } = await import('./proxy')
    const request = makeLitellmRequest('/api/litellm/usage', 'GET') // no token
    const response = proxy(request)
    expect(response.status).toBe(401)
  })

  it('blocks /api/litellm/usage POST without any token', async () => {
    vi.resetModules()
    vi.doMock('node:os', () => ({
      default: { hostname: () => 'hetzner-jarv' },
      hostname: () => 'hetzner-jarv',
    }))
    process.env.MC_LITELLM_INGEST_TOKEN = LITELLM_TOKEN
    process.env.MC_AUDIT_INGEST_TOKEN = ''
    process.env.MC_ALLOWED_HOSTS = 'localhost,127.0.0.1'
    delete process.env.MC_ALLOW_ANY_HOST
    setNodeEnv('production')

    const { proxy } = await import('./proxy')
    const request = makeLitellmRequest('/api/litellm/usage', 'POST') // no token
    const response = proxy(request)
    expect(response.status).toBe(401)
  })

  it('allows /api/litellm/usage with MC_AUDIT_INGEST_TOKEN as fallback', async () => {
    vi.resetModules()
    vi.doMock('node:os', () => ({
      default: { hostname: () => 'hetzner-jarv' },
      hostname: () => 'hetzner-jarv',
    }))
    const AUDIT_TOKEN = 'audit-fallback-token-proxy'
    process.env.MC_LITELLM_INGEST_TOKEN = '' // not set — falls back to AUDIT
    process.env.MC_AUDIT_INGEST_TOKEN = AUDIT_TOKEN
    process.env.MC_ALLOWED_HOSTS = 'localhost,127.0.0.1'
    delete process.env.MC_ALLOW_ANY_HOST
    setNodeEnv('production')

    const { proxy } = await import('./proxy')
    const request = makeLitellmRequest(
      '/api/litellm/usage',
      'POST',
      { authorization: `Bearer ${AUDIT_TOKEN}` },
    )
    const response = proxy(request)
    expect(response.status).not.toBe(401)
  })

  it('applies token bypass to any /api/litellm/* sub-path', async () => {
    vi.resetModules()
    vi.doMock('node:os', () => ({
      default: { hostname: () => 'hetzner-jarv' },
      hostname: () => 'hetzner-jarv',
    }))
    process.env.MC_LITELLM_INGEST_TOKEN = LITELLM_TOKEN
    process.env.MC_ALLOWED_HOSTS = 'localhost,127.0.0.1'
    delete process.env.MC_ALLOW_ANY_HOST
    setNodeEnv('production')

    const { proxy } = await import('./proxy')
    const request = makeLitellmRequest(
      '/api/litellm/some-other-endpoint',
      'GET',
      { authorization: `Bearer ${LITELLM_TOKEN}` },
    )
    const response = proxy(request)
    expect(response.status).not.toBe(401)
  })
})
