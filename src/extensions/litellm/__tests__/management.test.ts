import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LiteLLMManagementClient,
  LiteLLMManagementError,
} from '@/extensions/litellm/management'

const BASE = 'http://internal-litellm.example.com'
const MASTER = 'sk-master-NEVER-LOG'

const mkResponse = (status: number, body: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: async () =>
      typeof body === 'string' ? body : JSON.stringify(body ?? {}),
    json: async () => body,
  }) as unknown as Response

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('LiteLLMManagementClient.generateKey', () => {
  it('POSTs key_alias + models + max_budget with Bearer auth, returns the new key', async () => {
    fetchMock.mockResolvedValueOnce(mkResponse(200, { key: 'sk-virtual-abc' }))
    const client = new LiteLLMManagementClient(BASE, MASTER)
    const out = await client.generateKey({
      alias: 'ender-stack-dev-hello-bot',
      models: ['openai/smart-router', 'anthropic/claude-haiku-4-5'],
      maxBudget: 50,
    })
    expect(out.key).toBe('sk-virtual-abc')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${BASE}/key/generate`)
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${MASTER}`)
    expect(headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(init.body as string)).toEqual({
      key_alias: 'ender-stack-dev-hello-bot',
      models: ['openai/smart-router', 'anthropic/claude-haiku-4-5'],
      max_budget: 50,
    })
  })

  it('trims a trailing slash on baseUrl so the path joins cleanly', async () => {
    fetchMock.mockResolvedValueOnce(mkResponse(200, { key: 'sk-x' }))
    const client = new LiteLLMManagementClient(`${BASE}/`, MASTER)
    await client.generateKey({ alias: 'a', models: ['m'], maxBudget: 1 })
    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toBe(`${BASE}/key/generate`)
  })

  it('throws LiteLLMManagementError(retriable=false) on a 4xx', async () => {
    fetchMock.mockResolvedValueOnce(mkResponse(400, { detail: 'bad models' }))
    const client = new LiteLLMManagementClient(BASE, MASTER)
    await expect(
      client.generateKey({ alias: 'a', models: ['x'], maxBudget: 1 }),
    ).rejects.toMatchObject({
      name: 'LiteLLMManagementError',
      status: 400,
      retriable: false,
    })
  })

  it('throws LiteLLMManagementError(retriable=true) on a 5xx', async () => {
    fetchMock.mockResolvedValueOnce(mkResponse(503, 'upstream busy'))
    const client = new LiteLLMManagementClient(BASE, MASTER)
    await expect(
      client.generateKey({ alias: 'a', models: ['x'], maxBudget: 1 }),
    ).rejects.toMatchObject({
      name: 'LiteLLMManagementError',
      status: 503,
      retriable: true,
    })
  })

  it('throws LiteLLMManagementError when the proxy returns 200 but no key', async () => {
    fetchMock.mockResolvedValueOnce(mkResponse(200, { not_a_key: true }))
    const client = new LiteLLMManagementClient(BASE, MASTER)
    await expect(
      client.generateKey({ alias: 'a', models: ['x'], maxBudget: 1 }),
    ).rejects.toMatchObject({
      name: 'LiteLLMManagementError',
      status: 200,
      retriable: false,
    })
  })

  it('throws LiteLLMManagementError(retriable=true) on fetch network failure', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('failed to fetch'))
    const client = new LiteLLMManagementClient(BASE, MASTER)
    await expect(
      client.generateKey({ alias: 'a', models: ['x'], maxBudget: 1 }),
    ).rejects.toMatchObject({
      name: 'LiteLLMManagementError',
      status: 0,
      retriable: true,
    })
  })
})

