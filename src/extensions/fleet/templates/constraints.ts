/**
 * Shared input constraints for the create-agent flow.
 *
 * Lives in a separate file (no AWS SDK imports) so the constants are
 * safe to import from client components — pulling them through
 * templates/index.ts or templates/openclaw.ts would drag the AWS SDK
 * into the browser bundle. The Fleet panel's create-agent form
 * imports directly from this module.
 *
 * Server-side validation lives in:
 *   - templates/index.ts (validateOpenClawInput) — per-harness defense.
 *   - api/agents.ts (isCreateAgentRequest) — harness-agnostic type guard.
 *
 * Both server-side validators reuse the constants below — the regex
 * literal in particular is load-bearing as a security control (see the
 * IAM ARN-pattern note in api/agents.ts and the `task_ecs_write`
 * IAM grant in ender-stack/terraform/modules/iam/main.tf).
 */

export const HARNESS_TYPES = ['companion/openclaw'] as const
export type HarnessType = (typeof HARNESS_TYPES)[number]

export const MODEL_TIERS = ['opus-4-7', 'sonnet-4-6', 'haiku-4-5'] as const
export type ModelTier = (typeof MODEL_TIERS)[number]

/**
 * agentName must:
 * - start with a lowercase letter (AWS resource-name rules + simpler
 *   IAM ARN templating).
 * - contain only [a-z0-9-] in the middle.
 * - end with an alphanumeric (no trailing hyphens — ELBv2 + ECS reject
 *   names that end in `-`).
 * - be 3-32 chars total (the {1,30} middle window plus the start and
 *   end anchors). Combined-name caps (`{prefix}-agent-{name}` ≤ 32 for
 *   target groups) are enforced separately by validateOpenClawInput.
 *
 * This regex is the load-bearing security control on
 * `ecs:RegisterTaskDefinition` (granted Resource:"*" with no
 * resource-level auth). A compromised admin token cannot register a
 * task-def with an arbitrary family name like `litellm` because the
 * regex constrains the `agentName` slot in the templated family.
 */
export const AGENT_NAME_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/

/**
 * Caps mirror the rationale that drove dropping slackWebhookUrl —
 * task-def revisions are immutable and retained indefinitely, so an
 * unbounded admin input becomes permanent storage anyone with
 * `ecs:DescribeTaskDefinition` can read.
 */
export const ROLE_DESCRIPTION_MAX_BYTES = 1024
export const IMAGE_MAX_BYTES = 512
