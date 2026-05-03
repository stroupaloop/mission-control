#!/usr/bin/env node
/**
 * IAM-coverage check — fails CI if a fleet handler invokes an AWS API
 * call that isn't granted by the MC task role's `task_ecs_write` policy
 * in ender-stack.
 *
 * Catches the bug class that bit Beat 4c: the DELETE handler called
 * `ecs:ListTaskDefinitions` (a non-delete verb that the original IAM
 * survey missed) and 403'd in dev on the first real attempt. This
 * script enumerates every `*Command` constructor in the fleet
 * handlers, maps each to its IAM action name, and asserts the action
 * is in the granted list below.
 *
 * Contract:
 *   GRANTED_ACTIONS is the source of truth for "what the MC task role
 *   can do" in dev. This list MUST be kept in sync with
 *   ender-stack/terraform/modules/iam/main.tf — specifically the
 *   `task_ecs_write` policy document and the per-instance task-role
 *   grants attached above it.
 *
 *   When ender-stack adds an IAM grant, this list updates in lockstep
 *   (a PR-pair: ender-stack IAM PR + MC list-update PR). When MC adds
 *   a new SDK call, this check fails until the IAM PR + list update
 *   land.
 *
 * Why hardcoded vs Terraform-parsed:
 *   Parsing HCL adds a dependency + complexity for marginal benefit.
 *   The hardcoded list is brittle by design — if ender-stack and MC
 *   drift, this check fails at PR-time, not in dev. That's the
 *   intended contract.
 *
 * Usage:
 *   node scripts/check-iam-coverage.mjs
 *   pnpm iam:coverage
 *
 * Exit codes:
 *   0 — every command in fleet handlers has a corresponding granted action
 *   1 — one or more commands are uncovered (CI fail)
 */

import fs from 'node:fs'
import path from 'node:path'

// ---------------------------------------------------------------------------
// GRANTED_ACTIONS — keep in sync with ender-stack/terraform/modules/iam/main.tf
// ---------------------------------------------------------------------------
//
// Last verified against ender-stack main: 2026-05-02 (post-PR #266).
//
// Categorized by the policy/role that grants the action. The MC task
// role inherits all of these via attachments in
// `task_ecs_write`/`task_ecs_read`/related policies.
const GRANTED_ACTIONS = new Set([
  // task_ecs_read (read-only enumeration)
  'ecs:ListServices',
  'ecs:DescribeServices',
  'ecs:DescribeClusters',

  // task_ecs_write — service lifecycle
  'ecs:CreateService',
  'ecs:UpdateService',
  'ecs:DeleteService',
  'ecs:RegisterTaskDefinition',
  'ecs:DeregisterTaskDefinition',
  'ecs:DescribeTaskDefinition',
  'ecs:ListTaskDefinitions',
  'ecs:TagResource',
  'ecs:UntagResource',

  // task_ecs_write — IAM passrole for ECS task launch
  'iam:PassRole',

  // task_ecs_write — ELBv2 listener/rule/TG management on shared agents ALB
  'elasticloadbalancing:DescribeLoadBalancers',
  'elasticloadbalancing:DescribeTargetGroups',
  'elasticloadbalancing:DescribeListeners',
  'elasticloadbalancing:DescribeRules',
  'elasticloadbalancing:CreateRule',
  'elasticloadbalancing:DeleteRule',
  'elasticloadbalancing:CreateTargetGroup',
  'elasticloadbalancing:DeleteTargetGroup',
  'elasticloadbalancing:RegisterTargets',
  'elasticloadbalancing:DeregisterTargets',
  'elasticloadbalancing:AddTags',

  // task_ecs_write — CloudWatch log lifecycle for per-agent groups
  'logs:CreateLogGroup',
  'logs:DeleteLogGroup',
  'logs:PutRetentionPolicy',
  'logs:DescribeLogGroups',
])

