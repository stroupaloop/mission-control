import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { logAuditEvent } from '@/lib/db'
import { logger } from '@/lib/logger'

const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.MC_TG_BOT_TOKEN || ''
const TG_ESCALATION_CHAT_ID = process.env.MC_TG_ESCALATION_CHAT_ID || ''
const TG_ESCALATION_THREAD_ID = process.env.MC_TG_ESCALATION_THREAD_ID || ''

async function notifyTelegramResolution(decisionId: string, action: string, actor: string, capability?: string) {
  if (!TG_BOT_TOKEN || !TG_ESCALATION_CHAT_ID) return
  try {
    const emoji = action === 'approve' ? '\u2705' : action === 'approve_and_add' ? '\u2705\u2795' : '\u274c'
    const actionLabel = action === 'approve_and_add' ? 'Approved + added to allowlist' : action === 'approve' ? 'Approved' : 'Denied'
    const lines = [
      `${emoji} OAP Escalation Resolved`,
      `Action: ${actionLabel}`,
      `Decision: ${decisionId}`,
      capability ? `Capability: ${capability}` : null,
      `By: ${actor} via Mission Control`,
    ].filter(Boolean)
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
    if (!result.ok) logger.warn({ tg_error: result.description }, 'Telegram resolution notification failed')
  } catch (err: any) {
    logger.warn({ err }, 'Failed to send Telegram resolution notification')
  }
}

function oapBaseUrl(): string {
  return process.env.OAP_SIDECAR_BASE_URL || 'http://host.docker.internal:8443'
}

async function forwardJson(path: string, init?: RequestInit) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  try {
    const res = await fetch(`${oapBaseUrl()}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers || {}),
      },
    })
    const text = await res.text()
    let data: any = null
    try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
    return { ok: res.ok, status: res.status, data }
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * GET /api/oap/approvals - list pending OAP approvals
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const result = await forwardJson('/approvals/pending', { method: 'GET', headers: { Accept: 'application/json' } })
    return NextResponse.json(result.data ?? { pending: [] }, { status: result.status })
  } catch (err: any) {
    return NextResponse.json({ error: `OAP sidecar unreachable: ${err.message}` }, { status: 502 })
  }
}

/**
 * POST /api/oap/approvals - action an OAP approval
 * Body: { decision_id: string, action: 'approve'|'deny'|'approve_and_add' }
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  let body: { decision_id?: string; action?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const decisionId = String(body.decision_id || '').trim()
  const action = String(body.action || '').trim()
  if (!decisionId || !['approve', 'deny', 'approve_and_add'].includes(action)) {
    return NextResponse.json({ error: 'decision_id and valid action are required' }, { status: 400 })
  }

  try {
    const result = await forwardJson('/approve', {
      method: 'POST',
      body: JSON.stringify({ decision_id: decisionId, action }),
    })

    if (result.ok) {
      const capability = result.data?.capability || undefined
      logAuditEvent({
        action: `oap_${action}`,
        actor: auth.user.username,
        target_type: 'decision',
        detail: {
          decision_id: decisionId,
          action,
          capability,
          source: 'mission-control',
          oap_base_url: oapBaseUrl(),
        },
        user_agent: request.headers.get('user-agent') || 'mission-control',
      })
      notifyTelegramResolution(decisionId, action, auth.user.username, capability).catch(() => {})
    }

    return NextResponse.json(result.data ?? { ok: result.ok }, { status: result.status })
  } catch (err: any) {
    return NextResponse.json({ error: `OAP sidecar unreachable: ${err.message}` }, { status: 502 })
  }
}
