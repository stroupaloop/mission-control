'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  AGENT_NAME_RE,
  HARNESS_TYPES,
  IMAGE_MAX_BYTES,
  MODEL_TIERS,
  MODEL_TIER_DEFAULT,
  ROLE_DESCRIPTION_MAX_BYTES,
  type HarnessType,
  type ModelTier,
} from '../templates/constraints'
// `import type` only — keeps server-only modules (AWS SDK, NextRequest)
// out of the client bundle. Same pattern fleet-panel.tsx uses for the
// services-API response types.
import type {
  CreateAgentResponse,
  CreateAgentErrorResponse,
} from '../api/agents'

// Phase 2.2 Beat 3b — UI form for POST /api/fleet/agents.
//
// Hosted as a collapsible section inside the Fleet panel rather than a
// new top-level route: panels.config.ts has no nested-routing surface,
// so a `/fleet/new` route would either need the panel registry to grow
// nested support OR sit as a sibling top-level panel disconnected from
// the Fleet table. Inline-toggle keeps the operator's table view in
// context next to the form.
//
// Submit path:
//   POST /api/fleet/agents → on 201: render success summary + warnings,
//   call onCreated() so the parent refreshes the Fleet table.
//   On 4xx/5xx: render the SDK error name (already-suppressed message
//   detail per the handler's response shape) + partialResources if
//   present.

interface Props {
  /** Called after a successful 201 so the parent panel can refresh the fleet table. */
  onCreated: () => void
  /** Called when the operator dismisses the form (cancel or after closing the success view). */
  onClose: () => void
}

type FormState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success'; response: CreateAgentResponse }
  | { kind: 'error'; status: number; body: CreateAgentErrorResponse }

const HARNESS_TYPE_DEFAULT: HarnessType = HARNESS_TYPES[0]

// Soft cap on the create-agent fetch. The handler runs ≥6 sequential
// AWS API calls (RegisterTaskDefinition → CreateTargetGroup →
// DescribeRules → CreateRule → CreateLogGroup → CreateService); a
// degraded service would otherwise leave the form stuck "Creating…"
// with no way for the operator to bail. 30s gives a generous buffer
// over the realistic happy-path (~3-5s) without leaving the operator
// waiting on a hanging connection. Mirrors the AbortController pattern
// fleet-panel.tsx uses for its services-list polling.
const SUBMIT_TIMEOUT_MS = 30_000

