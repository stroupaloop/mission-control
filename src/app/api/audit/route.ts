/**
 * Route shim — delegates to @stroupaloop/mission-control extensions.
 *
 * GET  — query audit log (admin only); identical to upstream implementation
 * POST — OAP webhook ingest with dedup, Telegram escalation notification
 *        (extension-only; not in upstream builderz-labs/mission-control)
 *
 * @see src/extensions/oap/api/audit.ts
 *
 * NOTE: The app/api route file must use `export const GET = ...` pattern
 * (not re-exports) for the API-contract-parity check to detect the handlers.
 */
import { GET as extGET, POST as extPOST } from '@/extensions/oap/api/audit'

export const GET = extGET
export const POST = extPOST
