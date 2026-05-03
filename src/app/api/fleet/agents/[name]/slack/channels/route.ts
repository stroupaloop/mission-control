/**
 * Route shim — delegates to @stroupaloop/mission-control extensions.
 * @see src/extensions/fleet/api/slack-channels.ts
 *
 * Const-binding form (vs `export { GET } from ...`) is intentional:
 * the api-contract-parity script greps for `export const GET =` /
 * `export function GET(`. A bare re-export wouldn't be picked up.
 */
import { NextResponse } from 'next/server'
import { GET as fleetSlackChannels } from '@/extensions/fleet/api/slack-channels'

export const GET = fleetSlackChannels

/**
 * Beat 5c.2 placeholder: the channels-picker UI POSTs/PUTs the
 * selected channel IDs back to update the OPENCLAW_SLACK_CONFIG_JSON
 * env on the agent's task-def. The actual handler hasn't shipped
 * yet (existing POST /slack/credentials requires all three tokens;
 * a channels-only update path is tracked as ender-stack#283).
 *
 * Without this stub, Next.js's App Router responds to PUT with a
 * 405 + an HTML body; the picker's `resp.json()` then throws and
 * the operator sees a generic "HTTP 405" with no remediation
 * hint. Round-1 audit on PR #51 caught the gap. This stub returns
 * a well-formed JSON 501 so the UI's existing
 * `saveState.status === 501` branch fires and the operator sees
 * the ender-stack#283 follow-up hint.
 *
 * Remove this stub when ender-stack#283 lands the real PUT handler.
 */
export async function PUT() {
  return NextResponse.json(
    {
      error: 'NotImplemented',
      detail:
        'Channels-only update path not yet wired — see ender-stack#283.',
    },
    { status: 501, headers: { 'Cache-Control': 'no-store' } },
  )
}
