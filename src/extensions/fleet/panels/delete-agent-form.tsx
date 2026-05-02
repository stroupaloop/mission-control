'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
// `import type` only — keeps server-only modules (AWS SDK,
// NextRequest) out of the client bundle. Same pattern create-agent-
// form.tsx uses.
import type {
  DeleteAgentResponse,
  DeleteAgentErrorResponse,
} from '../api/agents-delete'

// Phase 2.2 Beat 4c — confirmation modal for DELETE /api/fleet/agents/{name}.
//
// Pattern mirrors create-agent-form.tsx:
//   - Rendered via createPortal into document.body so z-index of the
//     panel hierarchy can't pin it underneath sibling content.
//   - Backdrop click + Esc dismiss.
//   - Initial focus moves to the type-to-confirm input.
//
// Type-to-confirm gate is the deliberate-gesture safety mechanism.
// The Delete button is disabled until the operator types the
// agent's name exactly. Same UX shape as GitHub's repo-delete flow,
// the AWS console's S3-bucket-delete flow, etc.

interface Props {
  /** The agent currently selected for deletion. `null` = modal closed. */
  agentName: string | null
  /** Called after a successful 200 — parent should refresh the fleet table. */
  onDeleted: () => void
  /** Called when the operator dismisses (cancel, Esc, backdrop, or "Done" after success). */
  onClose: () => void
}

type FormState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success'; response: DeleteAgentResponse }
  | { kind: 'error'; status: number; body: DeleteAgentErrorResponse }

const SUBMIT_TIMEOUT_MS = 30_000

