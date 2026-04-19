import { describe, expect, it } from 'vitest'
import { deriveAttribution } from '@/lib/litellm-attribution'

describe('deriveAttribution', () => {
  it('prefers explicit body.user over everything else', () => {
    expect(
      deriveAttribution({
        user: 'ender-ceno',
        metadata: { user_api_key_alias: 'ender-main', user_agent: 'OpenAI/JS 6.26.0' },
      }),
    ).toEqual({ userId: 'ender-ceno', source: 'explicit_user' })
  })

  it('uses virtual key alias when body.user missing', () => {
    expect(
      deriveAttribution({
        metadata: { user_api_key_alias: 'ender-leverage', user_api_key_user_id: 'default_user_id' },
      }),
    ).toEqual({ userId: 'ender-leverage', source: 'key_alias' })
  })

  it('falls through to end_user_id when alias missing', () => {
    expect(
      deriveAttribution({
        metadata: { user_api_key_alias: null, user_api_key_end_user_id: 'subagent:abc123' },
      }),
    ).toEqual({ userId: 'subagent:abc123', source: 'end_user_id' })
  })

  it('ignores default_user_id markers', () => {
    expect(
      deriveAttribution({
        metadata: {
          user_api_key_user_id: 'default_user_id',
          user_api_key_alias: null,
          user_api_key_end_user_id: null,
        },
      }),
    ).toEqual({ userId: null, source: 'unknown' })
  })

  it('uses real user_api_key_user_id if it is not the default', () => {
    expect(
      deriveAttribution({ metadata: { user_api_key_user_id: 'ender-main' } }),
    ).toEqual({ userId: 'ender-main', source: 'key_user_id' })
  })

  it('falls back to user_agent heuristic (openai-js)', () => {
    expect(
      deriveAttribution({
        metadata: {
          user_api_key_user_id: 'default_user_id',
          user_agent: 'OpenAI/JS 6.26.0',
        },
      }),
    ).toEqual({ userId: 'sdk:openai-js', source: 'heuristic_user_agent' })
  })

  it('detects python-httpx runtime', () => {
    expect(
      deriveAttribution({
        metadata: {
          user_api_key_user_id: 'default_user_id',
          user_agent: 'python-httpx/0.28.1',
        },
      }),
    ).toEqual({ userId: 'runtime:python-httpx', source: 'heuristic_user_agent' })
  })

  it('detects node runtime', () => {
    expect(
      deriveAttribution({
        metadata: {
          user_api_key_user_id: 'default_user_id',
          user_agent: 'node',
        },
      }),
    ).toEqual({ userId: 'runtime:node', source: 'heuristic_user_agent' })
  })

  it('falls back to route heuristic when user_agent is blank', () => {
    expect(
      deriveAttribution({
        metadata: {
          user_api_key_user_id: 'default_user_id',
          user_agent: '',
          user_api_key_request_route: '/v1/embeddings',
        },
      }),
    ).toEqual({ userId: 'route:embeddings', source: 'heuristic_route' })
  })

  it('returns unknown when we genuinely have nothing', () => {
    expect(deriveAttribution({ metadata: {} })).toEqual({ userId: null, source: 'unknown' })
    expect(deriveAttribution({})).toEqual({ userId: null, source: 'unknown' })
    expect(deriveAttribution({ user: '', metadata: null })).toEqual({
      userId: null,
      source: 'unknown',
    })
  })

  it('handles malformed metadata gracefully', () => {
    expect(deriveAttribution({ metadata: 'not-an-object' as unknown })).toEqual({
      userId: null,
      source: 'unknown',
    })
    expect(deriveAttribution({ metadata: [1, 2, 3] as unknown })).toEqual({
      userId: null,
      source: 'unknown',
    })
  })

  it('trims whitespace from matched values', () => {
    expect(
      deriveAttribution({ metadata: { user_api_key_alias: '  ender-jericho  ' } }),
    ).toEqual({ userId: 'ender-jericho', source: 'key_alias' })
  })

  it('real-world payload from Ender MC: correctly buckets to runtime:openai-js', () => {
    const realMetadata = {
      user_api_key_hash: '03a294d947bd0641580c9fdd69240b55d459006321969cc6e3cf62289324d21c',
      user_api_key_alias: null,
      user_api_key_user_id: 'default_user_id',
      user_api_key_end_user_id: null,
      user_api_key_request_route: '/v1/embeddings',
      user_agent: 'OpenAI/JS 4.104.0',
      requester_ip_address: '192.168.107.1',
    }
    expect(deriveAttribution({ metadata: realMetadata })).toEqual({
      userId: 'sdk:openai-js',
      source: 'heuristic_user_agent',
    })
  })
})
