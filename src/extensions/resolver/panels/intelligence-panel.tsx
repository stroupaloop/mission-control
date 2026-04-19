'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Button } from '@/components/ui/button'

// ---------- Types ----------

interface WeakDescriptionRecommendation {
  toolId: string
  signal: 'LOW_CONFIDENCE' | 'FALSE_POSITIVE' | 'BOTH'
  confidence: number | null
  occurrences: number
  sampleReasoning: string | null
  suggestedAction: string
}

interface RecommendationsResponse {
  days: number
  minOccurrences: number
  recommendations: WeakDescriptionRecommendation[]
}

interface ResolverOverride {
  description?: string
  addedKeywords?: string[]
  notes?: string
}

interface OverridesResponse {
  version: number
  updatedAt: string | null
  overrides: Record<string, ResolverOverride>
}

interface DailyRow {
  day: string
  classifications: number
  llm_calls: number
  llm_errors: number
  avg_confidence: number | null
  avg_llm_latency_ms: number | null
  tools_narrowed: number
  tokens_saved_est: number
  prompt_tokens_observed: number
  cost_usd_observed: number
  updated_at: number
}

interface Totals {
  classifications: number | null
  llm_calls: number | null
  llm_errors: number | null
  tools_narrowed: number | null
  tokens_saved_est: number | null
  prompt_tokens_observed: number | null
  cost_usd_observed: number | null
  avg_confidence: number | null
  avg_llm_latency_ms: number | null
}

interface Cursor {
  file_path: string
  byte_offset: number
  file_size: number
  last_ingest_at: number
}

interface MetricsResponse {
  days: number
  rows: DailyRow[]
  totals: Totals
  cursor: Cursor | null
}

interface RecentRow {
  turn: number
  session_id: string | null
  agent_id: string | null
  source: string
  confidence: number | null
  reasoning: string | null
  llm_latency_ms: number | null
  llm_error: string | null
  validation_action: string | null
  tools_before_count: number
  tools_after_count: number
  ts: string
}

interface SourceRow {
  source: string
  count: number
  avg_confidence: number | null
  avg_narrowed: number | null
}

interface AgentRow {
  agent_id: string
  count: number
}

interface ConfidenceBucket {
  bucket: string
  count: number
}

interface RecentResponse {
  recent: RecentRow[]
  bySource: SourceRow[]
  byAgent: AgentRow[]
  confidenceBuckets: ConfidenceBucket[]
}

// ---------- Helpers ----------

const fmtInt = (n: number | null | undefined) =>
  n == null ? '—' : new Intl.NumberFormat('en-US').format(Math.round(n))

const fmtCost = (n: number | null | undefined) =>
  n == null ? '—' : `$${n.toFixed(2)}`

const fmtPct = (n: number | null | undefined) =>
  n == null ? '—' : `${(n * 100).toFixed(1)}%`

const fmtLatency = (n: number | null | undefined) =>
  n == null ? '—' : `${Math.round(n)}ms`

