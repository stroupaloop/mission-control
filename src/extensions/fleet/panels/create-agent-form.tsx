'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import {
  AGENT_NAME_RE,
  HARNESS_TYPES,
  IMAGE_MAX_BYTES,
  ROLE_DESCRIPTION_MAX_BYTES,
  type HarnessType,
} from '../templates/constraints'
// `import type` only — keeps server-only modules (AWS SDK, NextRequest)
// out of the client bundle. Same pattern fleet-panel.tsx uses for the
// services-API response types.
import type {
  CreateAgentResponse,
  CreateAgentErrorResponse,
} from '../api/agents'
import type { HarnessDefaultsResponse } from '../api/harness-defaults'

// Phase 2.2 Beat 3b — UI form for POST /api/fleet/agents.
// Phase 2.2 Beat 3b.1 — converted from inline collapsible to portaled
// modal; pre-fills `image` from /api/fleet/harness-defaults; dropped
// the `modelTier` field (smart-router authoritative).
//
// Modal behavior:
//   - Rendered via React.createPortal into document.body so the modal
//     sits above the panel hierarchy regardless of z-index ancestors.
//   - Backdrop click + Esc key dismiss the form.
//   - Initial focus moves to the first input (agent name) on open;
//     focus returns to the trigger button on close.
//   - aria-modal + role="dialog" + aria-labelledby for screen-reader
//     correctness.
//
// Submit path:
//   POST /api/fleet/agents → on 201: render success summary + warnings,
//   call onCreated() so the parent refreshes the Fleet table.
//   On 4xx/5xx: render the SDK error name + partialResources if present.

interface Props {
  /** Whether the modal is currently visible. */
  open: boolean
  /** Called after a successful 201 so the parent panel can refresh the fleet table. */
  onCreated: () => void
  /** Called when the operator dismisses the modal (cancel, Esc, backdrop, or "Done" after success). */
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
// waiting on a hanging connection.
const SUBMIT_TIMEOUT_MS = 30_000

export function CreateAgentForm({ open, onCreated, onClose }: Props) {
  const [harnessType, setHarnessType] = useState<HarnessType>(
    HARNESS_TYPE_DEFAULT,
  )
  const [agentName, setAgentName] = useState('')
  const [image, setImage] = useState('')
  const [roleDescription, setRoleDescription] = useState('')
  const [state, setState] = useState<FormState>({ kind: 'idle' })
  // null = not yet fetched OR fetch failed; string = pre-fill ready.
  // Form treats null as "no default known"; operator types from scratch.
  const [defaultsByHarness, setDefaultsByHarness] = useState<
    Partial<Record<HarnessType, string>>
  >({})

  const firstInputRef = useRef<HTMLInputElement | null>(null)
  const previousFocusRef = useRef<Element | null>(null)

  const submitting = state.kind === 'submitting'

  // On open: capture the trigger element so we can return focus on
  // close, then move focus to the first input. On close: restore.
  useEffect(() => {
    if (!open) return
    previousFocusRef.current = document.activeElement
    const t = setTimeout(() => firstInputRef.current?.focus(), 0)
    return () => {
      clearTimeout(t)
      const target = previousFocusRef.current as HTMLElement | null
      target?.focus?.()
    }
  }, [open])

  // Reset on close so the next open shows a fresh form, not the
  // prior success/error view.
  //
  // The conditional-render → always-mounted refactor in this PR
  // dropped the unmount-on-close state teardown that React used to
  // do for free. Without this effect, a successful create followed
  // by close → reopen would show the previous agent's success
  // summary (with the wrong ARNs!) instead of an empty form.
  // Round-1 audit (Claude + Greptile P1) caught this.
  useEffect(() => {
    if (open) return
    setState({ kind: 'idle' })
    setAgentName('')
    setRoleDescription('')
    setHarnessType(HARNESS_TYPE_DEFAULT)
    // image gets re-pre-filled from defaultsByHarness when open flips
    // back to true (the existing pre-fill effect runs on harness-
    // type change). Setting to '' here keeps the pre-fill logic
    // simple — non-empty image suppresses the auto-fill.
    setImage('')
  }, [open])

  // Esc to dismiss. Only attached while open. Submit-in-flight blocks
  // dismiss to avoid losing the in-flight create — operator must wait
  // for the response (success/error) before closing.
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !submitting) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, submitting])

  // Pre-fill `image` from /api/fleet/harness-defaults on first open.
  // Endpoint never 5xx's on a missing default (returns null) — fetch
  // failure here is non-blocking; the operator just sees the empty
  // field with the placeholder example.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      try {
        const resp = await fetch('/api/fleet/harness-defaults', {
          cache: 'no-store',
        })
        if (!resp.ok) return
        const body = (await resp.json()) as HarnessDefaultsResponse
        if (cancelled) return
        const next: Partial<Record<HarnessType, string>> = {}
        for (const h of HARNESS_TYPES) {
          const d = body.defaults[h]?.defaultImage
          if (typeof d === 'string') next[h] = d
        }
        setDefaultsByHarness(next)
      } catch {
        // Silent — the operator can still type the image manually.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  // When defaults arrive (or harness selection changes), pre-fill
  // `image` IFF the operator hasn't already typed something. Don't
  // stomp in-progress input.
  useEffect(() => {
    if (image !== '') return
    const d = defaultsByHarness[harnessType]
    if (d) setImage(d)
  }, [defaultsByHarness, harnessType, image])

  // Local pre-validation before POSTing — catches the obvious failures
  // without a network round-trip. Server-side validation (in
  // templates/index.ts validateOpenClawInput + agents.ts type guard) is
  // still the authoritative gate; this layer is UX-only. Keep the rules
  // in lockstep with constraints.ts.
  const agentNameValid = AGENT_NAME_RE.test(agentName)
  // image must contain a separator AND have something after it.
  // `img:` (empty tag) passes a naive `includes(':')` check but
  // ECS rejects it as InvalidParameterException at registration —
  // catch it client-side so the operator gets immediate feedback
  // instead of a confusing 502 round-trip.
  const lastTagSegment = image.split(':').at(-1) ?? ''
  const imageValid =
    image.length > 0 &&
    image.includes(':') &&
    lastTagSegment.length > 0 &&
    image.length <= IMAGE_MAX_BYTES
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
    setImage(defaultsByHarness[HARNESS_TYPE_DEFAULT] ?? '')
    setRoleDescription('')
    setHarnessType(HARNESS_TYPE_DEFAULT)
    setState({ kind: 'idle' })
  }

  function handleBackdropClick() {
    if (submitting) return
    onClose()
  }

  if (!open) return null

  // Render outside the panel hierarchy — sits above any z-index
  // ancestor, dimmed backdrop covers the whole viewport.
  return createPortal(
    <div
      role="presentation"
      onClick={handleBackdropClick}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      data-testid="create-agent-modal-backdrop"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-agent-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-lg border bg-background shadow-xl"
        data-testid="create-agent-modal"
      >
        <FormBody
          state={state}
          submitting={submitting}
          harnessType={harnessType}
          setHarnessType={setHarnessType}
          agentName={agentName}
          setAgentName={setAgentName}
          agentNameValid={agentNameValid}
          image={image}
          setImage={setImage}
          imageValid={imageValid}
          roleDescription={roleDescription}
          setRoleDescription={setRoleDescription}
          formValid={formValid}
          firstInputRef={firstInputRef}
          onSubmit={handleSubmit}
          onClose={onClose}
          onResetForCreateAnother={reset}
        />
      </div>
    </div>,
    document.body,
  )
}

