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

export const HARNESS_TYPES = ['companion/openclaw'] as const
export type HarnessType = (typeof HARNESS_TYPES)[number]

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
  /** Validates the harness-specific shape of the form input. Throws on invalid. */
  validateInput: (input: openclaw.OpenClawAgentInput) => void
}

// Caps mirror the rationale that drove dropping slackWebhookUrl —
// task-def revisions are immutable and retained indefinitely, so an
// unbounded admin input becomes permanent storage.
const ROLE_DESCRIPTION_MAX_BYTES = 1024
const IMAGE_MAX_BYTES = 512

function validateOpenClawInput(input: openclaw.OpenClawAgentInput): void {
  if (!/^[a-z0-9-]{3,32}$/.test(input.agentName)) {
    throw new Error(
      `agentName must match /^[a-z0-9-]{3,32}$/; got ${JSON.stringify(input.agentName)}`,
    )
  }
  if (!input.image || !input.image.includes(':')) {
    throw new Error(
      'image must be a fully-qualified container ref including a tag or digest',
    )
  }
  if (input.image.length > IMAGE_MAX_BYTES) {
    throw new Error(
      `image must be ≤ ${IMAGE_MAX_BYTES} bytes; got ${input.image.length}`,
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
