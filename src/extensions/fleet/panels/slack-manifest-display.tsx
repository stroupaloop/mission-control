'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type {
  SlackManifestResponse,
  SlackManifestErrorResponse,
} from '../api/slack-manifest'

// Phase 2.4 Beat 5c.1 — Slack app manifest display.
//
// Fetches GET /api/fleet/agents/{name}/slack/manifest, renders the
// JSON in a copy-button block + numbered step-by-step instructions.
// Pure read flow — no submit, no state mutations beyond fetch lifecycle.
//
// Embedded inside the agent-detail panel under the "Connect to Slack"
// section. The credentials-paste form (Beat 5c.2) renders BELOW this
// component once the operator has copied tokens out of api.slack.com/apps.

interface Props {
  /** Agent name. Null while panel closed; effect re-fetches on change. */
  agentName: string | null
}

// Round-1 audit on PR #50: the error UI now offers a Retry button
// instead of forcing the operator to close + reopen the panel.
// Pattern matches create-agent-form / delete-agent-form retry UX.

type FetchState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'success'; response: SlackManifestResponse }
  | { kind: 'error'; status: number; body: SlackManifestErrorResponse }

const FETCH_TIMEOUT_MS = 30_000

export function SlackManifestDisplay({ agentName }: Props) {
  const [state, setState] = useState<FetchState>({ kind: 'idle' })
  const [copied, setCopied] = useState(false)
  // Bumping retryKey re-runs the fetch effect (it's in the deps).
  // Increment on Retry button click — simpler than a manual
  // re-fetch path that would duplicate the state-management logic.
  const [retryKey, setRetryKey] = useState(0)
  const abortRef = useRef<AbortController | null>(null)
  // Round-1 audit on PR #50: track the copied-flag timeout so we
  // cancel it on unmount (was leaking until it fired).
  const copiedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // On unmount, clear any pending copied-flag reset timeout.
  useEffect(() => {
    return () => {
      if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current)
    }
  }, [])

  useEffect(() => {
    if (agentName === null) {
      // Panel closed — abort any in-flight fetch + reset.
      abortRef.current?.abort()
      abortRef.current = null
      setState({ kind: 'idle' })
      setCopied(false)
      return
    }

    // Cancel any prior fetch (panel re-opened on a different agent).
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

    setState({ kind: 'loading' })
    void (async () => {
      try {
        const resp = await fetch(
          `/api/fleet/agents/${agentName}/slack/manifest`,
          { signal: controller.signal },
        )
        clearTimeout(timeout)
        if (resp.ok) {
          const body = (await resp.json()) as SlackManifestResponse
          if (!controller.signal.aborted) {
            setState({ kind: 'success', response: body })
          }
          return
        }
        let body: SlackManifestErrorResponse
        try {
          body = (await resp.json()) as SlackManifestErrorResponse
        } catch {
          body = { error: `HTTP ${resp.status}` }
        }
        if (!controller.signal.aborted) {
          setState({ kind: 'error', status: resp.status, body })
        }
      } catch (err) {
        clearTimeout(timeout)
        if (controller.signal.aborted) return
        setState({
          kind: 'error',
          status: 0,
          body: {
            error: 'NetworkError',
            detail: (err as Error).message,
          },
        })
      }
    })()

    return () => {
      clearTimeout(timeout)
      controller.abort()
    }
    // retryKey is intentionally in the deps so the Retry button can
    // re-trigger a fresh fetch without changing agentName.
  }, [agentName, retryKey])

  const handleCopy = async () => {
    if (state.kind !== 'success') return
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(state.response.manifest, null, 2),
      )
      setCopied(true)
      if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current)
      copiedTimeoutRef.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API failure (browser permission, non-secure context).
      // Operator can fall back to manual copy via the rendered <pre>.
      // No fatal state change — keep button labeled "Copy" so they can retry.
    }
  }

  if (agentName === null) return null

  if (state.kind === 'idle' || state.kind === 'loading') {
    return (
      <div
        className="text-sm text-muted-foreground"
        data-testid="slack-manifest-loading"
      >
        Loading Slack manifest…
      </div>
    )
  }

  if (state.kind === 'error') {
    return (
      <div
        className="p-3 rounded-md bg-destructive/10 text-destructive text-sm"
        data-testid="slack-manifest-error"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1">
            <div className="font-semibold">
              {state.body.error}
              {state.status > 0 ? ` (HTTP ${state.status})` : ''}
            </div>
            {state.body.detail ? (
              <div className="mt-1">
                <code className="text-xs">{state.body.detail}</code>
              </div>
            ) : null}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRetryKey((k) => k + 1)}
            data-testid="slack-manifest-retry"
          >
            Retry
          </Button>
        </div>
      </div>
    )
  }

  const manifestJson = JSON.stringify(state.response.manifest, null, 2)

  return (
    <div data-testid="slack-manifest-display" className="space-y-3">
      <div>
        <div className="flex items-center justify-between mb-1">
          <h4 className="text-sm font-semibold">App manifest JSON</h4>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleCopy()}
            data-testid="slack-manifest-copy"
          >
            {copied ? 'Copied!' : 'Copy'}
          </Button>
        </div>
        <pre
          className="text-xs bg-secondary border border-border rounded-md p-2 overflow-auto max-h-64 font-mono"
          data-testid="slack-manifest-json"
        >
          {manifestJson}
        </pre>
      </div>

      <div>
        <h4 className="text-sm font-semibold mb-1">Setup steps</h4>
        <ol
          className="text-xs text-muted-foreground list-decimal list-inside space-y-1"
          data-testid="slack-manifest-instructions"
        >
          {state.response.instructions.map((step, i) => (
            // Step text is operator-stable copy from the server response;
            // index is stable across renders (no reordering). Using index
            // as key is intentional — the array is treated as a fixed-
            // shape ordered list, not a mutable collection.
            <li key={i}>{step}</li>
          ))}
        </ol>
      </div>
    </div>
  )
}
