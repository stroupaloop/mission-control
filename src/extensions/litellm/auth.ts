/**
 * Shared auth utilities for the LiteLLM extension.
 *
 * Extracted from usage.ts and usage-summary.ts (PR #17) to eliminate
 * duplication. Both the ingest (POST) and query (GET) paths use the same
 * token validation — centralizing it here means a single place to update
 * if the auth model evolves (e.g., per-extension HMAC signing, JWT, etc.).
 *
 * Tracked: stroupaloop/ender-stack#122
 */

import crypto from 'node:crypto'
import { NextRequest } from 'next/server'

export const LITELLM_INGEST_TOKEN =
  process.env.MC_LITELLM_INGEST_TOKEN || process.env.MC_AUDIT_INGEST_TOKEN || ''

/**
 * Constant-time string compare using crypto.timingSafeEqual.
 * Returns false on length mismatch (prevents timing leak on length).
 */
export function safeCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

/**
 * Validate the ingest token from either:
 * - Authorization: Bearer <token>
 * - x-mc-token: <token>
 *
 * Returns false if LITELLM_INGEST_TOKEN is not configured (unconfigured = reject all).
 */
export function isValidToken(request: NextRequest): boolean {
  if (!LITELLM_INGEST_TOKEN) return false
  const auth = request.headers.get('authorization') || ''
  if (auth.startsWith('Bearer ')) return safeCompare(auth.slice(7).trim(), LITELLM_INGEST_TOKEN)
  return safeCompare((request.headers.get('x-mc-token') || '').trim(), LITELLM_INGEST_TOKEN)
}
