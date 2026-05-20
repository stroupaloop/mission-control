/**
 * SSM bridge for Slack channel config — ender-stack#470 / #473.
 *
 * Companion-openclaw's Terraform module reads a per-agent SecureString
 * SSM param at `/${project}/${env}/companion-openclaw/${agent}/slack-config`
 * and injects its value as `OPENCLAW_SLACK_CONFIG_JSON` on the init
 * container at `terraform apply` time. Without this helper, the SSM
 * param stays at its bootstrap sentinel (`__unset__`) forever and the
 * next `terraform apply` wipes the env var that MC wrote out-of-band
 * via `RegisterTaskDefinition`.
 *
 * Both the credentials POST and the channels PUT call this AFTER
 * `RegisterTaskDefinition` succeeds and BEFORE `UpdateService`. If the
 * SSM write fails we log and continue — the task-def we just registered
 * still carries the config, so the operator's intent lands on this
 * deploy; the only thing lost is drift-resistance on the next
 * `terraform apply`, which is a re-paste away from being re-armed.
 *
 * IAM grant: `task_ssm_slack_config` in ender-stack
 * `terraform/modules/iam/main.tf` (per-agent SSM PutParameter +
 * KMS-ViaService=ssm on the AWS-managed key). The grant is scoped to
 * the exact path pattern this helper builds, so a typo here means a
 * silent 403 rather than a security hole.
 */

import {
  SSMClient,
  PutParameterCommand,
} from '@aws-sdk/client-ssm'
import { logger } from '@/lib/logger'

const AWS_REGION_AT_LOAD = process.env.AWS_REGION || 'us-east-1'
const ssmClient = new SSMClient({ region: AWS_REGION_AT_LOAD })

export interface WriteSlackChannelConfigInput {
  /** Project name from resolveFleetPrefix() — first path segment. */
  projectName: string
  /** Environment from resolveFleetPrefix() — second path segment. */
  environment: string
  /** Agent identifier — fourth path segment. */
  agentName: string
  /** Same string that's written to OPENCLAW_SLACK_CONFIG_JSON on the task-def. */
  channelsConfigJson: string
}

export type WriteSlackChannelConfigResult =
  | { ok: true; ssmName: string }
  | { ok: false; ssmName: string; errorName: string; errorMessage: string }

/**
 * Build the SSM path. Kept as a named export so tests + handlers
 * share the literal convention. MUST match
 * `aws_ssm_parameter.slack_config.name` in
 * ender-stack `terraform/modules/companion/openclaw/main.tf`.
 */
export function slackConfigSsmName(
  projectName: string,
  environment: string,
  agentName: string,
): string {
  return `/${projectName}/${environment}/companion-openclaw/${agentName}/slack-config`
}

/**
 * Best-effort SSM write — never throws. The caller treats failure as
 * a non-fatal durability degradation, not a deploy failure.
 *
 * `Overwrite: true` is load-bearing: Terraform pre-creates the param
 * with bootstrap value `__unset__`, so the first MC write is always
 * an update, never a create.
 */
export async function writeSlackChannelConfigToSsm(
  input: WriteSlackChannelConfigInput,
): Promise<WriteSlackChannelConfigResult> {
  const ssmName = slackConfigSsmName(
    input.projectName,
    input.environment,
    input.agentName,
  )
  try {
    await ssmClient.send(
      new PutParameterCommand({
        Name: ssmName,
        Type: 'SecureString',
        Value: input.channelsConfigJson,
        Overwrite: true,
      }),
    )
    return { ok: true, ssmName }
  } catch (err) {
    const e = err as { name?: string; message?: string }
    const errorName = e.name ?? 'UnknownError'
    const errorMessage = e.message ?? String(err)
    logger.error(
      {
        agentName: input.agentName,
        ssmName,
        errorName,
        errorMessage,
      },
      '[fleet] slack-ssm-bridge: PutParameter failed — task-def env var still carries the config for this deploy, but next `terraform apply` will drift back to the SSM value. Operator may need to re-paste credentials/channels to re-arm the bridge.',
    )
    return { ok: false, ssmName, errorName, errorMessage }
  }
}
