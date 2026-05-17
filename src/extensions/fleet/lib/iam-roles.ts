/**
 * Per-agent IAM task + execution role lifecycle (#134).
 *
 * Mints / tears down the two-role pair that backs each MC-created
 * agent. Sits inside the IAM grants ender-stack PR #381 added to MC's
 * task role:
 *
 *   - `iam:CreateRole` gated on
 *     `iam:PermissionsBoundary = mc_agent_permissions_boundary` AND
 *     `aws:RequestTag/ManagedBy = mission-control` AND
 *     `aws:RequestTag/Component = companion-openclaw`.
 *   - `iam:PutRolePolicy` + `iam:DeleteRolePolicy` + `iam:DeleteRole`
 *     gated on `aws:ResourceTag/ManagedBy = mission-control`.
 *   - `iam:TagRole` gated on both `aws:ResourceTag/ManagedBy` AND
 *     `aws:RequestTag/ManagedBy = mission-control`.
 *   - `iam:AttachRolePolicy` + `iam:DetachRolePolicy` scoped to the
 *     `-exec` role family AND `iam:PolicyARN =
 *     arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy`.
 *
 * Any deviation from those conditions → 403. The conditions are the
 * isolation primitive — without them MC's task role could create an
 * arbitrary role and AssumeRole into it.
 *
 * Cross-cutting invariants (validated by tests):
 *   1. **Trust policy is a frozen literal.** AWS provides no IAM
 *      condition to constrain `AssumeRolePolicyDocument` content, so
 *      a compromised MC could otherwise CreateRole with
 *      `Principal: {"AWS": "*"}`. We don't accept the trust policy as
 *      a parameter; it's a constant. See `TRUST_POLICY` below.
 *   2. **`ManagedBy=mission-control` is always tagged.** The
 *      `aws:RequestTag/ManagedBy` condition implicit-denies otherwise.
 *      Centralized in `mintTags()` so callers can't accidentally drop
 *      it on a partial-update path.
 *   3. **Inline policy secret ARN uses `{agentName}-*`, not `*`.** The
 *      permissions boundary caps at `companion-openclaw-*` (i.e., all
 *      agents' secrets); the per-agent inline policy is the
 *      load-bearing isolation primitive that prevents cross-agent
 *      reads within the namespace. Code review the ARN template.
 *   4. **`CreateRole` is idempotent on retry.** `EntityAlreadyExists`
 *      from a previous partial create is caught + treated as the
 *      success path (`GetRole` to recover the ARN). Surrounding
 *      handlers run this on the create path before any other
 *      provisioning, so a retried create that finds an existing role
 *      should continue forward, not 502. Memory items #4-#5 from
 *      `project_phase2_resequencing` lock this contract.
 *   5. **Recreate-on-trust-policy-change.** `iam:UpdateAssumeRolePolicy`
 *      is NOT granted to MC, so a deployed role's trust policy is
 *      effectively immutable. If `TRUST_POLICY` changes here, the
 *      operator path is delete + recreate (no in-place migration).
 *
 * IAM contract this assumes (provisioned by ender-stack PR #381):
 *   - `module.iam.mc_agent_permissions_boundary_arn` ARN is exported
 *     and passed to MC as `MC_AGENT_PERMISSIONS_BOUNDARY_ARN`.
 *   - The shared exec role's `KMSDecryptSecrets` statement
 *     (`mc_agent_shared_execution` in modules/iam/main.tf) sets the
 *     pattern for the per-agent exec role's `kms:Decrypt` grant —
 *     mirror it.
 *   - The shared task role's `CloudWatchLogsAgentWildcard` +
 *     `SecretsManagerReadAgentWildcard` statements
 *     (`mc_agent_shared_task` in modules/iam/main.tf) set the pattern
 *     for the per-agent task role's inline policy — mirror them,
 *     scoped to `{agentName}-*`.
 */

