/**
 * Route shim — delegates to @stroupaloop/mission-control extensions.
 *
 * GET  — query audit log (admin only); identical to upstream implementation
 * POST — OAP webhook ingest with dedup, Telegram escalation notification
 *        (extension-only; not in upstream builderz-labs/mission-control)
 *
 * @see src/extensions/oap/api/audit.ts
 */
export { GET, POST } from '@/extensions/oap/api/audit'
