'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { MarkdownRenderer } from '@/components/markdown-renderer'
import { useMissionControl } from '@/store'
import type { FleetServiceSummary } from '../api/services'
import type {
  WorkspaceFileResponse,
  WorkspaceWriteResponse,
  WorkspaceErrorResponse,
} from '../api/workspace'
import {
  type PersonaFile,
  type EditorRole,
  canWritePersona,
  readablePersonaFiles,
} from '../lib/persona-files'
import { PersonaDiff } from './persona-diff'

// #552 — persona-editing "Settings" tab (PR 2 of #377). Lets an admin read +
// edit an agent's four seeded persona files (IDENTITY/SOUL/USER/AGENTS) against
// the GET/PUT /api/fleet/agents/:name/workspace/:filename endpoints shipped in
// #377 PR 1.
//
// Mirrors the canonical fetch/state-machine pattern in slack-credentials-form.tsx
// (AbortController ref + mounted guard + timeout). The added wrinkle vs the Slack
// form is OPTIMISTIC CONCURRENCY: the agent self-edits these same files, so every
// GET returns a content hash that PUT must echo as `expected_hash`. A 409 means
// the file moved under us — we refetch the live version, keep the operator's
// draft, and show the diff so they can reapply.
//
// Role-gating uses the SAME §3 matrices the server enforces (imported from
// ../lib/persona-files). Phase 1 is admin-only — `requireRole('admin')` on the
// server, `readablePersonaFiles(role)` is empty for operator/viewer here, so the
// tab renders an "admin only" notice. The owner-tier rows are already wired and
// light up unchanged once the MC ownership primitive lands.

const REQUEST_TIMEOUT_MS = 30_000

interface Props {
  /** Full service summary — `agent.name` is the ECS service name (redeploy). */
  agent: FleetServiceSummary
  /** Operator-friendly agent name — the workspace-API path segment. */
  agentName: string
}

type LoadPhase =
  | { kind: 'loading' }
  | { kind: 'ready'; content: string; hash: string }
  | { kind: 'load-error'; status: number; body: WorkspaceErrorResponse }

type SavePhase =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; bytes: number }
  | { kind: 'conflict' }
  | { kind: 'error'; status: number; body: WorkspaceErrorResponse }

type RedeployPhase =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'done' }
  | { kind: 'error'; error: string }

