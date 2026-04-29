/**
 * Route shim — delegates to @stroupaloop/mission-control extensions.
 * @see src/extensions/fleet/api/redeploy.ts
 *
 * Const-binding form (vs `export { POST } from ...`) is intentional: the
 * api-contract-parity script greps for `export const POST =` /
 * `export function POST(`. A bare re-export wouldn't be picked up.
 */
import { POST as fleetServicesRedeployPost } from '@/extensions/fleet/api/redeploy'

export const POST = fleetServicesRedeployPost
