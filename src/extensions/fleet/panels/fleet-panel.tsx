'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'

// ---------- Types ----------

interface FleetService {
  name: string
  status: string | undefined
  desiredCount: number | undefined
  runningCount: number | undefined
  pendingCount: number | undefined
  taskDefinition: string | undefined
  launchType: string | undefined
  activeDeployments: number
}

interface ServicesResponse {
  cluster: string
  region: string
  services: FleetService[]
}

interface ErrorResponse {
  error: string
  detail?: string
}

// ---------- Component ----------

export function FleetPanel() {
  const [data, setData] = useState<ServicesResponse | null>(null)
  const [error, setError] = useState<ErrorResponse | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const resp = await fetch('/api/fleet/services', {
        cache: 'no-store',
      })
      const body = (await resp.json()) as ServicesResponse | ErrorResponse
      if (!resp.ok) {
        setError(body as ErrorResponse)
        setData(null)
      } else {
        setData(body as ServicesResponse)
      }
    } catch (err) {
      setError({
        error: 'NetworkError',
        detail: err instanceof Error ? err.message : String(err),
      })
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-semibold">Fleet</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Production-deployed agents — ECS services in this deployment&apos;s
            cluster (read-only). Phase-2.0 — deploy + create-agent actions land
            in subsequent steps.
          </p>
        </div>
        <Button variant="outline" onClick={load} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </Button>
      </div>

      <div className="mb-4 rounded border border-muted bg-muted/30 p-3 text-sm text-muted-foreground">
        Looking to spin up a local agent for dev iteration?{' '}
        <Link href="/agents" className="underline font-medium">
          Use Agents →
        </Link>
      </div>

      {error ? (
        <div className="rounded border border-destructive/50 bg-destructive/10 p-4">
          <div className="font-medium">Failed to load fleet</div>
          <div className="text-sm mt-1">
            <code>{error.error}</code>
            {error.detail ? <>: {error.detail}</> : null}
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

          {data.services.length === 0 ? (
            <div className="rounded border p-4 text-sm text-muted-foreground">
              No agents currently deployed in <code>{data.cluster}</code>.
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