export function CreateAgentForm({ onCreated, onClose }: Props) {
  const [harnessType, setHarnessType] = useState<HarnessType>(
    HARNESS_TYPE_DEFAULT,
  )
  const [agentName, setAgentName] = useState('')
  const [image, setImage] = useState('')
  const [roleDescription, setRoleDescription] = useState('')
  const [modelTier, setModelTier] = useState<ModelTier>(MODEL_TIER_DEFAULT)
  const [state, setState] = useState<FormState>({ kind: 'idle' })

  const submitting = state.kind === 'submitting'

  // Local pre-validation before POSTing — catches the obvious failures
  // without a network round-trip. Server-side validation (in
  // templates/index.ts validateOpenClawInput + agents.ts type guard) is
  // still the authoritative gate; this layer is UX-only. Keep the rules
  // in lockstep with constraints.ts.
  const agentNameValid = AGENT_NAME_RE.test(agentName)
  const imageValid = image.length > 0 && image.includes(':') && image.length <= IMAGE_MAX_BYTES
  const roleDescriptionValid =
    roleDescription.trim().length > 0 &&
    roleDescription.length <= ROLE_DESCRIPTION_MAX_BYTES
  const formValid = agentNameValid && imageValid && roleDescriptionValid

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!formValid || submitting) return
    setState({ kind: 'submitting' })

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), SUBMIT_TIMEOUT_MS)

    let resp: Response
    try {
      resp = await fetch('/api/fleet/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        signal: ac.signal,
        body: JSON.stringify({
          harnessType,
          agentName,
          image,
          roleDescription,
          modelTier,
        }),
      })
    } catch (err) {
      // Network failure or timeout — no `Response` was received, so
      // there's no HTTP status to surface. status=0 is the correct
      // "we never got past the wire" sentinel here. AbortError fires
      // when SUBMIT_TIMEOUT_MS elapses; surface a clearer name so
      // operators distinguish a hard timeout from a generic network
      // glitch.
      const name = (err as Error).name
      const code = name === 'AbortError' ? 'SubmitTimeout' : name || 'NetworkError'
      setState({ kind: 'error', status: 0, body: { error: code } })
      return
    } finally {
      clearTimeout(timer)
    }

    // From this point we DO have a Response — `resp.status` must
    // surface even if JSON parse fails (e.g. proxy returned HTML on a
    // 502). Splitting the JSON parse into its own try/catch lets the
    // operator see "502 — ResponseParseError" instead of the
    // misleading "0 — SyntaxError" the unified catch produced.
    let body: CreateAgentResponse | CreateAgentErrorResponse
    try {
      body = (await resp.json()) as
        | CreateAgentResponse
        | CreateAgentErrorResponse
    } catch {
      setState({
        kind: 'error',
        status: resp.status,
        body: { error: 'ResponseParseError' },
      })
      return
    }

    if (resp.ok && 'ok' in body && body.ok) {
      setState({ kind: 'success', response: body })
      onCreated()
    } else {
      setState({
        kind: 'error',
        status: resp.status,
        body: body as CreateAgentErrorResponse,
      })
    }
  }

  function reset() {
    setAgentName('')
    setImage('')
    setRoleDescription('')
    setModelTier(MODEL_TIER_DEFAULT)
    setHarnessType(HARNESS_TYPE_DEFAULT)
    setState({ kind: 'idle' })
  }

  if (state.kind === 'success') {
    const r = state.response
    return (
      <div
        className="mb-4 rounded border border-green-500/50 bg-green-500/10 p-4"
        data-testid="create-agent-success"
      >
        <div className="font-medium text-green-700 mb-2">
          Agent <code>{r.agentName}</code> created
        </div>
        <dl className="text-xs grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 mb-3">
          <dt className="text-muted-foreground">Service</dt>
          <dd className="font-mono break-all">{r.resources.serviceArn}</dd>
          <dt className="text-muted-foreground">Task definition</dt>
          <dd className="font-mono break-all">
            {r.resources.taskDefinitionArn}
          </dd>
          <dt className="text-muted-foreground">Target group</dt>
          <dd className="font-mono break-all">{r.resources.targetGroupArn}</dd>
          <dt className="text-muted-foreground">Listener rule</dt>
          <dd className="font-mono break-all">{r.resources.listenerRuleArn}</dd>
          <dt className="text-muted-foreground">Log group</dt>
          <dd className="font-mono">{r.resources.logGroup}</dd>
          <dt className="text-muted-foreground">Listener path</dt>
          <dd className="font-mono">{r.resources.listenerPath}</dd>
        </dl>
        {r.warnings.length > 0 && (
          <div
            className="rounded border border-amber-500/50 bg-amber-500/10 p-2 text-xs mb-3"
            data-testid="create-agent-warnings"
          >
            <div className="font-medium mb-1">
              Warnings ({r.warnings.length})
            </div>
            <ul className="list-disc list-inside space-y-1">
              {r.warnings.map((w) => (
                <li key={w.code}>
                  <code className="text-amber-700">{w.code}</code>
                  {' — '}
                  {w.message}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={reset}>
            Create another
          </Button>
          <Button variant="outline" size="sm" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    )
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mb-4 rounded border p-4 space-y-4"
      data-testid="create-agent-form"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">Create agent</h2>
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          className="text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
          aria-label="Close create-agent form"
        >
          ✕
        </button>
      </div>

      {state.kind === 'error' && (
        <div
          role="alert"
          className="rounded border border-destructive/50 bg-destructive/10 p-3 text-sm"
          data-testid="create-agent-error"
        >
          <div className="font-medium text-destructive">
            {state.status > 0 ? `${state.status} — ` : ''}
            <code>{state.body.error}</code>
          </div>
          {state.body.partialResources &&
            Object.keys(state.body.partialResources).length > 0 && (
              <div className="text-xs mt-2">
                <div className="text-muted-foreground mb-1">
                  Partial resources created (clean up before retrying):
                </div>
                <ul className="list-disc list-inside font-mono break-all space-y-0.5">
                  {state.body.partialResources.taskDefinitionArn && (
                    <li>{state.body.partialResources.taskDefinitionArn}</li>
                  )}
                  {state.body.partialResources.targetGroupArn && (
                    <li>{state.body.partialResources.targetGroupArn}</li>
                  )}
                  {state.body.partialResources.listenerRuleArn && (
                    <li>{state.body.partialResources.listenerRuleArn}</li>
                  )}
                  {state.body.partialResources.logGroup && (
                    <li>{state.body.partialResources.logGroup}</li>
                  )}
                  {/* `serviceArn` may be null (not undefined) when the
                      backend caught a CreateService SDK contract
                      violation — see the `partial.serviceArn = null`
                      assignment in api/agents.ts on the
                      "CreateService returned no ARN" path. The truthy
                      check on the other ARNs above would skip null;
                      use `'serviceArn' in partialResources` so the
                      operator gets a clear "possibly-orphaned
                      service" signal even when the ARN itself is
                      unknown. Most expensive orphan to leave behind
                      (running ECS task = ongoing cost + ALB misroute
                      risk). */}
                  {'serviceArn' in state.body.partialResources && (
                    <li
                      className="text-amber-700 not-italic"
                      data-testid="partial-service-arn-warning"
                    >
                      {typeof state.body.partialResources.serviceArn ===
                      'string' ? (
                        state.body.partialResources.serviceArn
                      ) : (
                        <>
                          Service ARN unknown — run{' '}
                          <code className="font-mono">
                            aws ecs describe-services --cluster
                            &lt;cluster&gt; --services
                            &lt;prefix&gt;-{harnessType.replace('/', '-')}-{
                              agentName || '<name>'
                            }
                          </code>{' '}
                          to check for an orphaned service before retrying.
                        </>
                      )}
                    </li>
                  )}
                </ul>
              </div>
            )}
        </div>
      )}

      <div>
        <label
          htmlFor="harnessType"
          className="block text-sm font-medium mb-1.5"
        >
          Harness type
        </label>
        <select
          id="harnessType"
          value={harnessType}
          onChange={(e) => setHarnessType(e.target.value as HarnessType)}
          disabled={submitting}
          className="w-full h-10 px-3 rounded-lg bg-secondary border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary disabled:opacity-50"
        >
          {HARNESS_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="agentName" className="block text-sm font-medium mb-1.5">
          Agent name
        </label>
        <input
          id="agentName"
          type="text"
          value={agentName}
          onChange={(e) => setAgentName(e.target.value)}
          disabled={submitting}
          required
          minLength={3}
          maxLength={32}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          className="w-full h-10 px-3 rounded-lg bg-secondary border border-border text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary disabled:opacity-50"
          placeholder="my-agent-1"
          aria-describedby="agentName-hint"
        />
        <p
          id="agentName-hint"
          className={`mt-1 text-xs ${
            agentName.length > 0 && !agentNameValid
              ? 'text-destructive'
              : 'text-muted-foreground'
          }`}
        >
          Lowercase letters, digits, hyphens. Must start with a letter and end
          with letter/digit. 3–32 chars. Used in IAM ARN templating — security
          control, not just a UX validator.
        </p>
      </div>

      <div>
        <label htmlFor="image" className="block text-sm font-medium mb-1.5">
          Container image
        </label>
        <input
          id="image"
          type="text"
          value={image}
          onChange={(e) => setImage(e.target.value)}
          disabled={submitting}
          required
          maxLength={IMAGE_MAX_BYTES}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          className="w-full h-10 px-3 rounded-lg bg-secondary border border-border text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary disabled:opacity-50"
          placeholder="ghcr.io/stroupaloop/openclaw:sha-abc1234"
          aria-describedby="image-hint"
        />
        <p
          id="image-hint"
          className={`mt-1 text-xs ${
            image.length > 0 && !imageValid
              ? 'text-destructive'
              : 'text-muted-foreground'
          }`}
        >
          Fully-qualified container ref (registry/path:tag or @sha256:...).
          Server enforces a registry allowlist (ECR-in-account,
          ghcr.io/stroupaloop, public.ecr.aws). Max {IMAGE_MAX_BYTES} chars.
        </p>
      </div>

      <div>
        <label
          htmlFor="roleDescription"
          className="block text-sm font-medium mb-1.5"
        >
          Role description
        </label>
        <textarea
          id="roleDescription"
          value={roleDescription}
          onChange={(e) => setRoleDescription(e.target.value)}
          disabled={submitting}
          required
          maxLength={ROLE_DESCRIPTION_MAX_BYTES}
          rows={4}
          className="w-full px-3 py-2 rounded-lg bg-secondary border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary disabled:opacity-50"
          placeholder="What this agent does, who it serves, what guardrails apply…"
          aria-describedby="roleDescription-hint"
        />
        <p
          id="roleDescription-hint"
          className="mt-1 text-xs text-muted-foreground"
        >
          {roleDescription.length}/{ROLE_DESCRIPTION_MAX_BYTES} chars. Becomes
          the agent&apos;s runtime role prompt; written into an immutable
          task-def revision visible to anyone with{' '}
          <code>ecs:DescribeTaskDefinition</code> — treat as permanent + public.
        </p>
      </div>

      <div>
        <label htmlFor="modelTier" className="block text-sm font-medium mb-1.5">
          Model tier
        </label>
        <select
          id="modelTier"
          value={modelTier}
          onChange={(e) => setModelTier(e.target.value as ModelTier)}
          disabled={submitting}
          className="w-full h-10 px-3 rounded-lg bg-secondary border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary disabled:opacity-50"
        >
          {MODEL_TIERS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      <div className="flex gap-2 pt-2">
        <Button type="submit" disabled={!formValid || submitting}>
          {submitting ? 'Creating…' : 'Create agent'}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onClose}
          disabled={submitting}
        >
          Cancel
        </Button>
      </div>
    </form>
  )
}
