/**
 * Single source of truth for the `{cluster, project, env, prefix}`
 * derivation that drives Fleet endpoints + the form's per-deployment
 * caps.
 *
 * Round-7 audit on PR #39 flagged that `agents.ts::resolveEnv()` and
 * `harness-defaults.ts::projectPrefix()` had independent
 * re-implementations of the same logic. Even with the
 * "KEEP IN SYNC" comment, a future PR adding a fallback to one file
 * (e.g. `MC_FLEET_PREFIX` for direct override) would silently
 * diverge — the form's `maxLength` and the server's enforcement cap
 * would drift, recreating the exact silent-drift class of bug Beat
 * 3b.2 was designed to prevent.
 *
 * Extracting to this module makes the contract single-call: both
 * sides import + call. Future fallback additions land in one place.
 *
 * No AWS imports — safe to import from anywhere on the server side.
 * (Client components don't need this; the form learns the prefix
 * indirectly via the harness-defaults endpoint's response.)
 */

export interface FleetPrefix {
  /** Full ECS cluster name. Falls back to `ender-stack-dev`. */
  clusterName: string
  /** Project segment of the cluster name. Falls back to all-but-last segment. */
  projectName: string
  /** Environment segment. Falls back to last cluster segment, then `dev`. */
  environment: string
  /** Concatenation: `{projectName}-{environment}`. Used for resource naming. */
  prefix: string
}

export function resolveFleetPrefix(): FleetPrefix {
  const clusterName = process.env.MC_FLEET_CLUSTER_NAME || 'ender-stack-dev'
  const projectName =
    process.env.MC_FLEET_PROJECT_NAME ||
    clusterName.split('-').slice(0, -1).join('-')
  const environment =
    process.env.MC_FLEET_ENVIRONMENT || clusterName.split('-').pop() || 'dev'
  return {
    clusterName,
    projectName,
    environment,
    prefix: `${projectName}-${environment}`,
  }
}