import {
  IAMClient,
  CreateRoleCommand,
  GetRoleCommand,
  PutRolePolicyCommand,
  DeleteRolePolicyCommand,
  AttachRolePolicyCommand,
  DetachRolePolicyCommand,
  DeleteRoleCommand,
} from '@aws-sdk/client-iam'

const AWS_REGION_AT_LOAD = process.env.AWS_REGION || 'us-east-1'
const iamClient = new IAMClient({ region: AWS_REGION_AT_LOAD })

/**
 * Frozen trust policy. ECS tasks can assume the role; no other
 * principal. See invariant #1 in the file header. Stringified once at
 * module load so the comparison in tests is byte-exact and there's no
 * way for a future refactor to thread caller input into the trust
 * policy.
 */
export const TRUST_POLICY = JSON.stringify({
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Principal: { Service: 'ecs-tasks.amazonaws.com' },
      Action: 'sts:AssumeRole',
    },
  ],
})

/**
 * AWS-managed ECS task-execution policy ARN. Pinned literal so a typo
 * in a caller can't redirect `AttachRolePolicy` at a different policy
 * (MC's grant is also pinned to this exact ARN by `iam:PolicyARN`
 * condition, so a mismatch would 403 anyway; this is defense-in-depth).
 */
export const MANAGED_EXEC_POLICY_ARN =
  'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy'

/** Inline-policy name used for both task + exec roles. */
const INLINE_POLICY_NAME = 'inline'

export interface RoleNames {
  taskRoleName: string
  executionRoleName: string
}

/**
 * Build the deterministic role-name pair. Matches the IAM grant's
 * resource scope `arn:aws:iam::{account}:role/{prefix}-companion-openclaw-*-{task,exec}`
 * (modules/iam/main.tf `IAMModifyMCManagedAgentRoles`). Single source
 * of truth — never construct these names inline elsewhere.
 */
export function roleNames(prefix: string, agentName: string): RoleNames {
  return {
    taskRoleName: `${prefix}-companion-openclaw-${agentName}-task`,
    executionRoleName: `${prefix}-companion-openclaw-${agentName}-exec`,
  }
}

interface MintTagsInput {
  projectName: string
  environment: string
  agentName: string
}

/**
 * Tag set applied at CreateRole. `ManagedBy=mission-control` is
 * load-bearing per invariant #2 — the `aws:RequestTag/ManagedBy`
 * condition on `iam:CreateRole` implicit-denies otherwise.
 * `Component=companion-openclaw` is also conditioned. The remaining
 * tags mirror the convention used elsewhere in fleet/ (cf.
 * lib/secrets-manager.ts:97-112).
 */
function mintTags(
  input: MintTagsInput,
): Array<{ Key: string; Value: string }> {
  return [
    { Key: 'Project', Value: input.projectName },
    { Key: 'Environment', Value: input.environment },
    { Key: 'Owner', Value: 'mission-control' },
    { Key: 'ManagedBy', Value: 'mission-control' },
    { Key: 'Component', Value: 'companion-openclaw' },
    { Key: 'AgentName', Value: input.agentName },
  ]
}

export interface MintAgentRolesInput {
  agentName: string
  prefix: string
  boundaryArn: string
  accountId: string
  region: string
  secretsKmsKeyArn: string
  /** e.g. `ender-stack/dev/companion-openclaw` — handler appends `-{agent}-*`. */
  secretsNamePrefix: string
  /** e.g. `/ecs/ender-stack-dev` — handler appends `/companion-openclaw-{agent}-*`. */
  logGroupPrefix: string
  projectName: string
  environment: string
}

export interface MintAgentRolesResult {
  taskRoleArn: string
  executionRoleArn: string
  taskRoleName: string
  executionRoleName: string
}

/**
 * Build the per-agent TASK role inline policy. Mirrors the shared
 * task role's `mc_agent_shared_task` data source in
 * ender-stack/terraform/modules/iam/main.tf:1573, scoped to
 * `{agentName}-*` instead of `*`. SSM Messages is inlined here
 * (rather than attached via managed policy) because MC's
 * `iam:AttachRolePolicy` grant is gated to the AWS ECS exec policy
 * only — anything else 403s.
 */
