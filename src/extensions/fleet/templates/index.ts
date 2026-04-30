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

export interface HarnessTemplate<I, E> {
  renderTaskDefinition: typeof openclaw.renderTaskDefinition
  renderTargetGroup: typeof openclaw.renderTargetGroup
  renderService: typeof openclaw.renderService
  renderListenerRule: typeof openclaw.renderListenerRule
  /** Validates the harness-specific shape of the form input. Throws on invalid. */
  validateInput: (input: I) => void
  /** Sentinel — the handler reads this when constructing the log group name. */
  containerName: string
}

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
  if (!input.roleDescription.trim()) {
    throw new Error('roleDescription is required')
  }
}

export const HARNESS_TEMPLATES: Record<
  HarnessType,
  HarnessTemplate<openclaw.OpenClawAgentInput, openclaw.OpenClawAgentEnv>
> = {
  'companion/openclaw': {
    renderTaskDefinition: openclaw.renderTaskDefinition,
    renderTargetGroup: openclaw.renderTargetGroup,
    renderService: openclaw.renderService,
    renderListenerRule: openclaw.renderListenerRule,
    validateInput: validateOpenClawInput,
    containerName: 'gateway',
  },
}

export type {
  OpenClawAgentInput,
  OpenClawAgentEnv,
  AgentListenerRuleSpec,
} from './openclaw'