describe('LiteLLMManagementClient.deleteKey', () => {
  it('POSTs key_aliases array', async () => {
    fetchMock.mockResolvedValueOnce(mkResponse(200, { deleted: 1 }))
    const client = new LiteLLMManagementClient(BASE, MASTER)
    const out = await client.deleteKey({ alias: 'ender-stack-dev-hello-bot' })
    expect(out.alreadyDeleted).toBe(false)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${BASE}/key/delete`)
    expect(JSON.parse(init.body as string)).toEqual({
      key_aliases: ['ender-stack-dev-hello-bot'],
    })
  })

  it('treats 404 as already-deleted (idempotent)', async () => {
    fetchMock.mockResolvedValueOnce(mkResponse(404, { detail: 'not found' }))
    const client = new LiteLLMManagementClient(BASE, MASTER)
    const out = await client.deleteKey({ alias: 'gone-already' })
    expect(out.alreadyDeleted).toBe(true)
  })

  it('propagates non-404 errors', async () => {
    fetchMock.mockResolvedValueOnce(mkResponse(500, 'kaboom'))
    const client = new LiteLLMManagementClient(BASE, MASTER)
    await expect(client.deleteKey({ alias: 'x' })).rejects.toBeInstanceOf(
      LiteLLMManagementError,
    )
  })
})

describe('LiteLLMManagementClient.generateKeyWithRotation (#354 round-2)', () => {
  it('returns the new key directly when no alias conflict', async () => {
    fetchMock.mockResolvedValueOnce(mkResponse(200, { key: 'sk-fresh' }))
    const client = new LiteLLMManagementClient(BASE, MASTER)
    const out = await client.generateKeyWithRotation({
      alias: 'a',
      models: ['m'],
      maxBudget: 1,
    })
    expect(out.key).toBe('sk-fresh')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('on duplicate-alias 400, calls /key/delete then retries /key/generate', async () => {
    fetchMock
      .mockResolvedValueOnce(
        mkResponse(400, { detail: 'key_alias already exists for this user' }),
      )
      .mockResolvedValueOnce(mkResponse(200, { deleted: 1 })) // /key/delete
      .mockResolvedValueOnce(mkResponse(200, { key: 'sk-rotated' }))
    const client = new LiteLLMManagementClient(BASE, MASTER)
    const out = await client.generateKeyWithRotation({
      alias: 'ender-stack-dev-hello-bot',
      models: ['m'],
      maxBudget: 1,
    })
    expect(out.key).toBe('sk-rotated')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const paths = fetchMock.mock.calls.map(
      (c) => (c[0] as string).replace(BASE, ''),
    )
    expect(paths).toEqual(['/key/generate', '/key/delete', '/key/generate'])
  })

  it('only retries ONCE — second consecutive duplicate-alias error propagates', async () => {
    fetchMock
      .mockResolvedValueOnce(
        mkResponse(400, { detail: 'duplicate key_alias detected' }),
      )
      .mockResolvedValueOnce(mkResponse(200, { deleted: 1 }))
      .mockResolvedValueOnce(
        mkResponse(400, { detail: 'key_alias already exists' }),
      )
    const client = new LiteLLMManagementClient(BASE, MASTER)
    await expect(
      client.generateKeyWithRotation({
        alias: 'a',
        models: ['m'],
        maxBudget: 1,
      }),
    ).rejects.toMatchObject({ name: 'LiteLLMManagementError', status: 400 })
  })

  it('propagates non-duplicate-alias 400s without rotating', async () => {
    fetchMock.mockResolvedValueOnce(
      mkResponse(400, { detail: 'models field is required' }),
    )
    const client = new LiteLLMManagementClient(BASE, MASTER)
    await expect(
      client.generateKeyWithRotation({
        alias: 'a',
        models: [],
        maxBudget: 1,
      }),
    ).rejects.toMatchObject({ name: 'LiteLLMManagementError', status: 400 })
    expect(fetchMock).toHaveBeenCalledTimes(1) // no rotate
  })

  it('propagates 5xx without rotating', async () => {
    fetchMock.mockResolvedValueOnce(mkResponse(503, 'upstream busy'))
    const client = new LiteLLMManagementClient(BASE, MASTER)
    await expect(
      client.generateKeyWithRotation({
        alias: 'a',
        models: ['m'],
        maxBudget: 1,
      }),
    ).rejects.toMatchObject({ name: 'LiteLLMManagementError', status: 503 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('LiteLLMManagementClient constructor', () => {
  it('rejects empty baseUrl', () => {
    expect(() => new LiteLLMManagementClient('', MASTER)).toThrow(/baseUrl/)
  })

  it('rejects empty masterKey', () => {
    expect(() => new LiteLLMManagementClient(BASE, '')).toThrow(/masterKey/)
  })
})