function renderTaskInlinePolicy(input: MintAgentRolesInput): string {
  const { agentName, accountId, region, secretsNamePrefix, logGroupPrefix } =
    input
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'AgentSecretsRead',
        Effect: 'Allow',
        Action: 'secretsmanager:GetSecretValue',
        Resource: `arn:aws:secretsmanager:${region}:${accountId}:secret:${secretsNamePrefix}-${agentName}-*`,
      },
      {
        Sid: 'AgentLogWrites',
        Effect: 'Allow',
        Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        Resource: [
          `arn:aws:logs:${region}:${accountId}:log-group:${logGroupPrefix}/companion-openclaw-${agentName}-*`,
          `arn:aws:logs:${region}:${accountId}:log-group:${logGroupPrefix}/companion-openclaw-${agentName}-*:*`,
        ],
      },
      {
        Sid: 'AgentExecuteCommandSession',
        Effect: 'Allow',
        Action: [
          'ssmmessages:CreateControlChannel',
          'ssmmessages:CreateDataChannel',
          'ssmmessages:OpenControlChannel',
          'ssmmessages:OpenDataChannel',
        ],
        Resource: '*',
      },
    ],
  })
}

/**
 * Build the per-agent EXEC role inline policy. Mirrors
 * `mc_agent_shared_execution` (ender-stack
 * terraform/modules/iam/main.tf:1514), scoped to `{agentName}-*` for
 * secrets/logs and pinned to the platform's secrets KMS key for
 * decrypt. `kms:DescribeKey` is included alongside `kms:Decrypt` —
 * the boundary caps both, and DescribeKey is required for some KMS
 * client paths that pre-flight key state before Decrypt.
 *
 * Note: `logs:CreateLogGroup` is included here as a defense-in-depth
 * fallback for `awslogs-create-group: true` on the task-def (matches
 * the shared exec role's posture). MC's create-agent handler
 * pre-creates the log group via the SDK on its own task role's
 * `logs:CreateLogGroup` grant; this exec-side grant only fires if the
 * SDK pre-create is skipped or fails.
 */
function renderExecInlinePolicy(input: MintAgentRolesInput): string {
  const {
    agentName,
    accountId,
    region,
    secretsKmsKeyArn,
    secretsNamePrefix,
    logGroupPrefix,
  } = input
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'AgentSecretsRead',
        Effect: 'Allow',
        Action: 'secretsmanager:GetSecretValue',
        Resource: `arn:aws:secretsmanager:${region}:${accountId}:secret:${secretsNamePrefix}-${agentName}-*`,
      },
      {
        Sid: 'AgentLogWrites',
        Effect: 'Allow',
        Action: [
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
        ],
        Resource: [
          `arn:aws:logs:${region}:${accountId}:log-group:${logGroupPrefix}/companion-openclaw-${agentName}-*`,
          `arn:aws:logs:${region}:${accountId}:log-group:${logGroupPrefix}/companion-openclaw-${agentName}-*:*`,
        ],
      },
      {
        Sid: 'KMSDecryptSecrets',
        Effect: 'Allow',
        // kms:Decrypt only — kms:DescribeKey is intentionally omitted
        // to match the permissions boundary's `BoundaryKMSDecryptForSecrets`
        // statement (ender-stack terraform/modules/iam/main.tf), which
        // covers `kms:Decrypt` exclusively. The shared exec role
        // (`mc_agent_shared_execution`) grants both as a historical
        // posture, but per-agent roles attach the boundary — granting
        // DescribeKey here would produce a misleading policy that
        // overstates effective permissions (the boundary implicit-
        // denies it). SM secret decryption only requires Decrypt.
        Action: 'kms:Decrypt',
        Resource: secretsKmsKeyArn,
      },
    ],
  })
}

