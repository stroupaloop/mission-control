/**
 * Per-harness deploy template registry.
 *
 * Each harness type (companion/openclaw today; task/hermes when the
 * Hermes-Phase PR lands) gets a renderer module that emits the AWS
 * SDK input objects for RegisterTaskDefinition / CreateService /
 * CreateTargetGroup / CreateRule. The create-agent handler dispatches
 * by `harnessType` to the matching renderer; everything specific to a
 * harness (port, healthcheck path, env vars, cpu/memory defaults) lives
 * in its renderer file, NOT in the handler.
 *
 * Adding a harness:
 *   1. Author `templates/{harness}.ts` with the same renderer signatures
 *      as openclaw.ts (renderTaskDefinition, renderTargetGroup, renderService,
 *      renderListenerRule for ALB-attached harnesses; omit the ALB calls
 *      for ephemeral / RunTask harnesses).
 *   2. Register it in HARNESS_TEMPLATES below.
 *   3. Add a case to the form's harness-type select.
 *   4. Confirm modules/iam/main.tf's task_ecs_write doc covers the
 *      new naming pattern (currently scoped to `companion-*`; Hermes
 *      will need `worker-*` when its architecture decision lands).
 */

import * as openclaw from './openclaw'
import {
  AGENT_NAME_RE,
  HARNESS_TYPES,
  IMAGE_MAX_BYTES,
  ROLE_DESCRIPTION_MAX_BYTES,
  type HarnessType,
} from './constraints'

// Re-export for callers that already imported from this module.
// Constants live in `./constraints` (no AWS SDK imports) so client
// components can pull them without dragging the AWS SDK into the browser
// bundle. See constraints.ts for the security-control commentary.
export { HARNESS_TYPES, type HarnessType }

/**
 * Concrete shape today (OpenClaw only). Generics removed until a second
 * harness lands — adding `<I, E>` while every render method is bound to
 * `typeof openclaw.*` was a false-extensibility signal that would have
 * needed a real generalization pass on the first Hermes/etc. PR anyway.
 * The right time to re-add the generics is when we have ≥2 input/env
 * shapes to vary over.
 */
export interface HarnessTemplate {
  renderTaskDefinition: typeof openclaw.renderTaskDefinition
  renderTargetGroup: typeof openclaw.renderTargetGroup
  renderService: typeof openclaw.renderService
  renderListenerRule: typeof openclaw.renderListenerRule
  /**
   * Validates the harness-specific shape of the form input. Throws on
   * invalid.
   *
   * `prefix` is optional for backward compatibility with callers that
   * only have the input (e.g. unit tests asserting input-only
   * constraints). When provided, the validator also enforces
   * deployment-aware constraints — for OpenClaw, that's the
   * `${prefix}-agent-${name}` target-group-name length cap (AWS 32
   * char limit). The handler always passes prefix; tests for
   * input-only invariants can omit it.
   */
  validateInput: (input: openclaw.OpenClawAgentInput, prefix?: string) => void
}

// Image registry allowlist. Defaults to ECR-in-this-account, GHCR
// under stroupaloop, and AWS public ECR — everything we expect a
// legitimate operator to reference. The image tag in a task-def
// revision is permanent and admin-creatable; without an allowlist,
// a compromised admin token could deploy from `docker.io/anyone/*`
// (or any other registry the execution role can reach via its
// ECR pull permissions). Defense at the API layer.
//
// Override via MC_FLEET_IMAGE_REGISTRY_ALLOWLIST — comma-separated
// regex prefixes. When unset, the conservative default below applies.
// Each entry is matched as a prefix (anchored implicitly at start of
// the image string), not a substring, so e.g. `ghcr.io/stroupaloop`
// permits `ghcr.io/stroupaloop/openclaw:tag` but NOT
// `evil.com/ghcr.io/stroupaloop`.
const DEFAULT_IMAGE_REGISTRY_PREFIXES = [
  String.raw`[0-9]+\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com/`,
  String.raw`ghcr\.io/stroupaloop/`,
  String.raw`public\.ecr\.aws/`,
]

/**
 * Thrown when MC_FLEET_IMAGE_REGISTRY_ALLOWLIST contains a malformed
 * regex pattern. Surfaced separately from generic validation errors so
 * the handler can map it to a clear configuration error rather than a
 * confusing 502 SyntaxError. Caught upstream in api/agents.ts and
 * mapped to the same ConfigurationError shape used for missing env
 * vars (admin-only endpoint; the message safely identifies which
 * pattern failed to compile).
 */