interface FormBodyProps {
  state: FormState
  submitting: boolean
  harnessType: HarnessType
  setHarnessType: (h: HarnessType) => void
  agentName: string
  setAgentName: (s: string) => void
  agentNameValid: boolean
  image: string
  setImage: (s: string) => void
  imageValid: boolean
  roleDescription: string
  setRoleDescription: (s: string) => void
  formValid: boolean
  firstInputRef: React.MutableRefObject<HTMLInputElement | null>
  onSubmit: (e: React.FormEvent) => void
  onClose: () => void
  onResetForCreateAnother: () => void
}

function FormBody({
  state,
  submitting,
  harnessType,
  setHarnessType,
  agentName,
  setAgentName,
  agentNameValid,
  image,
  setImage,
  imageValid,
  roleDescription,
  setRoleDescription,
  formValid,
  firstInputRef,
  onSubmit,
  onClose,
  onResetForCreateAnother,
}: FormBodyProps) {
  if (state.kind === 'success') {
    const r = state.response
    return (
      <div
        className="p-6"
        data-testid="create-agent-success"
      >
        <div className="flex items-center justify-between mb-3">
          <h2 id="create-agent-title" className="text-lg font-medium text-green-700">
            Agent <code>{r.agentName}</code> created
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-muted-foreground hover:text-foreground"
            aria-label="Close"
          >
            ✕
          </button>
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
          <Button variant="outline" size="sm" onClick={onResetForCreateAnother}>
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
      onSubmit={onSubmit}
      className="p-6 space-y-4"
      data-testid="create-agent-form"
    >
      <div className="flex items-center justify-between">
        <h2 id="create-agent-title" className="text-lg font-medium">
          Create agent
        </h2>
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
                      unknown. */}
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
          ref={firstInputRef}
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
          Lowercase letters, digits, hyphens. Must start and end with a
          letter or digit (no leading/trailing hyphens). 3–32 chars.
          Date prefixes like <code>2026-04-30-bot</code> work. Used in
          IAM ARN templating — security control, not just a UX
          validator.
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
          Pre-filled from the most-recent OpenClaw image on this
          cluster (override only when you need a specific build).
          Must be a fully-qualified ref with a non-empty tag or
          digest. Server enforces a registry allowlist
          (ECR-in-account, ghcr.io/stroupaloop). Max{' '}
          {IMAGE_MAX_BYTES} chars.
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
          {roleDescription.length}/{ROLE_DESCRIPTION_MAX_BYTES} chars.
          Becomes the agent&apos;s runtime role prompt; written into an
          immutable task-def revision visible to anyone with{' '}
          <code>ecs:DescribeTaskDefinition</code> — treat as permanent
          + public.
        </p>
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