const fmtTimeAgo = (tsSec: number) => {
  const nowSec = Math.floor(Date.now() / 1000)
  const diff = nowSec - tsSec
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

// ---------- Panel ----------

export function ResolverIntelligencePanel() {
  const [days, setDays] = useState<number>(30)
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null)
  const [recent, setRecent] = useState<RecentResponse | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)

  // Recommendations + overrides state
  const [recommendations, setRecommendations] = useState<WeakDescriptionRecommendation[]>([])
  const [overrides, setOverrides] = useState<Record<string, ResolverOverride>>({})
  const [recsLoading, setRecsLoading] = useState<boolean>(false)
  const [recsError, setRecsError] = useState<string | null>(null)

  // Add-override dialog state
  const [dialogOpen, setDialogOpen] = useState<boolean>(false)
  const [dialogToolId, setDialogToolId] = useState<string>('')
  const [dialogDescription, setDialogDescription] = useState<string>('')
  const [dialogKeywords, setDialogKeywords] = useState<string>('')
  const [dialogNotes, setDialogNotes] = useState<string>('')
  const [dialogSaving, setDialogSaving] = useState<boolean>(false)
  const [dialogError, setDialogError] = useState<string | null>(null)

  // Edit-override dialog (reuses the same dialog, prefilled)
  const editingToolId = useRef<string | null>(null)

  const loadData = useCallback(async (d: number) => {
    setLoading(true)
    setError(null)
    try {
      const [m, r] = await Promise.all([
        fetch(`/api/resolver/metrics?days=${d}`, { method: 'GET' }),
        fetch(`/api/resolver/recent?limit=50`, { method: 'GET' }),
      ])
      if (!m.ok) throw new Error(`metrics ${m.status}`)
      if (!r.ok) throw new Error(`recent ${r.status}`)
      setMetrics(await m.json())
      setRecent(await r.json())
    } catch (e: any) {
      setError(e.message || 'failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadRecommendations = useCallback(async () => {
    setRecsLoading(true)
    setRecsError(null)
    try {
      const [recsRes, ovRes] = await Promise.all([
        fetch('/api/resolver/recommendations?days=7&minOccurrences=5'),
        fetch('/api/resolver/overrides'),
      ])
      if (!recsRes.ok) throw new Error(`recommendations ${recsRes.status}`)
      if (!ovRes.ok) throw new Error(`overrides ${ovRes.status}`)
      const recsData: RecommendationsResponse = await recsRes.json()
      const ovData: OverridesResponse = await ovRes.json()
      setRecommendations(recsData.recommendations ?? [])
      setOverrides(ovData.overrides ?? {})
    } catch (e: any) {
      setRecsError(e.message || 'failed to load recommendations')
    } finally {
      setRecsLoading(false)
    }
  }, [])

  const openAddDialog = useCallback((toolId: string) => {
    editingToolId.current = null
    const existing = overrides[toolId]
    setDialogToolId(toolId)
    setDialogDescription(existing?.description ?? '')
    setDialogKeywords(existing?.addedKeywords?.join(', ') ?? '')
    setDialogNotes(existing?.notes ?? '')
    setDialogError(null)
    setDialogOpen(true)
  }, [overrides])

  const openEditDialog = useCallback((toolId: string) => {
    editingToolId.current = toolId
    const existing = overrides[toolId] ?? {}
    setDialogToolId(toolId)
    setDialogDescription(existing?.description ?? '')
    setDialogKeywords(existing?.addedKeywords?.join(', ') ?? '')
    setDialogNotes(existing?.notes ?? '')
    setDialogError(null)
    setDialogOpen(true)
  }, [overrides])

  const handleSaveOverride = useCallback(async () => {
    if (!dialogToolId.trim()) {
      setDialogError('Tool ID is required')
      return
    }
    setDialogSaving(true)
    setDialogError(null)
    try {
      const addedKeywords = dialogKeywords
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean)
      const override: ResolverOverride = {}
      if (dialogDescription.trim()) override.description = dialogDescription.trim()
      if (addedKeywords.length > 0) override.addedKeywords = addedKeywords
      if (dialogNotes.trim()) override.notes = dialogNotes.trim()

      const res = await fetch('/api/resolver/overrides', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: dialogToolId.trim(), override }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      setDialogOpen(false)
      await loadRecommendations()
    } catch (e: any) {
      setDialogError(e.message || 'save failed')
    } finally {
      setDialogSaving(false)
    }
  }, [dialogToolId, dialogDescription, dialogKeywords, dialogNotes, loadRecommendations])

  const handleRemoveOverride = useCallback(async (toolId: string) => {
    try {
      const res = await fetch(`/api/resolver/overrides/${encodeURIComponent(toolId)}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      await loadRecommendations()
    } catch (e: any) {
      setRecsError(e.message || 'remove failed')
    }
  }, [loadRecommendations])

  useEffect(() => {
    loadData(days)
    const h = setInterval(() => loadData(days), 60_000) // refresh every 60s
    return () => clearInterval(h)
  }, [days, loadData])

  useEffect(() => {
    loadRecommendations()
  }, [loadRecommendations])

  const chartData = useMemo(() => {
    if (!metrics) return []
    return [...metrics.rows].reverse().map((r) => ({
      day: r.day.slice(5), // MM-DD
      tokensSaved: r.tokens_saved_est,
      toolsNarrowed: r.tools_narrowed,
      classifications: r.classifications,
      llmCalls: r.llm_calls,
      errors: r.llm_errors,
      confidence: r.avg_confidence ? Number(r.avg_confidence.toFixed(3)) : 0,
    }))
  }, [metrics])

  const estimatedCostSaved = useMemo(() => {
    if (!metrics?.totals?.tokens_saved_est) return 0
    // Estimate at $3/M input tokens (Claude Sonnet-ish pricing, conservative)
    return (metrics.totals.tokens_saved_est / 1_000_000) * 3
  }, [metrics])

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Resolver Intelligence</h1>
          <p className="text-xs text-muted-foreground">
            openclaw-tool-resolver telemetry · token/cost savings · classification quality
          </p>
        </div>
        <div className="flex items-center gap-2">
          {([7, 30, 90] as const).map((d) => (
            <Button
              key={d}
              size="sm"
              variant={days === d ? 'default' : 'outline'}
              onClick={() => setDays(d)}
            >
              {d}d
            </Button>
          ))}
          <Button size="sm" variant="outline" onClick={() => loadData(days)} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Summary tiles */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile
          label="Tokens saved (est)"
          value={fmtInt(metrics?.totals?.tokens_saved_est)}
          sub={`≈ ${fmtCost(estimatedCostSaved)} @ $3/M in`}
          accent="good"
        />
        <Tile
          label="Tools narrowed"
          value={fmtInt(metrics?.totals?.tools_narrowed)}
          sub={`${fmtInt(metrics?.totals?.classifications)} classifications`}
        />
        <Tile
          label="LLM calls"
          value={fmtInt(metrics?.totals?.llm_calls)}
          sub={`${fmtInt(metrics?.totals?.llm_errors)} errors · ${fmtLatency(
            metrics?.totals?.avg_llm_latency_ms,
          )} avg`}
          accent={metrics?.totals?.llm_errors ? 'warn' : undefined}
        />
        <Tile
          label="Avg confidence"
          value={fmtPct(metrics?.totals?.avg_confidence)}
          sub={`Window: ${days}d`}
        />
      </div>

      {/* Tokens saved trend */}
      <Card title="Tokens saved / day">
        {chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted/40" />
              <XAxis dataKey="day" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v)} />
              <Tooltip
                contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', fontSize: 12 }}
                formatter={((v: number) => fmtInt(v)) as any}
              />
              <Bar dataKey="tokensSaved" fill="hsl(142 70% 45%)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <EmptyState loading={loading} />
        )}
      </Card>

      {/* Classifications + LLM activity */}
      <div className="grid gap-3 md:grid-cols-2">
        <Card title="Classifications / day">
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted/40" />
                <XAxis dataKey="day" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip
                  contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', fontSize: 12 }}
                />
                <Bar dataKey="classifications" stackId="a" fill="hsl(200 70% 50%)" />
                <Bar dataKey="llmCalls" stackId="a" fill="hsl(280 60% 55%)" />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <EmptyState loading={loading} />
          )}
          <Legend items={[
            { label: 'Non-LLM (cache/rule)', color: 'hsl(200 70% 50%)' },
            { label: 'LLM classified', color: 'hsl(280 60% 55%)' },
          ]} />
        </Card>

        <Card title="Avg confidence / day">
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted/40" />
                <XAxis dataKey="day" tick={{ fontSize: 10 }} />
                <YAxis domain={[0, 1]} tick={{ fontSize: 10 }} />
                <Tooltip
                  contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', fontSize: 12 }}
                  formatter={((v: number) => fmtPct(v)) as any}
                />
                <Line type="monotone" dataKey="confidence" stroke="hsl(142 70% 45%)" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <EmptyState loading={loading} />
          )}
        </Card>
      </div>

      {/* Source breakdown + Confidence buckets */}
      <div className="grid gap-3 md:grid-cols-2">
        <Card title="Classification source (last 24h)">
          {recent?.bySource?.length ? (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1">Source</th>
                  <th className="py-1 text-right">Count</th>
                  <th className="py-1 text-right">Avg conf.</th>
                  <th className="py-1 text-right">Avg narrowed</th>
                </tr>
              </thead>
              <tbody>
                {recent.bySource.map((r) => (
                  <tr key={r.source} className="border-t border-muted/30">
                    <td className="py-1 font-mono">{r.source}</td>
                    <td className="py-1 text-right">{fmtInt(r.count)}</td>
                    <td className="py-1 text-right">{fmtPct(r.avg_confidence)}</td>
                    <td className="py-1 text-right">{fmtInt(r.avg_narrowed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState loading={loading} />
          )}
        </Card>

        <Card title="Confidence distribution (last 7d)">
          {recent?.confidenceBuckets?.length ? (
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={recent.confidenceBuckets}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted/40" />
                <XAxis dataKey="bucket" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip
                  contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', fontSize: 12 }}
                />
                <Bar dataKey="count" fill="hsl(45 80% 55%)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <EmptyState loading={loading} />
          )}
        </Card>
      </div>

      {/* Recent classifications */}
      <Card title="Recent classifications">
        {recent?.recent?.length ? (
          <div className="max-h-[340px] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-card">
                <tr className="text-left text-muted-foreground">
                  <th className="py-1">When</th>
                  <th className="py-1">Source</th>
                  <th className="py-1 text-right">Conf.</th>
                  <th className="py-1 text-right">Latency</th>
                  <th className="py-1 text-right">Tools</th>
                  <th className="py-1">Agent</th>
                </tr>
              </thead>
              <tbody>
                {recent.recent.map((r, i) => (
                  <tr key={i} className="border-t border-muted/30 hover:bg-muted/20">
                    <td className="py-1 text-muted-foreground">{r.ts?.slice(5, 19).replace('T', ' ')}</td>
                    <td className="py-1 font-mono">{r.source}</td>
                    <td className="py-1 text-right">{fmtPct(r.confidence)}</td>
                    <td className="py-1 text-right">{fmtLatency(r.llm_latency_ms)}</td>
                    <td className="py-1 text-right font-mono">
                      {r.tools_before_count}→{r.tools_after_count}
                    </td>
                    <td className="py-1 font-mono text-muted-foreground">{r.agent_id ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState loading={loading} />
        )}
      </Card>

      {/* Recommendations */}
      <Card title="Weak-description recommendations (last 7d)">
        {recsError && (
          <div className="mb-2 rounded border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
            {recsError}
          </div>
        )}
        {recommendations.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 pr-2">Tool ID</th>
                  <th className="py-1 pr-2">Signal</th>
                  <th className="py-1 pr-2 text-right">Avg conf.</th>
                  <th className="py-1 pr-2 text-right">Occur.</th>
                  <th className="py-1 pr-2">Sample reasoning</th>
                  <th className="py-1"></th>
                </tr>
              </thead>
              <tbody>
                {recommendations.map((rec) => (
                  <tr key={rec.toolId} className="border-t border-muted/30">
                    <td className="py-1 pr-2 font-mono">{rec.toolId}</td>
                    <td className="py-1 pr-2">
                      <SignalBadge signal={rec.signal} />
                    </td>
                    <td className="py-1 pr-2 text-right">{fmtPct(rec.confidence)}</td>
                    <td className="py-1 pr-2 text-right">{rec.occurrences}</td>
                    <td className="py-1 pr-2 max-w-[240px] truncate text-muted-foreground">
                      {rec.sampleReasoning ?? '—'}
                    </td>
                    <td className="py-1">
                      <Button size="sm" variant="outline" className="h-6 px-2 text-xs"
                        onClick={() => openAddDialog(rec.toolId)}>
                        + Override
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState loading={recsLoading} />
        )}
      </Card>

      {/* Active overrides */}
      <Card title="Active overrides">
        {Object.keys(overrides).length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 pr-2">Tool ID</th>
                  <th className="py-1 pr-2">Description</th>
                  <th className="py-1 pr-2">Keywords</th>
                  <th className="py-1 pr-2">Notes</th>
                  <th className="py-1"></th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(overrides).map(([toolId, ov]) => (
                  <tr key={toolId} className="border-t border-muted/30">
                    <td className="py-1 pr-2 font-mono">{toolId}</td>
                    <td className="py-1 pr-2 max-w-[180px] truncate">{ov.description ?? '—'}</td>
                    <td className="py-1 pr-2 max-w-[140px] truncate font-mono">
                      {ov.addedKeywords?.join(', ') ?? '—'}
                    </td>
                    <td className="py-1 pr-2 max-w-[140px] truncate text-muted-foreground">
                      {ov.notes ?? '—'}
                    </td>
                    <td className="py-1 flex gap-1">
                      <Button size="sm" variant="outline" className="h-6 px-2 text-xs"
                        onClick={() => openEditDialog(toolId)}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-xs text-destructive hover:text-destructive"
                        onClick={() => handleRemoveOverride(toolId)}>
                        Remove
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <EmptyState loading={recsLoading} />
          </div>
        )}
        <div className="mt-2">
          <Button size="sm" variant="outline" className="text-xs"
            onClick={() => openAddDialog('')}>
            + Add override
          </Button>
        </div>
      </Card>

      {/* Add / Edit override dialog */}
      {dialogOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={(e) => { if (e.target === e.currentTarget) setDialogOpen(false) }}
        >
          <div className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-xl">
            <div className="mb-4 text-sm font-semibold">
              {editingToolId.current ? 'Edit override' : 'Add override'}
            </div>
            <div className="flex flex-col gap-3">
              {!editingToolId.current && (
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium">Tool / Skill ID</label>
                  <input
                    className="rounded border border-input bg-background px-2 py-1 text-sm"
                    placeholder="e.g. web_search"
                    value={dialogToolId}
                    onChange={(e) => setDialogToolId(e.target.value)}
                  />
                </div>
              )}
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium">Description</label>
                <textarea
                  className="min-h-[80px] rounded border border-input bg-background px-2 py-1 text-sm"
                  placeholder="Stronger hand-written description for the classifier…"
                  value={dialogDescription}
                  onChange={(e) => setDialogDescription(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium">Added keywords (comma-separated)</label>
                <input
                  className="rounded border border-input bg-background px-2 py-1 text-sm"
                  placeholder="search, web, internet"
                  value={dialogKeywords}
                  onChange={(e) => setDialogKeywords(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium">Notes (optional)</label>
                <textarea
                  className="min-h-[60px] rounded border border-input bg-background px-2 py-1 text-sm"
                  placeholder="Why this override exists…"
                  value={dialogNotes}
                  onChange={(e) => setDialogNotes(e.target.value)}
                />
              </div>
              {dialogError && (
                <div className="rounded border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
                  {dialogError}
                </div>
              )}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)} disabled={dialogSaving}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleSaveOverride} disabled={dialogSaving}>
                {dialogSaving ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Cursor / ingest status */}
      {metrics?.cursor && (
        <div className="rounded border border-muted/40 bg-muted/10 p-3 text-xs text-muted-foreground">
          <div className="font-mono">
            Tailing: <span className="text-foreground">{metrics.cursor.file_path}</span>
          </div>
          <div className="mt-1">
            Offset {fmtInt(metrics.cursor.byte_offset)} / {fmtInt(metrics.cursor.file_size)} bytes
            {' · '}
            Last ingest {fmtTimeAgo(metrics.cursor.last_ingest_at)}
          </div>
        </div>
      )}
    </div>
  )
}

// ---------- Subcomponents ----------

function Tile({
  label,
  value,
  sub,
  accent,
}: {
  label: string
  value: string
  sub?: string
  accent?: 'good' | 'warn'
}) {
  const accentClass =
    accent === 'good'
      ? 'border-emerald-500/40 bg-emerald-500/5'
      : accent === 'warn'
        ? 'border-amber-500/40 bg-amber-500/5'
        : 'border-muted/40 bg-card'
  return (
    <div className={`rounded-md border ${accentClass} p-3`}>
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold font-mono">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </div>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-muted/40 bg-card p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</div>
      {children}
    </div>
  )
}

function EmptyState({ loading }: { loading: boolean }) {
  return (
    <div className="flex h-[120px] items-center justify-center text-xs text-muted-foreground">
      {loading ? 'Loading…' : 'No data yet'}
    </div>
  )
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
      {items.map((i) => (
        <div key={i.label} className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-sm" style={{ background: i.color }} />
          {i.label}
        </div>
      ))}
    </div>
  )
}

function SignalBadge({ signal }: { signal: 'LOW_CONFIDENCE' | 'FALSE_POSITIVE' | 'BOTH' }) {
  const config = {
    BOTH: { label: 'Both', className: 'bg-red-500/15 text-red-600 dark:text-red-400' },
    LOW_CONFIDENCE: { label: 'Low conf.', className: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
    FALSE_POSITIVE: { label: 'False +', className: 'bg-blue-500/15 text-blue-600 dark:text-blue-400' },
  }[signal]
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${config.className}`}>
      {config.label}
    </span>
  )
}