export class ImageAllowlistConfigError extends Error {
  readonly badPattern: string
  constructor(badPattern: string, cause: Error) {
    super(
      `MC_FLEET_IMAGE_REGISTRY_ALLOWLIST entry is not a valid regex: ${JSON.stringify(badPattern)} (${cause.message})`,
    )
    this.name = 'ImageAllowlistConfigError'
    this.badPattern = badPattern
  }
}

function imageRegistryAllowlist(): RegExp[] {
  const env = process.env.MC_FLEET_IMAGE_REGISTRY_ALLOWLIST
  const prefixes = env
    ? env.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_IMAGE_REGISTRY_PREFIXES
  return prefixes.map((p) => {
    try {
      return new RegExp(`^${p}`)
    } catch (err) {
      throw new ImageAllowlistConfigError(p, err as Error)
    }
  })
}

function validateOpenClawInput(
  input: openclaw.OpenClawAgentInput,
  prefix?: string,
): void {
  if (!AGENT_NAME_RE.test(input.agentName)) {
    throw new Error(
      `agentName must match ${AGENT_NAME_RE}; got ${JSON.stringify(input.agentName)}`,
    )
  }
  // Combined target-group-name length cap (AWS 32-char limit on
  // ELBv2 target group names). Only enforced when prefix is provided
  // — handlers always pass it; input-only unit tests can omit it.
  // Round-3b.2 round-2 audit moved this from the handler-only
  // pre-check into validateInput for layering symmetry with the
  // other input constraints.
  if (typeof prefix === 'string') {
    const tgName = openclaw.targetGroupName(prefix, input.agentName)
    if (tgName.length > openclaw.TARGET_GROUP_NAME_MAX_LENGTH) {
      const maxName = openclaw.maxAgentNameLengthForPrefix(prefix)
      throw new Error(
        `agentName too long for this deployment: target group name "${tgName}" ` +
          `is ${tgName.length} chars, AWS limit is ${openclaw.TARGET_GROUP_NAME_MAX_LENGTH}. ` +
          `Max agentName length here is ${maxName}.`,
      )
    }
  }
  // Image must contain a tag/digest separator AND have something after
  // it. `img:` (empty tag) passes a naive includes(':') check but ECS
  // rejects it as InvalidParameterException at RegisterTaskDefinition,
  // surfacing as a confusing 502 to the operator. Mirror the client-
  // side `lastTagSegment.length > 0` check (panels/create-agent-form.tsx)
  // here so a direct POST that bypasses the form gets the same clean
  // 400 ValidationError instead of an opaque AWS-layer 502. Round-9
  // audit on PR #37.
  if (
    !input.image ||
    !input.image.includes(':') ||
    !(input.image.split(':').at(-1) ?? '')
  ) {
    throw new Error(
      'image must be a fully-qualified container ref with a non-empty tag or digest',
    )
  }
  if (input.image.length > IMAGE_MAX_BYTES) {
    throw new Error(
      `image must be ≤ ${IMAGE_MAX_BYTES} bytes; got ${input.image.length}`,
    )
  }
  const allowlist = imageRegistryAllowlist()
  if (!allowlist.some((re) => re.test(input.image))) {
    throw new Error(
      `image registry not in allowlist; got ${JSON.stringify(input.image)}. ` +
        `Set MC_FLEET_IMAGE_REGISTRY_ALLOWLIST (comma-separated regex prefixes) to override the default.`,
    )
  }
  if (!input.roleDescription.trim()) {
    throw new Error('roleDescription is required')
  }
  if (input.roleDescription.length > ROLE_DESCRIPTION_MAX_BYTES) {
    throw new Error(
      `roleDescription must be ≤ ${ROLE_DESCRIPTION_MAX_BYTES} bytes; got ${input.roleDescription.length}`,
    )
  }
}

export const HARNESS_TEMPLATES: Record<HarnessType, HarnessTemplate> = {
  'companion/openclaw': {
    renderTaskDefinition: openclaw.renderTaskDefinition,
    renderTargetGroup: openclaw.renderTargetGroup,
    renderService: openclaw.renderService,
    renderListenerRule: openclaw.renderListenerRule,
    validateInput: validateOpenClawInput,
  },
}

export type {
  OpenClawAgentInput,
  OpenClawAgentEnv,
  AgentListenerRuleSpec,
} from './openclaw'
