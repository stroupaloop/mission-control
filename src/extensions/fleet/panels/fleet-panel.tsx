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

export function FleetPanel() {
  const [data, setData] = useState<ServicesResponse | null>(null)
  const [error, setError] = useState<ErrorResponse | null>(null)
  // Initial render is mid-fetch (load() fires from useEffect); keep the
  // Refresh button in its loading state from t=0 to avoid an empty body.
  const [loading, setLoading] = useState(true)
  // When true, hide platform services (mission-control, litellm, etc.) and
  // show only services tagged Component=agent-harness — the OpenClaw
  // companions and Hermes workers operators actually deploy.
  const [harnessOnly, setHarnessOnly] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const url = harnessOnly
        ? '/api/fleet/services?harness=true'
        : '/api/fleet/services'
      const resp = await fetch(url, { cache: 'no-store' })
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
  }, [harnessOnly])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-semibold">Cluster Services</h1>
          <p className="text-sm text-muted-foreground mt-1">
            ECS services in this deployment&apos;s cluster — agent harnesses
            (OpenClaw, Hermes) alongside platform services (Mission Control,
            LiteLLM). Read-only today; deploy + configure actions ship in
            subsequent phases.
          </p>
        </div>
        <Button variant="outline" onClick={load} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </Button>
      </div>

      <div className="mb-4 flex items-center gap-2 text-sm">
        <label className="inline-flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={harnessOnly}
            onChange={(e) => setHarnessOnly(e.target.checked)}
          />
          <span>Agent harnesses only</span>
        </label>
        <span className="text-xs text-muted-foreground">
          (filters by <code>Component=agent-harness</code> tag)
        </span>
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
            {data.services.length} service{data.services.length === 1 ? '' : 's'}
          </div>

          {data.truncated ? (
            <div
              className="mb-2 rounded border border-amber-500/50 bg-amber-500/10 p-2 text-xs"
              data-testid="truncation-banner"
            >
              {harnessOnly
                ? 'Cluster has > 100 services; the harness filter only sees the first 100. Some agent harnesses may be missing from this view. Pagination support lands in a follow-up.'
                : 'Result truncated — only the first 100 services are shown. Pagination support lands in a follow-up.'}
            </div>
          ) : null}

          {data.services.length === 0 ? (
            <div
              className="rounded border p-4 text-sm text-muted-foreground"
              data-testid="empty-state"
            >
              {harnessOnly && data.truncated
                ? 'No agent harnesses found in the first 100 services. More services may exist beyond the page cap.'
                : harnessOnly
                  ? `No services in ${data.cluster} tagged as agent harnesses.`
                  : `No services in ${data.cluster}.`}
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
                  </tr>
                </thead>
                <tbody>
                  {data.services.map((svc) => (
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
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
