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

/**
 * Minimum allowed agentName length. Encoded structurally in
 * AGENT_NAME_RE (1 start + 1 middle + 1 end = 3 chars min), but
 * exported separately so callers comparing against the cap (e.g.
 * harness-defaults's degenerate-prefix gate) don't have to reverse-
 * engineer it from the regex literal. Round-4 audit on PR #39
 * caught the off-by-two when the gate compared against 0 instead of
 * the regex min.
 */
export const AGENT_NAME_MIN_LENGTH = 3

/**
 * agentName must:
 * - start with an alphanumeric (no leading hyphen — ELBv2 + ECS
 *   reject names with leading hyphens).
 * - contain only [a-z0-9-] in the middle.
 * - end with an alphanumeric (no trailing hyphens — same reason).
 * - be 3-32 chars total (the {1,30} middle window plus start + end
 *   anchors). Combined-name caps (`{prefix}-agent-{name}` ≤ 32 for
 *   target groups) are enforced separately by validateOpenClawInput.
 *
 * Note: the 32-char upper bound here is aspirational for any
 * non-empty deployment prefix. With OpenClaw's `{prefix}-agent-`
 * overhead (prefix + 7 chars), no real deployment can use the full
 * 32. The AWS target-group-name limit (TARGET_GROUP_NAME_MAX_LENGTH
 * in templates/openclaw.ts) is the operative cap; the regex's `{1,30}`
 * literal would need a manual update if AWS ever raises the TG-name
 * limit. Round-7 audit on PR #39 flagged the implicit coupling.
 *
 * Digit-start is permitted: AWS doesn't require letter-start for ECS
 * service names, ECS task-def families, or ELBv2 target group names
 * (verified against the AWS Service Authorization Reference). Names
 * like `2026-04-30-bot` (date prefix) are valid and useful for
 * operators tracking creation dates.
 *
 * This regex is the load-bearing security control on
 * `ecs:RegisterTaskDefinition` (granted Resource:"*" with no
 * resource-level auth). A compromised admin token cannot register a
 * task-def with an arbitrary family name like `litellm` because the
 * regex constrains the `agentName` slot in the templated family.
 */
export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/

/**
 * Caps mirror the rationale that drove dropping slackWebhookUrl —
 * task-def revisions are immutable and retained indefinitely, so an
 * unbounded admin input becomes permanent storage anyone with
 * `ecs:DescribeTaskDefinition` can read.
 */
export const ROLE_DESCRIPTION_MAX_BYTES = 1024
export const IMAGE_MAX_BYTES = 512
