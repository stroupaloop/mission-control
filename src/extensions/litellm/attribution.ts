/**
 * LiteLLM user/agent attribution heuristics.
 *
 * The "correct" fix is routing each OpenClaw agent through its own LiteLLM virtual key
 * (see GH issue on agent-stack). Until then, every call hits the master key and lands
 * with `user_api_key_user_id: "default_user_id"`, so MC has to derive attribution at
 * ingest time from whatever signals are in the callback payload.
 *
 * Signals available in the payload:
 *   - body.user                                       (explicit `user` field, if SDK passes one)
 *   - metadata.user_api_key_alias                     (virtual key alias — best signal when present)
 *   - metadata.user_api_key_end_user_id               (OpenAI `user` param, forwarded)
 *   - metadata.user_api_key_user_id                   (master-key user, typically "default_user_id")
 *   - metadata.requester_metadata.user_api_key_user_id
 *   - metadata.user_agent                             (coarse SDK/runtime fingerprint)
 *   - metadata.user_api_key_request_route             ("/v1/chat/completions", "/v1/embeddings", ...)
 *
 * Precedence (highest wins):
 *   1. Explicit body.user                             (caller supplied → trust it)
 *   2. metadata.user_api_key_alias                    (virtual key name)
 *   3. metadata.user_api_key_end_user_id (≠ default)  (OpenAI `user` param)
 *   4. metadata.user_api_key_user_id (≠ default)      (tagged virtual key)
 *   5. Heuristic from user_agent + request_route      (e.g. `sdk:openai-js`, `skill:whisper`)
 *   6. null                                           (truly unknown)
 */

const DEFAULT_USER_MARKERS = new Set(['', 'default_user_id', 'default', 'null', 'undefined'])

export interface AttributionInput {
  /** Top-level explicit user field (rare). */
  user?: string | null
  /** LiteLLM metadata blob. Accepts raw object or the callback's nested shape. */
  metadata?: unknown
}

export interface AttributionResult {
  /** Best-guess user/agent id, or null if we can't tell. */
  userId: string | null
  /** Where we got it — useful for debugging and future telemetry. */
  source:
    | 'explicit_user'
    | 'key_alias'
    | 'end_user_id'
    | 'key_user_id'
    | 'heuristic_user_agent'
    | 'heuristic_route'
    | 'unknown'
}

function isMeaningful(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (!trimmed) return false
  return !DEFAULT_USER_MARKERS.has(trimmed.toLowerCase())
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/**
 * Derive a coarse identifier from the SDK/runtime user-agent string.
 * This doesn't distinguish `ender-main` from `ender-ceno` — both use the same SDK —
 * but it reliably buckets traffic by SDK/runtime so we can spot shifts in traffic origin.
 */
function heuristicFromUserAgent(userAgent: string): string | null {
  const ua = userAgent.toLowerCase()
  if (ua.includes('openai/js')) return 'sdk:openai-js'
  if (ua.includes('openai/python')) return 'sdk:openai-python'
  if (ua.startsWith('anthropic')) return 'sdk:anthropic'
  if (ua.startsWith('python-httpx')) return 'runtime:python-httpx'
  if (ua.startsWith('python-urllib')) return 'runtime:python-urllib'
  if (ua.startsWith('curl/')) return 'runtime:curl'
  if (ua === 'node' || ua.startsWith('node/') || ua.startsWith('node ')) return 'runtime:node'
  return null
}

/**
 * If we don't have a user-agent but we do have the request route, fall back
 * to that — at least we can distinguish embeddings from completions.
 */
function heuristicFromRoute(route: string): string | null {
  const r = route.toLowerCase()
  if (r.includes('/embeddings')) return 'route:embeddings'
  if (r.includes('/chat/completions')) return 'route:chat'
  if (r.includes('/completions')) return 'route:completions'
  if (r.includes('/responses')) return 'route:responses'
  if (r.includes('/messages')) return 'route:messages'
  return null
}

/**
 * Extract best-guess attribution from a LiteLLM callback payload.
 * Pure function — no side effects. Safe to unit-test in isolation.
 */
export function deriveAttribution(input: AttributionInput): AttributionResult {
  // 1. Explicit body.user
  if (isMeaningful(input.user)) {
    return { userId: input.user!.trim(), source: 'explicit_user' }
  }

  const meta = asObject(input.metadata)
  if (!meta) return { userId: null, source: 'unknown' }

  // 2. Virtual key alias
  const alias = meta.user_api_key_alias
  if (isMeaningful(alias)) {
    return { userId: alias.trim(), source: 'key_alias' }
  }

  // 3. End-user ID (OpenAI `user` param)
  const endUserId = meta.user_api_key_end_user_id
  if (isMeaningful(endUserId)) {
    return { userId: endUserId.trim(), source: 'end_user_id' }
  }

  // 4. Key user_id if not the default
  const keyUserId = meta.user_api_key_user_id
  if (isMeaningful(keyUserId)) {
    return { userId: keyUserId.trim(), source: 'key_user_id' }
  }

  // 5/6. Heuristics from user_agent or request route
  const userAgent = meta.user_agent
  if (typeof userAgent === 'string' && userAgent.trim()) {
    const ua = heuristicFromUserAgent(userAgent.trim())
    if (ua) return { userId: ua, source: 'heuristic_user_agent' }
  }

  const route = meta.user_api_key_request_route
  if (typeof route === 'string' && route.trim()) {
    const r = heuristicFromRoute(route.trim())
    if (r) return { userId: r, source: 'heuristic_route' }
  }

  return { userId: null, source: 'unknown' }
}
