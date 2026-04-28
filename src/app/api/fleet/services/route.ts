/**
 * Route shim — delegates to @stroupaloop/mission-control extensions.
 * @see src/extensions/fleet/api/services.ts
 *
 * The const-binding form (vs `export { GET } from ...`) is intentional: the
 * api-contract-parity script greps for `export const GET =` / `export
 * function GET(` to detect handler routes. A bare re-export wouldn't be
 * picked up, and this route would silently disappear from the parity audit.
 */
import { GET as fleetServicesGet } from '@/extensions/fleet/api/services'

export const GET = fleetServicesGet
