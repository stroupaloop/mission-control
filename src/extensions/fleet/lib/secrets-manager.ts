/**
 * Secrets Manager wrapper — Phase 2.4 Beat 5b.2.
 *
 * Encapsulates the per-agent Slack secret lifecycle for the
 * credential-paste handler:
 *   - Construct fully-qualified secret name + ARN from the env-var
 *     prefix (`MC_AGENT_SECRETS_NAME_PREFIX`) + agent name + secret
 *     type (`slack-app-token` / `slack-bot-token` / `slack-signing-secret`).
 *   - Put-or-Create idempotency: attempts `PutSecretValue` first;
 *     on `ResourceNotFoundException` falls through to `CreateSecret`
 *     with tags. This is the auditor-recommended pattern over
 *     describe-first (avoids the TOCTOU window flagged on Beat 5a
 *     round-3 audit, ender-stack#268).
 *
 * The IAM contract this assumes (provisioned by Beat 5a, ender-stack
 * #268): MC's task role has Create/Put/Tag/Describe on
 * `${project}/${env}/companion-openclaw-*-slack-*`. Outside that
 * scope every call 403s.
 */

import {
  SecretsManagerClient,
  CreateSecretCommand,
  PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager'

const AWS_REGION_AT_LOAD = process.env.AWS_REGION || 'us-east-1'
const secretsClient = new SecretsManagerClient({ region: AWS_REGION_AT_LOAD })

/** The three Slack secret types Phase-2.4 stores per agent. */
export type SlackSecretType =
  | 'slack-app-token'
  | 'slack-bot-token'
  | 'slack-signing-secret'

export const SLACK_SECRET_TYPES: readonly SlackSecretType[] = [
  'slack-app-token',
  'slack-bot-token',
  'slack-signing-secret',
] as const

export interface SlackSecretArns {
  appToken: string
  botToken: string
  signingSecret: string
}

/**
 * Build the full secret name from prefix + agent name + type.
 * Mirrors the IAM scope pattern in
 * `ender-stack/terraform/modules/iam/main.tf::SecretsManagerWriteAgentSlack`
 * (`${project}/${env}/companion-openclaw-*-slack-*`).
 */
export function secretName(
  prefix: string,
  agentName: string,
  type: SlackSecretType,
): string {
  return `${prefix}-${agentName}-${type}`
}

/**
 * Resolve the env-injected `MC_AGENT_SECRETS_NAME_PREFIX`. Throws
 * with a clear ConfigurationError message if unset, matching the
 * `getMissingEnv` pattern in the create-agent handler. Phase-2.4
 * Beat 5a wires this env var; deployments without that wiring
 * (partial environments) should fail fast with an actionable
 * message rather than 403 deep inside a SecretsManager call.
 */
export function requireSecretsPrefix(): string {
  const prefix = process.env.MC_AGENT_SECRETS_NAME_PREFIX
  if (!prefix) {
    const err = new Error(
      'MC_AGENT_SECRETS_NAME_PREFIX is not set. Slack credentials cannot be stored without it.',
    )
    err.name = 'ConfigurationError'
    throw err
  }
  return prefix
}

/**
 * Build the platform-required tag set for a per-agent Slack secret.
 * Matches the tag conventions from the surrounding agent resources
 * (ECS service / target group / log group). Tags are set at
 * CreateSecret time only; subsequent PutSecretValue calls don't
 * touch them (the IAM grant doesn't include UntagResource —
 * removed per Beat 5a round-2 audit).
 */
function defaultTags(
  projectName: string,
  environment: string,
  agentName: string,
  secretType: SlackSecretType,
): Array<{ Key: string; Value: string }> {
  return [
    { Key: 'Project', Value: projectName },
    { Key: 'Environment', Value: environment },
    { Key: 'Owner', Value: 'mission-control' },
    { Key: 'ManagedBy', Value: 'mission-control' },
    { Key: 'Component', Value: 'agent-credential' },
    { Key: 'AgentName', Value: agentName },
    { Key: 'SecretType', Value: secretType },
  ]
}

interface PutOrCreateInput {
  name: string
  value: string
  description: string
  /** Tags applied only on CreateSecret; ignored on the PutSecretValue path. */
  tags: Array<{ Key: string; Value: string }>
}

interface PutOrCreateResult {
  /** ARN of the secret after the operation. */
  arn: string
  /** Which path the call took — useful for logging + tests. */
  operation: 'created' | 'updated'
}

/**
 * Put-or-Create idempotent write. Attempts `PutSecretValue` first
 * (cheaper path for the common case where the operator is rotating
 * existing tokens). On `ResourceNotFoundException`, falls through
 * to `CreateSecret` with tags.
 *
 * Why not describe-first: that would have a TOCTOU window where
 * two concurrent paste requests both see "not exists" and both
 * call CreateSecret, with one throwing ResourceExistsException.
 * Put-then-create flips the race so the safer call (Put) is the
 * default, and only an explicit not-found triggers the create
 * branch. Round-3 audit on ender-stack#268 explicitly flagged this
 * pattern preference.
 */
export async function putOrCreateSecret(
  input: PutOrCreateInput,
): Promise<PutOrCreateResult> {
  try {
    const resp = await secretsClient.send(
      new PutSecretValueCommand({
        SecretId: input.name,
        SecretString: input.value,
      }),
    )
    // PutSecretValue succeeded — the secret already existed and we
    // updated its value. ARN should always be set per the SDK
    // contract.
    //
    // Round-3 audit on PR #48 (P1): if ARN was missing, the prior
    // shape returned `{ arn: '', operation: 'updated' }` — which
    // silently propagated through writeSlackSecrets into the
    // task-def's `secrets[].valueFrom`, causing an opaque ECS
    // crash-loop at task-launch (the awslogs/exec path can't
    // resolve `valueFrom: ''`). Throw loudly instead so the
    // operator's POST returns a clear 502 + retry-is-safe hint
    // rather than registering a broken task-def.
    //
    // Round-1 Greptile P2 already eliminated the worse failure of
    // falling through to CreateSecret on missing ARN (which would
    // throw ResourceExistsException). This change closes the
    // remaining silent-fail path.
    if (!resp.ARN) {
      const err = new Error(
        `PutSecretValue for "${input.name}" returned no ARN — refusing to register a task-def with an empty valueFrom. AWS SDK anomaly; safe to retry.`,
      )
      err.name = 'PutSecretValueMissingArn'
      throw err
    }
    return { arn: resp.ARN, operation: 'updated' }
  } catch (err) {
    const name = (err as { name?: string })?.name
    if (name !== 'ResourceNotFoundException') throw err
    // Fall through to create — the secret didn't exist, so this
    // can't race with a successful put.
    const resp = await secretsClient.send(
      new CreateSecretCommand({
        Name: input.name,
        SecretString: input.value,
        Description: input.description,
        Tags: input.tags,
      }),
    )
    return { arn: resp.ARN ?? '', operation: 'created' }
  }
}

export interface WriteSlackSecretsInput {
  agentName: string
  projectName: string
  environment: string
  /** xapp-… app-level token for Socket Mode. */
  appToken: string
  /** xoxb-… bot user OAuth token. */
  botToken: string
  /** 64-char hex signing secret. */
  signingSecret: string
}

/**
 * Write all three Slack secrets for an agent. Returns the ARNs
 * keyed by type so the caller can inject them into the task-def
 * `secrets:` field.
 *
 * Failure semantics: if any write fails, the partial ARNs map is
 * lost (we don't track what got written before the failure here).
 * The caller's outer catch should surface a 502 with what AWS
 * returned. A targeted retry (re-paste) cleans up — the
 * Put-or-Create idempotency means re-running succeeds.
 */
export async function writeSlackSecrets(
  input: WriteSlackSecretsInput,
): Promise<SlackSecretArns> {
  const prefix = requireSecretsPrefix()

  const writes = await Promise.all(
    SLACK_SECRET_TYPES.map(async (type) => {
      const name = secretName(prefix, input.agentName, type)
      const value =
        type === 'slack-app-token'
          ? input.appToken
          : type === 'slack-bot-token'
            ? input.botToken
            : input.signingSecret
      const description = `${type} for agent ${input.agentName} (Mission Control)`
      const result = await putOrCreateSecret({
        name,
        value,
        description,
        tags: defaultTags(
          input.projectName,
          input.environment,
          input.agentName,
          type,
        ),
      })
      return { type, ...result }
    }),
  )

  const byType = new Map(writes.map((w) => [w.type, w.arn]))
  return {
    appToken: byType.get('slack-app-token') ?? '',
    botToken: byType.get('slack-bot-token') ?? '',
    signingSecret: byType.get('slack-signing-secret') ?? '',
  }
}
