/**
 * Resolver Drift Alerts
 *
 * Sends drift alerts to Telegram topic 17862 via the OpenClaw gateway.
 * Called by weekly-ingest.ts when flagged_drift = true.
 * Debounce is handled at the call site (resolver_drift_alerts_sent table).
 */

import { callOpenClawGateway } from '@/lib/openclaw-gateway'
import { logger } from '@/lib/logger'

const DRIFT_ALERT_TOPIC = 17862
const DRIFT_ALERT_CHAT = '-1003803644436'

export interface DriftAlertPayload {
  weekStart: string
  driftDeltaPp: number
  topMissTools: Array<{ toolId: string; missCount: number }>
  sourceFile: string
}

/**
 * Format the drift alert message for Telegram.
 */
export function formatDriftAlertMessage(payload: DriftAlertPayload): string {
  const { weekStart, driftDeltaPp, topMissTools, sourceFile } = payload
  const sign = driftDeltaPp >= 0 ? '+' : ''
  const direction = driftDeltaPp < 0 ? '🔴 Regression' : '🟡 Spike'
  const fileName = sourceFile.split('/').pop() ?? sourceFile

  const toolLines =
    topMissTools.length > 0
      ? topMissTools.map(t => `  • \`${t.toolId}\` (${t.missCount} misses)`).join('\n')
      : '  (none recorded)'

  return [
    `⚠️ **Resolver Drift Alert** — Week of ${weekStart}`,
    '',
    `${direction}: **${sign}${driftDeltaPp.toFixed(1)} pp** vs prior week`,
    '',
    `**Top newly-missed tools:**`,
    toolLines,
    '',
    `Source: \`${fileName}\``,
  ].join('\n')
}

/**
 * Send a drift alert to Telegram via OpenClaw gateway.
 * Throws on hard failure (caller decides whether to suppress).
 */
export async function sendDriftAlert(payload: DriftAlertPayload): Promise<void> {
  const message = formatDriftAlertMessage(payload)

  try {
    await callOpenClawGateway(
      'message.send',
      {
        channel: 'telegram',
        target: DRIFT_ALERT_CHAT,
        threadId: DRIFT_ALERT_TOPIC,
        message,
      },
      10_000,
    )
    logger.info({ weekStart: payload.weekStart, driftDeltaPp: payload.driftDeltaPp }, 'resolver drift alert sent')
  } catch (err: any) {
    logger.error({ err, weekStart: payload.weekStart }, 'resolver drift alert: gateway call failed')
    throw err
  }
}