export function DeleteAgentForm({ agentName, onDeleted, onClose }: Props) {
  const [confirmText, setConfirmText] = useState('')
  const [state, setState] = useState<FormState>({ kind: 'idle' })
  const inputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const open = agentName !== null

  // Reset state when the modal closes (so a future open shows clean
  // state, not the success summary from the previous delete).
  useEffect(() => {
    if (!open) {
      setConfirmText('')
      setState({ kind: 'idle' })
      abortRef.current?.abort()
      abortRef.current = null
    }
  }, [open])

  // Initial focus on the type-to-confirm input. setTimeout to wait for
  // the portal node to mount in document.body.
  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => {
      inputRef.current?.focus()
    }, 0)
    return () => clearTimeout(t)
  }, [open])

  // Esc closes (matches create-agent-form behavior).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && state.kind !== 'submitting') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, state.kind])

  if (!open || agentName === null) return null

  const confirmMatches = confirmText === agentName
  const submitDisabled = !confirmMatches || state.kind === 'submitting'

  const handleSubmit = async () => {
    if (!confirmMatches) return
    setState({ kind: 'submitting' })
    const controller = new AbortController()
    abortRef.current = controller
    const timeout = setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS)
    try {
      const resp = await fetch(`/api/fleet/agents/${agentName}`, {
        method: 'DELETE',
        signal: controller.signal,
      })
      clearTimeout(timeout)
      if (resp.ok) {
        const body = (await resp.json()) as DeleteAgentResponse
        setState({ kind: 'success', response: body })
        onDeleted()
        return
      }
      let body: DeleteAgentErrorResponse
      try {
        body = (await resp.json()) as DeleteAgentErrorResponse
      } catch {
        body = { error: `HTTP ${resp.status}` }
      }
      setState({ kind: 'error', status: resp.status, body })
    } catch (err) {
      clearTimeout(timeout)
      if (controller.signal.aborted) {
        setState({
          kind: 'error',
          status: 0,
          body: { error: 'RequestAborted', detail: 'Delete request timed out or was cancelled' },
        })
      } else {
        setState({
          kind: 'error',
          status: 0,
          body: { error: 'NetworkError', detail: (err as Error).message },
        })
      }
    }
  }

  const modal = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (
          e.target === e.currentTarget &&
          state.kind !== 'submitting'
        )
          onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-agent-title"
      data-testid="delete-agent-modal"
    >
      <div className="bg-background rounded-lg shadow-lg max-w-md w-full mx-4 p-6">
        <h2 id="delete-agent-title" className="text-lg font-semibold mb-2">
          Delete agent <code className="font-mono">{agentName}</code>?
        </h2>

        {state.kind === 'success' ? (
          <SuccessSummary response={state.response} onClose={onClose} />
        ) : (
          <>
            <p className="text-sm text-muted-foreground mb-3">
              This permanently destroys all AWS resources for the agent:
            </p>
            <ul className="text-sm list-disc list-inside text-muted-foreground mb-4 space-y-0.5">
              <li>ECS service + running task</li>
              <li>Listener rule on the shared agents ALB</li>
              <li>Target group</li>
              <li>CloudWatch log group + every log line</li>
              <li>All task-definition revisions (set INACTIVE)</li>
            </ul>

            <p className="text-sm mb-2">
              Type <code className="font-mono font-semibold">{agentName}</code>{' '}
              to confirm:
            </p>
            <input
              ref={inputRef}
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              // Mirror create-agent-form's input styling (line ~806)
              // so the field is theme-aware. Without explicit
              // bg-secondary + text/border tokens, the input renders
              // with the browser default (white background, dark
              // text) which is illegible on a dark theme — caught in
              // first dev validation.
              className="w-full h-10 px-3 rounded-lg bg-secondary border border-border text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary disabled:opacity-50 mb-4"
              data-testid="delete-agent-confirm-input"
              disabled={state.kind === 'submitting'}
              autoComplete="off"
              spellCheck={false}
            />

            {state.kind === 'error' ? (
              <div
                className="p-3 mb-3 rounded-md bg-destructive/10 text-destructive text-sm"
                data-testid="delete-agent-error"
              >
                <div className="font-semibold">
                  {state.body.error}
                  {state.status > 0 ? ` (HTTP ${state.status})` : ''}
                </div>
                {state.body.detail ? (
                  <div className="mt-1">
                    <code className="text-xs">{state.body.detail}</code>
                  </div>
                ) : null}
                {state.body.failedResources ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs">
                      Resources still requiring manual cleanup
                    </summary>
                    <pre className="text-xs mt-1 overflow-auto">
                      {JSON.stringify(state.body.failedResources, null, 2)}
                    </pre>
                  </details>
                ) : null}
              </div>
            ) : null}

            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={onClose}
                disabled={state.kind === 'submitting'}
                data-testid="delete-agent-cancel"
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => void handleSubmit()}
                disabled={submitDisabled}
                data-testid="delete-agent-submit"
              >
                {state.kind === 'submitting' ? 'Deleting…' : 'Delete agent'}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )

  if (typeof document === 'undefined') return null
  return createPortal(modal, document.body)
}

function SuccessSummary({
  response,
  onClose,
}: {
  response: DeleteAgentResponse
  onClose: () => void
}) {
  return (
    <div data-testid="delete-agent-success">
      <p className="text-sm text-green-700 mb-3">
        Agent <code className="font-mono">{response.agentName}</code> deleted.
      </p>
      {response.warnings.length > 0 ? (
        <details className="mb-3">
          <summary className="text-xs cursor-pointer text-muted-foreground">
            {response.warnings.length} idempotency note
            {response.warnings.length > 1 ? 's' : ''}
          </summary>
          <ul className="text-xs mt-1 list-disc list-inside space-y-0.5">
            {response.warnings.map((w) => (
              <li key={w.code}>
                <code className="font-mono">{w.code}</code> — {w.message}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <details className="mb-4">
        <summary className="text-xs cursor-pointer text-muted-foreground">
          Deleted resources
        </summary>
        <pre className="text-xs mt-1 overflow-auto">
          {JSON.stringify(response.deletedResources, null, 2)}
        </pre>
      </details>
      <div className="flex justify-end">
        <Button onClick={onClose} data-testid="delete-agent-done">
          Done
        </Button>
      </div>
    </div>
  )
}