export function PersonaSettingsForm({ agent, agentName }: Props) {
  const { currentUser } = useMissionControl()
  const role = currentUser?.role as EditorRole | undefined
  const files = readablePersonaFiles(role)

  const firstFile = files[0] ?? null
  // Starts null: currentUser is null on first render and populated later by the
  // app's /api/auth/me fetch, so `files` is empty until the role resolves. The
  // effect below sets the selection once `firstFile` becomes available — without
  // it an admin who opens Settings pre-auth would stay stuck on the no-access
  // branch and never fetch.
  const [selected, setSelected] = useState<PersonaFile | null>(null)
  const [load, setLoad] = useState<LoadPhase>({ kind: 'loading' })
  const [draft, setDraft] = useState('')
  const [save, setSave] = useState<SavePhase>({ kind: 'idle' })
  const [showPreview, setShowPreview] = useState(false)
  const [redeploy, setRedeploy] = useState<RedeployPhase>({ kind: 'idle' })

  const abortRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
    }
  }, [])

  const writable = selected ? canWritePersona(role, selected) : false

  // Fetch the selected file (GET → { content, hash }). Shared by initial load,
  // file-switch, and the post-409 refetch. Aborts any prior in-flight request.
  // Plain function (not useCallback) — the load effect below keys on the data
  // deps [selected, agentName] and intentionally omits fetchFile, so recreating
  // it each render is harmless and avoids a memoization-deps mismatch.
  const fetchFile = async (
    file: PersonaFile,
    opts: { asConflict?: boolean } = {},
  ) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    // Abort with a sentinel reason so a genuine timeout is distinguishable
    // from an abort caused by supersession/unmount, without a captured
    // mutable flag (which the React Compiler can't memoize through).
    const timeout = setTimeout(
      () => controller.abort('timeout'),
      REQUEST_TIMEOUT_MS,
    )
    // A newer request (file switch / save) or an unmount supersedes this one —
    // its result must NOT overwrite the editor or the snapshot/hash the next
    // PUT depends on. The guard is `!mountedRef.current || abortRef.current
    // !== controller`, inlined at each await boundary below (a nested helper
    // closure can't be memoized through by the React Compiler).
    setLoad({ kind: 'loading' })
    try {
      const resp = await fetch(
        `/api/fleet/agents/${encodeURIComponent(agentName)}/workspace/${encodeURIComponent(file)}`,
        { method: 'GET', cache: 'no-store', signal: controller.signal },
      )
      clearTimeout(timeout)
      if (!mountedRef.current || abortRef.current !== controller) return
      if (resp.ok) {
        const body = (await resp.json()) as WorkspaceFileResponse
        if (!mountedRef.current || abortRef.current !== controller) return
        setLoad({ kind: 'ready', content: body.content, hash: body.hash })
        // On a normal load, sync the draft to the server content. On a
        // post-409 refetch, KEEP the operator's draft (so they can reapply)
        // and just refresh the server snapshot the diff compares against.
        if (!opts.asConflict) {
          setDraft(body.content)
          setSave({ kind: 'idle' })
        }
        return
      }
      let body: WorkspaceErrorResponse
      try {
        body = (await resp.json()) as WorkspaceErrorResponse
      } catch {
        body = { error: `HTTP ${resp.status}` }
      }
      if (!mountedRef.current || abortRef.current !== controller) return
      setLoad({ kind: 'load-error', status: resp.status, body })
    } catch (err) {
      clearTimeout(timeout)
      // Superseded (newer request / unmount) or aborted by handleSave → stay
      // silent; the owning request sets the state. Only a genuine timeout or
      // network failure of THIS request surfaces an error.
      if (!mountedRef.current || abortRef.current !== controller) return
      // Silent on supersession/unmount/save-abort; surface only a genuine
      // timeout (sentinel reason) or network failure of THIS request.
      if (controller.signal.aborted && controller.signal.reason !== 'timeout')
        return
      const timedOut = controller.signal.reason === 'timeout'
      setLoad({
        kind: 'load-error',
        status: 0,
        body: {
          error: timedOut ? 'RequestTimeout' : 'NetworkError',
          detail: timedOut ? 'Load timed out' : (err as Error).message,
        },
      })
    }
  }

  // Initial load + reload when the agent or selected file changes.
  useEffect(() => {
    if (!selected) return
    void fetchFile(selected)
    // fetchFile is a fresh closure each render but intentionally omitted — the
    // load should fire only when the selected file or agent changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, agentName])

  // Pick the first readable file once the role/file set resolves (null → first
  // file when auth arrives), and reset transient state when the agent changes.
  useEffect(() => {
    setSelected(firstFile)
    setSave({ kind: 'idle' })
    setShowPreview(false)
    setRedeploy({ kind: 'idle' })
  }, [firstFile, agentName])

  const handleSave = async () => {
    if (load.kind !== 'ready' || !selected || !writable) return
    if (draft === load.content) return
    setSave({ kind: 'saving' })
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const resp = await fetch(
        `/api/fleet/agents/${encodeURIComponent(agentName)}/workspace/${encodeURIComponent(selected)}`,
        {
          method: 'PUT',
          headers: {
            'content-type': 'application/json',
            'if-match': load.hash,
          },
          body: JSON.stringify({ content: draft, expected_hash: load.hash }),
          cache: 'no-store',
          signal: controller.signal,
        },
      )
      clearTimeout(timeout)
      if (!mountedRef.current) return
      if (resp.ok) {
        const body = (await resp.json()) as WorkspaceWriteResponse
        if (!mountedRef.current) return
        // The draft is now the server content; advance the snapshot to the new
        // hash so a subsequent save doesn't false-409.
        setLoad({ kind: 'ready', content: draft, hash: body.hash })
        setSave({ kind: 'saved', bytes: body.bytes })
        return
      }
      let body: WorkspaceErrorResponse
      try {
        body = (await resp.json()) as WorkspaceErrorResponse
      } catch {
        body = { error: `HTTP ${resp.status}` }
      }
      if (!mountedRef.current) return
      if (resp.status === 409) {
        // The agent (or another editor) wrote the file since our GET. Refetch
        // the live version, keep the draft, and let the operator reapply.
        setSave({ kind: 'conflict' })
        void fetchFile(selected, { asConflict: true })
        return
      }
      setSave({ kind: 'error', status: resp.status, body })
    } catch (err) {
      clearTimeout(timeout)
      if (!mountedRef.current) return
      const aborted = controller.signal.aborted
      setSave({
        kind: 'error',
        status: 0,
        body: {
          error: aborted ? 'RequestAborted' : 'NetworkError',
          detail: aborted
            ? 'Save timed out or was cancelled'
            : (err as Error).message,
        },
      })
    }
  }

  const handleApplyNow = async () => {
    // Redeploy restarts the agent task, which reloads whatever is ALREADY on
    // EFS — it does NOT deploy the in-editor draft. The button is disabled while
    // dirty (Save first); the confirm spells it out as a second guard against an
    // operator believing unsaved edits will ship.
    if (
      !window.confirm(
        'Restart the agent now? Only SAVED persona changes are applied — the agent reloads its files on restart, and any unsaved edits in the editor are NOT deployed. The agent is briefly offline while the new task boots.',
      )
    ) {
      return
    }
    setRedeploy({ kind: 'pending' })
    // Own AbortController (independent of abortRef, which serves GET/PUT) so a
    // hung redeploy can't leave the button stuck on "Restarting…" forever.
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const resp = await fetch(
        `/api/fleet/services/${encodeURIComponent(agent.name)}/redeploy`,
        { method: 'POST', cache: 'no-store', signal: controller.signal },
      )
      clearTimeout(timeout)
      if (!mountedRef.current) return
      if (resp.ok) {
        setRedeploy({ kind: 'done' })
        return
      }
      const body = (await resp.json().catch(() => ({}))) as { error?: string }
      setRedeploy({
        kind: 'error',
        error: body.error ?? `HTTP ${resp.status}`,
      })
    } catch (err) {
      clearTimeout(timeout)
      if (!mountedRef.current) return
      setRedeploy({
        kind: 'error',
        error: controller.signal.aborted
          ? 'Redeploy request timed out'
          : (err as Error).message,
      })
    }
  }

  // ── Role gate ──────────────────────────────────────────────────────────────
  if (files.length === 0 || !selected) {
    return (
      <div
        className="text-sm text-muted-foreground"
        data-testid="persona-settings-no-access"
      >
        Persona editing is available to admins only.
      </div>
    )
  }

  const dirty = load.kind === 'ready' && draft !== load.content
  const saving = save.kind === 'saving'

  return (
    <div className="space-y-4" data-testid="persona-settings-form">
      <p className="text-xs text-muted-foreground">
        Edit this agent&apos;s seeded persona files. Saves use optimistic
        concurrency — if the agent changed the file since you opened it, the
        save is rejected and you&apos;ll see the latest version to reapply onto.
      </p>

      {/* File selector */}
      <div
        className="flex flex-wrap gap-1"
        role="tablist"
        aria-label="Persona files"
      >
        {files.map((f) => (
          <Button
            key={f}
            variant={f === selected ? 'secondary' : 'ghost'}
            size="xs"
            role="tab"
            aria-selected={f === selected}
            onClick={() => setSelected(f)}
            disabled={saving}
            data-testid={`persona-file-${f}`}
          >
            {f}
            {!canWritePersona(role, f) ? (
              <span className="ml-1 text-[0.65rem] opacity-60">
                (read-only)
              </span>
            ) : null}
          </Button>
        ))}
      </div>

      {load.kind === 'loading' ? (
        <div
          className="text-sm text-muted-foreground"
          data-testid="persona-settings-loading"
        >
          Loading {selected}…
        </div>
      ) : null}

      {load.kind === 'load-error' ? (
        <div
          className="p-3 rounded-md bg-destructive/10 text-destructive text-sm"
          data-testid="persona-settings-load-error"
        >
          <div className="font-semibold">
            {load.body.error}
            {load.status > 0 ? ` (HTTP ${load.status})` : ''}
          </div>
          {load.body.detail ? (
            <div className="mt-1">
              <code className="text-xs">{load.body.detail}</code>
            </div>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => void fetchFile(selected)}
            data-testid="persona-settings-retry"
          >
            Retry
          </Button>
        </div>
      ) : null}

      {load.kind === 'ready' ? (
        <>
          <div>
            <div className="flex items-center justify-between mb-1">
              <label htmlFor="persona-editor" className="text-xs font-medium">
                {selected}
                {!writable ? ' (read-only for your role)' : ''}
              </label>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setShowPreview((p) => !p)}
                data-testid="persona-preview-toggle"
              >
                {showPreview ? 'Edit' : 'Preview'}
              </Button>
            </div>
            {showPreview ? (
              <div
                className="border border-border rounded p-3 bg-surface-1 min-h-[12rem]"
                data-testid="persona-preview"
              >
                <MarkdownRenderer content={draft} />
              </div>
            ) : (
              <textarea
                id="persona-editor"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                disabled={!writable || saving}
                spellCheck={false}
                rows={16}
                data-testid="persona-editor"
                className="w-full px-3 py-2 rounded-lg bg-secondary text-sm font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50 border border-border"
              />
            )}
          </div>

          {/* Diff before save */}
          {dirty ? (
            <div className="space-y-1" data-testid="persona-diff-section">
              <div className="text-xs font-medium text-muted-foreground">
                Pending changes (current server content → your edits)
              </div>
              <PersonaDiff before={load.content} after={draft} />
            </div>
          ) : null}

          {save.kind === 'conflict' ? (
            <div
              className="p-3 rounded-md bg-amber-500/10 text-amber-500 text-sm"
              data-testid="persona-settings-conflict"
            >
              The file changed since you opened it (the agent or another editor
              wrote it). The editor above now shows your draft against the
              latest server version — review the diff and click Save to reapply.
            </div>
          ) : null}

          {save.kind === 'saved' ? (
            <div
              className="text-sm text-green-700"
              data-testid="persona-settings-saved"
            >
              ✓ Saved {selected} ({save.bytes} bytes). The agent picks up
              persona changes on its next session; use “Apply now” to restart it
              immediately.
            </div>
          ) : null}

          {save.kind === 'error' ? (
            <div
              className="p-3 rounded-md bg-destructive/10 text-destructive text-sm"
              data-testid="persona-settings-save-error"
            >
              <div className="font-semibold">
                {save.body.error}
                {save.status > 0 ? ` (HTTP ${save.status})` : ''}
              </div>
              {save.body.detail ? (
                <div className="mt-1">
                  <code className="text-xs">{save.body.detail}</code>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="flex items-center justify-between border-t border-border pt-3">
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleApplyNow}
                disabled={redeploy.kind === 'pending' || dirty}
                title={
                  dirty
                    ? 'Save your edits first — restart only applies saved changes'
                    : undefined
                }
                data-testid="persona-apply-now"
              >
                {redeploy.kind === 'pending' ? 'Restarting…' : 'Apply now'}
              </Button>
              {redeploy.kind === 'done' ? (
                <span
                  className="text-xs text-green-700"
                  data-testid="persona-apply-now-done"
                >
                  Restart triggered.
                </span>
              ) : null}
              {redeploy.kind === 'error' ? (
                <span
                  className="text-xs text-destructive"
                  data-testid="persona-apply-now-error"
                >
                  {redeploy.error}
                </span>
              ) : null}
            </div>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={!writable || !dirty || saving}
              data-testid="persona-save"
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  )
}