// AWS SDK package → IAM service prefix mapping. PascalCase Command
// names get prefixed with this.
const SDK_TO_IAM_PREFIX = {
  '@aws-sdk/client-ecs': 'ecs',
  '@aws-sdk/client-elastic-load-balancing-v2': 'elasticloadbalancing',
  '@aws-sdk/client-cloudwatch-logs': 'logs',
  '@aws-sdk/client-iam': 'iam',
  '@aws-sdk/client-ec2': 'ec2',
  '@aws-sdk/client-secretsmanager': 'secretsmanager',
  '@aws-sdk/client-ssm': 'ssm',
}

// ---------------------------------------------------------------------------
// Scan handler files
// ---------------------------------------------------------------------------

function findHandlerFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      // Skip __tests__ — test files mock the SDK so their `Command`
      // references aren't real runtime calls.
      if (entry.name === '__tests__') continue
      findHandlerFiles(full, out)
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

/**
 * Parse an SDK import block to map Command names to their IAM service
 * prefix. Handles both single-line and multi-line forms.
 *
 * Example matches:
 *   import { Foo, Bar } from '@aws-sdk/client-ecs'
 *   import {
 *     RegisterTaskDefinitionCommand,
 *     CreateServiceCommand,
 *     type Service,
 *   } from '@aws-sdk/client-ecs'
 */
function extractCommandsFromFile(source) {
  const commands = new Map() // CommandName → iamPrefix

  // Multi-line import regex: capture the imports list and the package.
  const importRe =
    /import\s*\{\s*([\s\S]*?)\s*\}\s*from\s*['"]([^'"]+)['"]/g
  let match
  while ((match = importRe.exec(source)) !== null) {
    const importsBody = match[1]
    const pkg = match[2]
    const iamPrefix = SDK_TO_IAM_PREFIX[pkg]
    if (!iamPrefix) continue
    // Split by comma; each fragment may have `type Foo` or just `Foo`
    // or trailing comments.
    for (const raw of importsBody.split(',')) {
      const fragment = raw.trim().replace(/^type\s+/, '')
      if (!fragment) continue
      // Drop trailing single-line comments and renames like `as X`.
      const name = fragment.split(/\s|\/\//)[0]
      if (/Command$/.test(name)) {
        commands.set(name, iamPrefix)
      }
    }
  }
  return commands
}

/** PascalCase Command name → IAM action. Drops the trailing `Command`. */
function commandToAction(commandName, iamPrefix) {
  const verb = commandName.replace(/Command$/, '')
  return `${iamPrefix}:${verb}`
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const HANDLER_DIR = 'src/extensions/fleet/api'

function main() {
  const root = process.cwd()
  const handlerDir = path.join(root, HANDLER_DIR)
  const files = findHandlerFiles(handlerDir)

  const violations = []
  const allActions = new Set()

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8')
    const commands = extractCommandsFromFile(source)
    for (const [name, prefix] of commands) {
      const action = commandToAction(name, prefix)
      allActions.add(action)
      if (!GRANTED_ACTIONS.has(action)) {
        violations.push({ file: path.relative(root, file), action, command: name })
      }
    }
  }

  console.log('IAM coverage check')
  console.log(`- handler files scanned: ${files.length}`)
  console.log(`- distinct AWS actions used: ${allActions.size}`)
  console.log(`- granted actions in policy: ${GRANTED_ACTIONS.size}`)
  console.log()

  if (violations.length === 0) {
    console.log('✅ IAM coverage OK — every fleet-handler AWS call is granted')
    process.exit(0)
  }

  console.error(`❌ IAM coverage gaps (${violations.length}):`)
  for (const v of violations) {
    console.error(`   ${v.file}: ${v.command} → action "${v.action}" not in GRANTED_ACTIONS`)
  }
  console.error()
  console.error(
    'Fix: add the missing action(s) to the MC task role policy in\n' +
      '  ender-stack/terraform/modules/iam/main.tf (task_ecs_write or related)\n' +
      'AND update GRANTED_ACTIONS in this script to match. Both must move\n' +
      'together — the script + the IAM policy are the dual contract.',
  )
  process.exit(1)
}

main()
