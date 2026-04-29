'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
// `import type` elides at compile time — no runtime import of the
// AWS SDK / NextRequest from the server module reaches the client bundle.
import type {
  FleetServicesResponse as ServicesResponse,
  FleetServicesErrorResponse as ErrorResponse,
} from '../api/services'

// ---------- Component ----------

// Polling cadence while any row is mid-rollout. ECS rolls finish in 2–4
// min; 5s gives operators responsive feedback after a Redeploy click
// without spamming DescribeServices on healthy fleets (the polling stops
// the moment all rows hit activeDeployments=0).
const POLL_INTERVAL_MS = 5000

// Per-row redeploy state. Keyed by service name. 'pending' = awaiting
// the POST /redeploy response; 'error' + message = SDK or network error.
// After a 202 we hand control back to ECS's `activeDeployments` counter
// — the table refresh re-reads it and the disable predicate uses
// `svc.activeDeployments > 0` to keep the button disabled while the
// rollout finishes. So there's no per-row 'rolling' / 'ok' state to
// track in MC; ECS is the source of truth for "is this rolling?"
type RedeployState =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'error'; error: string }

export function FleetPanel() {
  const [data, setData] = useState<ServicesResponse | null>(null)
  const [error, setError] = useState<ErrorResponse | null>(null)
  // Initial render is mid-fetch (load() fires from useEffect); keep the
  // Refresh button in its loading state from t=0 to avoid an empty body.
  const [loading, setLoading] = useState(true)
  const [redeployStates, setRedeployStates] = useState<
    Record<string, RedeployState>
  >({})

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const resp = await fetch('/api/fleet/services', { cache: 'no-store' })
      const body = (await resp.json()) as ServicesResponse | ErrorResponse
      if (!resp.ok) {
        setError(body as ErrorResponse)
        setData(null)
      } else {
        setData(body as ServicesResponse)
      }
    } catch {
      // Bare network failure (DNS, offline, etc.) — surface a stable
      // generic. Browser dev-tools still show the underlying error;
      // we don't echo it into the UI to keep this consistent with the
      // server-side policy of not leaking error detail.
      setError({ error: 'NetworkError' })
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [])

  const redeploy = useCallback(
    async (svcName: string) => {
      setRedeployStates((s) => ({ ...s, [svcName]: { kind: 'pending' } }))
      try {
        const resp = await fetch(
          `/api/fleet/services/${encodeURIComponent(svcName)}/redeploy`,
          { method: 'POST', cache: 'no-store' },
        )
        if (!resp.ok) {
          const body = (await resp.json()) as { error?: string }
          setRedeployStates((s) => ({
            ...s,
            [svcName]: { kind: 'error', error: body.error ?? 'AWSError' },
          }))
          return
        }
        // 202 — ECS accepted the UpdateService call. Re-fetch the table
        // so DescribeServices reports the new IN_PROGRESS deployment;
        // from that point on the table's `activeDeployments` column is
        // the source of truth for "rollout in flight" (the button's
        // disable predicate keys on it). Reset the per-row state so the
        // button label tracks ECS, not stale MC state.
        await load()
        setRedeployStates((s) => ({ ...s, [svcName]: { kind: 'idle' } }))
      } catch {
        setRedeployStates((s) => ({
          ...s,
          [svcName]: { kind: 'error', error: 'NetworkError' },
        }))
      }
    },
    [load],
  )

  useEffect(() => {
    void load()
  }, [load])

  // Auto-poll while ANY row is mid-rollout. ECS rolls take 2–4 min; without
  // this, the table snapshots the post-Redeploy IN_PROGRESS state and never
  // refreshes — operator sees "Rolling…" indefinitely until they click
  // Refresh manually. Same `activeDeployments > 0` predicate the per-row
  // disabled state uses, so the loops naturally pair: polling stops the
  // moment ECS reports COMPLETED on every row.
  const hasRolling =
    data?.services.some((s) => s.activeDeployments > 0) ?? false

  useEffect(() => {
    if (!hasRolling) return
    const id = setInterval(() => {
      void load()
    }, POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [hasRolling, load])

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-semibold">Fleet</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Production-deployed agents in this cluster — OpenClaw companions,
            Hermes workers, and other agent harnesses. Read-only today;
            deploy + configure actions ship in subsequent phases.
          </p>
        </div>
        <Button variant="outline" onClick={load} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </Button>
      </div>

      {error ? (
        <div className="rounded border border-destructive/50 bg-destructive/10 p-4">
          <div className="font-medium">Failed to load fleet</div>
          <div className="text-sm mt-1">
            <code>{error.error}</code>
          </div>
          <div className="text-xs text-muted-foreground mt-2">
            Common causes: MC task role missing <code>ecs:ListServices</code> /
            <code>ecs:DescribeServices</code> (provisioned by ender-stack PR
            #150); cluster name mismatch (set <code>MC_FLEET_CLUSTER_NAME</code>);
            AWS region misconfigured.
          </div>
        </div>
      ) : null}

      {data ? (
        <div>
          <div className="text-sm text-muted-foreground mb-2">
            Cluster: <code>{data.cluster}</code> · Region: <code>{data.region}</code>
            {' · '}
            {data.services.length} agent{data.services.length === 1 ? '' : 's'}
          </div>

          {/* Banner only when there ARE agents to show + truncation is real
              risk. When there are zero agents AND truncated, the empty-state
              copy below carries the same warning — duplicating both was
              inherited noise. Auditor flagged the dual display as confusing. */}
          {data.truncated && data.services.length > 0 ? (
            <div
              className="mb-2 rounded border border-amber-500/50 bg-amber-500/10 p-2 text-xs"
              data-testid="truncation-banner"
            >
              Cluster has more than 100 services; Fleet scans only the first
              100 for agent harnesses, so some agents may be missing from this
              view. Pagination support lands in a follow-up.
            </div>
          ) : null}

          {data.services.length === 0 ? (
            <div
              className="rounded border p-4 text-sm text-muted-foreground"
              data-testid="empty-state"
            >
              {data.truncated
                ? 'No agents found in the first 100 services. More services may exist beyond the page cap.'
                : 'No agents currently deployed.'}
            </div>
          ) : (
            <div className="overflow-x-auto rounded border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="text-left p-2">Name</th>
                    <th className="text-left p-2">Status</th>
                    <th className="text-right p-2">Desired</th>
                    <th className="text-right p-2">Running</th>
                    <th className="text-right p-2">Pending</th>
                    <th className="text-left p-2">Launch type</th>
                    <th className="text-right p-2">Deployments</th>
                    <th className="text-right p-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {data.services.map((svc) => {
                    const rs = redeployStates[svc.name] ?? { kind: 'idle' }
                    // Disable Redeploy if (a) the POST is in flight,
                    // OR (b) ECS already shows an active rollout in
                    // progress (activeDeployments > 0). Avoids double-
                    // rolling and re-enables automatically when ECS
                    // reports COMPLETED — no per-row "rolling" state in
                    // MC.
                    const redeployDisabled =
                      rs.kind === 'pending' || svc.activeDeployments > 0
                    return (
                      <tr key={svc.name} className="border-t">
                        <td className="p-2 font-mono">{svc.name}</td>
                        <td className="p-2">
                          <span
                            className={
                              svc.status === 'ACTIVE'
                                ? 'text-green-700'
                                : 'text-amber-700'
                            }
                          >
                            {svc.status ?? '—'}
                          </span>
                        </td>
                        <td className="p-2 text-right">{svc.desiredCount ?? '—'}</td>
                        <td className="p-2 text-right">{svc.runningCount ?? '—'}</td>
                        <td className="p-2 text-right">{svc.pendingCount ?? '—'}</td>
                        <td className="p-2">{svc.launchType ?? '—'}</td>
                        <td className="p-2 text-right">{svc.activeDeployments}</td>
                        <td className="p-2 text-right">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void redeploy(svc.name)}
                            disabled={redeployDisabled}
                            data-testid={`redeploy-${svc.name}`}
                          >
                            {rs.kind === 'pending'
                              ? 'Triggering…'
                              : svc.activeDeployments > 0
                                ? 'Rolling…'
                                : 'Redeploy'}
                          </Button>
                          {rs.kind === 'error' ? (
                            <div
                              className="text-xs text-destructive mt-1"
                              data-testid={`redeploy-error-${svc.name}`}
                            >
                              <code>{rs.error}</code>
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
