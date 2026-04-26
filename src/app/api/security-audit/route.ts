/**
 * Route shim — delegates to @stroupaloop/mission-control extensions.
 * @see src/extensions/security-audit/api/route.ts
 *
 * NOTE: Must use `export const GET = ...` (not `export { GET } from`) so
 * the API-contract-parity checker can detect the handler via its regex.
 */
import { GET as extGET } from '@/extensions/security-audit/api/route'

export const GET = extGET