/**
 * Mint the per-agent task + exec role pair. Atomic on the create
 * path: callers should treat a thrown error as "no roles exist" and
 * trigger the standard rollback (which calls `deleteAgentRoles` to
 * mop up any partial state, idempotently). Returns both ARNs so the
 * caller can wire them into the ECS task definition.
 *
 * Idempotency: a retried call for an agent name that already has a
 * role pair (e.g., a prior create failed AFTER CreateRole but BEFORE
 * the surrounding handler succeeded) catches `EntityAlreadyExists`,
 * issues `GetRole` to recover the ARN, and re-applies the inline
 * policy + attachment (PutRolePolicy and AttachRolePolicy are
 * idempotent by AWS spec). The handler's role-tag check is implicit:
 * if the existing role lacks `ManagedBy=mission-control` (e.g., a
 * stale Terraform-managed role), the `iam:PutRolePolicy` call will
 * 403 (per the boundary's `aws:ResourceTag/ManagedBy` condition).
 */
export async function mintAgentRoles(
  input: MintAgentRolesInput,
): Promise<MintAgentRolesResult> {
  const { taskRoleName, executionRoleName } = roleNames(
    input.prefix,
    input.agentName,
  )
  const tags = mintTags({
    projectName: input.projectName,
    environment: input.environment,
    agentName: input.agentName,
  })

  const taskRoleArn = await createOrGetRole({
    roleName: taskRoleName,
    boundaryArn: input.boundaryArn,
    tags,
  })

  const executionRoleArn = await createOrGetRole({
    roleName: executionRoleName,
    boundaryArn: input.boundaryArn,
    tags,
  })

  await iamClient.send(
    new PutRolePolicyCommand({
      RoleName: taskRoleName,
      PolicyName: INLINE_POLICY_NAME,
      PolicyDocument: renderTaskInlinePolicy(input),
    }),
  )

  await iamClient.send(
    new PutRolePolicyCommand({
      RoleName: executionRoleName,
      PolicyName: INLINE_POLICY_NAME,
      PolicyDocument: renderExecInlinePolicy(input),
    }),
  )

  // AttachRolePolicy is idempotent by AWS spec — attaching an
  // already-attached policy returns 200, no exception. Per memory
  // item #4 in project_phase2_resequencing.
  await iamClient.send(
    new AttachRolePolicyCommand({
      RoleName: executionRoleName,
      PolicyArn: MANAGED_EXEC_POLICY_ARN,
    }),
  )

  return {
    taskRoleArn,
    executionRoleArn,
    taskRoleName,
    executionRoleName,
  }
}

interface CreateOrGetRoleInput {
  roleName: string
  boundaryArn: string
  tags: Array<{ Key: string; Value: string }>
}

/**
 * CreateRole-with-fallback-to-GetRole. The idempotent-retry primitive.
 * Catches `EntityAlreadyExists` (with and without the `Exception`
 * suffix — the SDK varies) and falls through to GetRole to recover
 * the existing role's ARN.
 */
async function createOrGetRole(input: CreateOrGetRoleInput): Promise<string> {
  try {
    const resp = await iamClient.send(
      new CreateRoleCommand({
        RoleName: input.roleName,
        AssumeRolePolicyDocument: TRUST_POLICY,
        PermissionsBoundary: input.boundaryArn,
        Tags: input.tags,
      }),
    )
    const arn = resp.Role?.Arn
    if (!arn) {
      // SDK contract violation. AWS always returns Role.Arn on a
      // successful CreateRole; fail loudly so the caller surfaces a
      // 502 instead of propagating an empty string into downstream
      // task-def references.
      throw new Error(`CreateRole returned no ARN for ${input.roleName}`)
    }
    return arn
  } catch (err) {
    const name = (err as { name?: string })?.name
    if (
      name === 'EntityAlreadyExistsException' ||
      name === 'EntityAlreadyExists'
    ) {
      // Recover ARN from the existing role. The handler's caller will
      // retry PutRolePolicy + AttachRolePolicy (both idempotent), so
      // the net effect of a retried create is a fully-configured
      // role pair regardless of which step in the prior attempt
      // failed.
      const getResp = await iamClient.send(
        new GetRoleCommand({ RoleName: input.roleName }),
      )
      const arn = getResp.Role?.Arn
      if (!arn) {
        throw new Error(
          `GetRole fallback returned no ARN for ${input.roleName}`,
        )
      }
      return arn
    }
    throw err
  }
}

