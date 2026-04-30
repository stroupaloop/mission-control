/**
 * Route shim — delegates to @stroupaloop/mission-control extensions.
 * @see src/extensions/fleet/api/agents.ts
 *
 * The const-binding form (vs `export { POST } from ...`) is intentional: the
 * api-contract-parity script greps for `export const POST =` / `export
 * function POST(` to detect handler routes. A bare re-export wouldn't be
 * picked up, and this route would silently disappear from the parity audit.
 */
import { POST as fleetAgentsPost } from '@/extensions/fleet/api/agents'

export const POST = fleetAgentsPost
