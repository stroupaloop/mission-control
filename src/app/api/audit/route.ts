import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getDatabase, logAuditEvent } from '@/lib/db'
import { logger } from '@/lib/logger'

const AUDIT_INGEST_TOKEN = process.env.MC_AUDIT_INGEST_TOKEN || ''
const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.MC_TG_BOT_TOKEN || ''
const TG_ESCALATION_CHAT_ID = process.env.MC_TG_ESCALATION_CHAT_ID || ''
const TG_ESCALATION_THREAD_ID = process.env.MC_TG_ESCALATION_THREAD_ID || ''
const MC_PUBLIC_URL = process.env.MC_PUBLIC_URL || ''

async function notifyTelegramEscalation(detail: Record<string, any>) {
  if (!TG_BOT_TOKEN || !TG_ESCALATION_CHAT_ID) return
  try {
    const cap = detail.capability || 'unknown'
    const reason = detail.reason || detail.reason_code || 'escalation_required'
    const decisionId = detail.decision_id || '?'
    const mcLink = MC_PUBLIC_URL ? `${MC_PUBLIC_URL}/audit` : ''
    const lines = [
      `🚨 OAP Escalation — Approval Required`,
      `Capability: ${cap}`,
      `Reason: ${reason}`,
      `Decision: ${decisionId}`,
      `⏰ Expires in ~24 hours — action in MC`,
    ]
    if (mcLink) lines.push(`Review in Mission Control → ${mcLink}`)
    const body: Record<string, any> = {
      chat_id: TG_ESCALATION_CHAT_ID,
      text: lines.join('\n'),
      disable_web_page_preview: true,
    }
    if (TG_ESCALATION_THREAD_ID) body.message_thread_id = parseInt(TG_ESCALATION_THREAD_ID, 10)
    const res = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    })
    const result = await res.json()
    if (!result.ok) {
      logger.warn({ tg_error: result.description }, 'Telegram escalation notification failed')
    }
  } catch (err: any) {
    logger.warn({ err }, 'Failed to send Telegram escalation notification')
  }
}

function getRequestIp(request: NextRequest): string | undefined {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0]?.trim() || undefined
  const realIp = request.headers.get('x-real-ip')
  return realIp?.trim() || undefined
}

function isValidBearerToken(request: NextRequest): boolean {
  if (!AUDIT_INGEST_TOKEN) return false

  const authHeader = request.headers.get('authorization') || ''
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim() === AUDIT_INGEST_TOKEN
  }

  const tokenHeader = request.headers.get('x-mc-audit-token') || ''
  return tokenHeader.trim() === AUDIT_INGEST_TOKEN
}

function normalizeAuditAction(eventName: string): string {
  switch (eventName) {
    case 'oap.alert':
      return 'oap_alert'
    case 'oap.deny':
      return 'oap_deny'
    case 'oap.escalate':
      return 'oap_escalate'
    default:
      return 'oap_event'
  }
}

function sanitizePayload(body: Record<string, any>) {
  return {
    source: 'oap',
    event: typeof body.event === 'string' ? body.event : 'oap.unknown',
    tenant_id: body.tenant_id ?? null,
    decision_id: body.decision_id ?? null,
    capability: body.capability ?? null,
    reason_code: body.reason_code ?? null,
    reason: body.reason ?? null,
    parameters_summary: body.parameters_summary ?? null,
    timestamp: body.timestamp ?? null,
    mode: body.mode ?? null,
    allow: typeof body.allow === 'boolean' ? body.allow : null,
  }
}

function safeParseJson(str: string): any {
  try { return JSON.parse(str) } catch { return str }
}

/**
 * GET /api/audit - Query audit log (admin only)
 * POST /api/audit - Ingest OAP webhook audit events (token auth)
 * Query params: action, actor, limit, offset, since, until
 */
export async function POST(request: NextRequest) {
  if (!AUDIT_INGEST_TOKEN) {
    return NextResponse.json({ error: 'Audit ingest is not configured' }, { status: 503 })
  }

  if (!isValidBearerToken(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: Record<string, any>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'JSON object body required' }, { status: 400 })
  }

  const detail = sanitizePayload(body)
  const action = normalizeAuditAction(detail.event)

  // Deduplicate: skip if this decision_id + action already exists
  if (detail.decision_id) {
    const db = getDatabase()
    const existing = db.prepare(
      "SELECT id FROM audit_log WHERE action = ? AND detail LIKE ?"
    ).get(action, `%${detail.decision_id}%`)
    if (existing) {
      return NextResponse.json({ ok: true, action, decision_id: detail.decision_id, deduplicated: true })
    }
  }

  logAuditEvent({
    action,
    actor: `oap:${detail.tenant_id || 'unknown'}`,
    target_type: 'decision',
    detail,
    ip_address: getRequestIp(request),
    user_agent: request.headers.get('user-agent') || 'oap-webhook',
  })

  // Fire Telegram notification for escalations
  if (action === 'oap_escalate') {
    notifyTelegramEscalation(detail).catch(() => {})
  }

  return NextResponse.json({
    ok: true,
    action,
    decision_id: detail.decision_id,
  })
}

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const { searchParams } = new URL(request.url)
  const action = searchParams.get('action')
  const actor = searchParams.get('actor')
  const limit = Math.min(parseInt(searchParams.get('limit') || '1000'), 10000)
  const offset = parseInt(searchParams.get('offset') || '0')
  const since = searchParams.get('since')
  const until = searchParams.get('until')

  const conditions: string[] = []
  const params: any[] = []

  if (action) {
    conditions.push('action = ?')
    params.push(action)
  }
  if (actor) {
    conditions.push('actor = ?')
    params.push(actor)
  }
  if (since) {
    conditions.push('created_at >= ?')
    params.push(parseInt(since))
  }
  if (until) {
    conditions.push('created_at <= ?')
    params.push(parseInt(until))
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const db = getDatabase()

  const total = (db.prepare(`SELECT COUNT(*) as count FROM audit_log ${where}`).get(...params) as any).count

  const rows = db.prepare(`
    SELECT * FROM audit_log ${where}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset)

  return NextResponse.json({
    events: rows.map((row: any) => ({
      ...row,
      detail: row.detail ? safeParseJson(row.detail) : null,
    })),
    total,
    limit,
    offset,
  })
}
