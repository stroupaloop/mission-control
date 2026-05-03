'use client'

import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import type { FleetServiceSummary } from '../api/services'
import { SlackManifestDisplay } from './slack-manifest-display'

// Phase 2.4 Beat 5c.1 — Agent detail side-panel.
//
// Opens when the operator clicks the agent's name in the fleet table.
// Slides in from the right via createPortal (same z-index strategy as
// create-agent-form / delete-agent-form modals — keeps the panel
// stacking-context-independent of the table's parent panel chain).
//
// Sections:
//   1. Agent identity — name, ARN, status, counts, launch type
//   2. Connect to Slack — manifest display (Beat 5c.1)
//
// Beat 5c.2 will extend with:
//   3. Slack credentials form (POST /slack/credentials)
//   4. Slack channel picker (GET /slack/channels)
//
// Why a side-panel instead of a modal: detail content is read-mostly +
// reference-style (operator pastes manifest into Slack, switches back
// to MC). A side-panel is non-blocking — the fleet table stays visible
// and operators can click another row without dismissing first.
//
// Width: max-w-2xl (~672px). Wider than the credential modal because
// the manifest JSON is wide; not full-width because we want the table
// still partially visible for cross-row navigation.

interface Props {
  /** The agent currently selected. `null` = panel closed. */
  agent: FleetServiceSummary | null
  /** Agent name parsed from service name (operator-friendly identifier). Null when no agent selected. */
  agentName: string | null
  onClose: () => void
}

export function AgentDetailPanel({ agent, agentName, onClose }: Props) {
  const open = agent !== null && agentName !== null

  // Esc closes (matches modal-form behavior).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open || agent === null || agentName === null) return null

  const panel = (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/40"
      onClick={(e) => {
        // Backdrop click dismisses (panel itself stops propagation
        // via its own onClick handler below).
        if (e.target === e.currentTarget) onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="agent-detail-title"
      data-testid="agent-detail-panel"
    >
      <div
        className="bg-background h-full w-full max-w-2xl shadow-xl overflow-y-auto"
        // Stop click propagation so clicks INSIDE the panel don't
        // hit the backdrop dismiss handler above.
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 space-y-6">
          <div className="flex items-start justify-between">
            <div>
              <h2
                id="agent-detail-title"
                className="text-lg font-semibold"
              >
                Agent <code className="font-mono">{agentName}</code>
              </h2>
              <p className="text-sm text-muted-foreground mt-0.5">
                {agent.name}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={onClose}
              data-testid="agent-detail-close"
              aria-label="Close panel"
            >
              Close
            </Button>
          </div>

          {/* ── Identity section ─────────────────────────────── */}
          <section
            className="space-y-2"
            data-testid="agent-detail-identity"
          >
            <h3 className="text-sm font-semibold border-b border-border pb-1">
              Identity
            </h3>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
              {/*
                Service ARN is intentionally not displayed here —
                FleetServiceSummary strips it at the response
                boundary to keep the AWS account ID out of the
                browser (see services.ts:60-63 comment). The
                service NAME is shown in the panel header.
              */}
              <dt className="text-muted-foreground">Task definition</dt>
              <dd className="font-mono text-xs break-all">
                {agent.taskDefinition ?? '—'}
              </dd>
              <dt className="text-muted-foreground">Status</dt>
              <dd>
                <span
                  className={
                    agent.status === 'ACTIVE'
                      ? 'text-green-700'
                      : 'text-amber-700'
                  }
                >
                  {agent.status ?? '—'}
                </span>
              </dd>
              <dt className="text-muted-foreground">Launch type</dt>
              <dd>{agent.launchType ?? '—'}</dd>
              <dt className="text-muted-foreground">Desired</dt>
              <dd>{agent.desiredCount ?? '—'}</dd>
              <dt className="text-muted-foreground">Running</dt>
              <dd>{agent.runningCount ?? '—'}</dd>
              <dt className="text-muted-foreground">Pending</dt>
              <dd>{agent.pendingCount ?? '—'}</dd>
              <dt className="text-muted-foreground">Active deployments</dt>
              <dd>{agent.activeDeployments}</dd>
            </dl>
          </section>

          {/* ── Connect to Slack section ─────────────────────── */}
          <section
            className="space-y-3"
            data-testid="agent-detail-slack"
          >
            <h3 className="text-sm font-semibold border-b border-border pb-1">
              Connect to Slack
            </h3>
            <p className="text-xs text-muted-foreground">
              Copy the manifest below and follow the steps to create a
              Slack app for this agent. After install, paste the three
              tokens back here (Beat 5c.2 — credentials form lands next).
            </p>
            <SlackManifestDisplay agentName={agentName} />
          </section>
        </div>
      </div>
    </div>
  )

  if (typeof document === 'undefined') return null
  return createPortal(panel, document.body)
}
