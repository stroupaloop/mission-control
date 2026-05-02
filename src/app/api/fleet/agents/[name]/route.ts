/**
 * Route shim — delegates to @stroupaloop/mission-control extensions.
 * @see src/extensions/fleet/api/agents-delete.ts
 *
 * Const-binding form (vs `export { DELETE } from ...`) is intentional:
 * the api-contract-parity script greps for `export const DELETE =` /
 * `export function DELETE(`. A bare re-export wouldn't be picked up.
 */
import { DELETE as fleetAgentsDelete } from '@/extensions/fleet/api/agents-delete'

export const DELETE = fleetAgentsDelete
