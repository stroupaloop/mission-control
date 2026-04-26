import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'
import {
  readOverrides,
  upsertOverride,
  validateOverride,
  type ResolverOverride,
} from '@/extensions/resolver/overrides'

/**
 * GET /api/resolver/overrides
 *
 * Returns the current contents of resolver-overrides.json.
 * Returns { overrides: {} } if the file doesn't exist yet.
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  try {
    const data = readOverrides()
    return NextResponse.json(data ?? { version: 1, updatedAt: null, overrides: {} })
  } catch (err: any) {
    logger.error({ err }, 'Resolver overrides GET failed')
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

/**
 * POST /api/resolver/overrides
 *
 * Upserts a single override entry.
 *
 * Body: { id: string, override: { description?, addedKeywords?, notes? } }
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Body must be a JSON object' }, { status: 400 })
  }

  const { id, override } = body as Record<string, unknown>

  if (typeof id !== 'string' || !id.trim()) {
    return NextResponse.json({ error: 'id must be a non-empty string' }, { status: 400 })
  }

  const validationErrors = validateOverride(id.trim(), override)
  if (validationErrors.length > 0) {
    return NextResponse.json({ error: 'Validation failed', details: validationErrors }, { status: 400 })
  }

  try {
    const updated = upsertOverride(id.trim(), override as ResolverOverride)
    logger.info({ toolId: id.trim() }, 'Resolver override upserted')
    return NextResponse.json(updated)
  } catch (err: any) {
    logger.error({ err }, 'Resolver overrides POST failed')
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