export interface DeleteAgentRolesInput {
  agentName: string
  prefix: string
}

export interface DeleteAgentRolesResult {
  /** True if all delete operations completed (incl. NoSuchEntity idempotency). */
  ok: true
  /**
   * Names of roles that were already gone (NoSuchEntity on first
   * touch). Mirrors the warnings shape in agents-delete.ts so the
   * outer handler can surface the idempotent path to operators.
   */
  alreadyDeleted: string[]
}

/**
 * Tear down the per-agent role pair. Order is load-bearing:
 *   1. `DetachRolePolicy` (exec → managed ECS exec policy) — must
 *      precede DeleteRole; AWS rejects DeleteRole while any policy is
 *      attached.
 *   2. `DeleteRolePolicy` (both task + exec inline) — same rule.
 *   3. `DeleteRole` (both).
 *
 * Each step suppresses `NoSuchEntity` / `NoSuchEntityException` for
 * idempotent retry: an operator re-running DELETE on a half-cleaned
 * agent finishes the job rather than 502'ing on a missing role.
 *
 * `NoSuchEntity` on a DetachRolePolicy when the role exists but the
 * policy isn't attached is also benign (e.g., a prior partial
 * create-agent never reached AttachRolePolicy).
 */
export async function deleteAgentRoles(
  input: DeleteAgentRolesInput,
): Promise<DeleteAgentRolesResult> {
  const { taskRoleName, executionRoleName } = roleNames(
    input.prefix,
    input.agentName,
  )
  const alreadyDeleted: string[] = []

  // Step 1: Detach the managed ECS exec policy from the exec role.
  await suppressNoSuchEntity(
    () =>
      iamClient.send(
        new DetachRolePolicyCommand({
          RoleName: executionRoleName,
          PolicyArn: MANAGED_EXEC_POLICY_ARN,
        }),
      ),
    () => alreadyDeleted.push(`${executionRoleName}:managed-policy`),
  )

  // Step 2: Delete inline policies on both roles.
  await suppressNoSuchEntity(
    () =>
      iamClient.send(
        new DeleteRolePolicyCommand({
          RoleName: taskRoleName,
          PolicyName: INLINE_POLICY_NAME,
        }),
      ),
    () => alreadyDeleted.push(`${taskRoleName}:inline`),
  )
  await suppressNoSuchEntity(
    () =>
      iamClient.send(
        new DeleteRolePolicyCommand({
          RoleName: executionRoleName,
          PolicyName: INLINE_POLICY_NAME,
        }),
      ),
    () => alreadyDeleted.push(`${executionRoleName}:inline`),
  )

  // Step 3: Delete the roles themselves.
  await suppressNoSuchEntity(
    () => iamClient.send(new DeleteRoleCommand({ RoleName: taskRoleName })),
    () => alreadyDeleted.push(taskRoleName),
  )
  await suppressNoSuchEntity(
    () =>
      iamClient.send(new DeleteRoleCommand({ RoleName: executionRoleName })),
    () => alreadyDeleted.push(executionRoleName),
  )

  return { ok: true, alreadyDeleted }
}

/**
 * Run an IAM SDK call, swallowing only `NoSuchEntity`-family errors
 * and invoking the `onAlready` callback so the caller can record the
 * idempotent path. Any other error re-throws.
 */
async function suppressNoSuchEntity(
  fn: () => Promise<unknown>,
  onAlready: () => void,
): Promise<void> {
  try {
    await fn()
  } catch (err) {
    const name = (err as { name?: string })?.name
    if (name === 'NoSuchEntity' || name === 'NoSuchEntityException') {
      onAlready()
      return
    }
    throw err
  }
}
