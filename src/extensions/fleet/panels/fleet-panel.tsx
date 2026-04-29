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

// Per-row redeploy state. Keyed by service name. 'pending' = awaiting API
// response; 'rolling' = ECS deployment in flight; 'ok' = freshly succeeded
// (cleared on next refresh); 'error' + message = SDK error.
type RedeployState =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'rolling' }
  | { kind: 'ok' }
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
        // 202 — ECS accepted the UpdateService call; rollout is in flight.
        // Re-fetch the table so the operator sees the new IN_PROGRESS
        // deployment count from DescribeServices.
        setRedeployStates((s) => ({ ...s, [svcName]: { kind: 'rolling' } }))
        await load()
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
                    // Disable Redeploy if a redeploy is in flight on THIS row
                    // OR if ECS already shows an active rollout in progress
                    // (activeDeployments > 0). Avoids double-rolling.
                    const redeployDisabled =
                      rs.kind === 'pending' ||
                      rs.kind === 'rolling' ||
                      svc.activeDeployments > 0
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
                              : rs.kind === 'rolling'
                                ? 'Rolling…'
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
