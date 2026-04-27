'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Button } from '@/components/ui/button'

// ---------- Types ----------

type UsageWindow = '24h' | '7d' | '30d' | 'all'

interface Totals {
  calls: number
  cost_usd: number
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  avg_latency_ms: number
  cache_hit_rate: number
  error_rate: number
  success_rate: number
}

interface ByModelRow {
  model: string
  calls: number
  cost_usd: number
  total_tokens: number
  avg_tokens: number
  avg_latency_ms: number
}

interface ByUserRow {
  user_id: string
  calls: number
  cost_usd: number
  total_tokens: number
}

interface ByBucketRow {
  bucket: string
  calls: number
  cost_usd: number
  total_tokens: number
}

interface SummaryResponse {
  window: UsageWindow
  totals: Totals
  by_model: ByModelRow[]
  by_user: ByUserRow[]
  by_hour: ByBucketRow[]
}

interface UsageRecord {
  id: number
  call_id: string | null
  model: string | null
  user_id: string | null
  prompt_tokens: number | null
  completion_tokens: number | null
  response_cost: number | null
  latency_ms: number | null
  status: string | null
  cache_hit: number
  created_at: number
}

interface RecordsResponse {
  records: UsageRecord[]
  total: number
  limit: number
  offset: number
}

type ModelSortKey = 'cost_usd' | 'calls' | 'avg_latency_ms' | 'total_tokens'
type UserSortKey = 'cost_usd' | 'calls' | 'total_tokens'
type SortDir = 'asc' | 'desc'
type CacheWindow2 = '7d' | '30d' | 'all'

interface CacheDailyRow {
  day: string
  model: string
  calls: number
  input_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  est_savings_usd: number
}

interface CacheResponse {
  rows: CacheDailyRow[]
  totals: {
    calls: number
    input_tokens: number
    cache_read_tokens: number
    cache_write_tokens: number
    hit_rate: number
    est_savings_usd: number
  }
}

// ---------- Helpers ----------

function tFallback(t: (key: string, values?: any) => string, key: string, fallback: string, values?: any): string {
  try {
    const v = t(key, values)
    // next-intl returns the key wrapped in some shells when missing; fall back to literal if equal
    return v && v !== key ? v : fallback
  } catch {
    return fallback
  }
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`
  return n.toLocaleString()
}

function formatCost(n: number, digits = 4): string {
  if (!Number.isFinite(n)) return '$0.0000'
  return `$${n.toFixed(digits)}`
}

function formatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms === 0) return '—'
  if (ms >= 10_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`
  return `${Math.round(ms)}ms`
}

function latencyColorClass(ms: number): string {
  if (!Number.isFinite(ms) || ms === 0) return 'text-muted-foreground'
  if (ms < 1000) return 'text-green-400'
  if (ms < 3000) return 'text-yellow-400'
  return 'text-red-400'
}

function formatTimestamp(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return '—'
  const d = new Date(unixSeconds * 1000)
  return d.toLocaleString()
}

function shortBucketLabel(bucket: string, window: UsageWindow): string {
  // 24h / 7d -> '2026-04-18T15' → '15:00' for 24h, 'Mon 15h' for 7d
  // 30d     -> '2026-04-18'      → 'Apr 18'
  if (window === '30d') {
    const m = bucket.match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (m) {
      const d = new Date(`${bucket}T00:00:00Z`)
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    }
    return bucket
  }
  const m = bucket.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/)
  if (m) {
    if (window === '24h') return `${m[4]}:00`
    const d = new Date(`${bucket}:00:00Z`)
    return d.toLocaleString(undefined, { weekday: 'short', hour: '2-digit' })
  }
  return bucket
}

// Debounce hook
function useDebounced<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(t)
  }, [value, delayMs])
  return debounced
}

// ---------- Panel ----------

export function LitellmUsagePanel() {
  const t = useTranslations('litellmUsage')

  const [window, setWindow] = useState<UsageWindow>('24h')
  const [summary, setSummary] = useState<SummaryResponse | null>(null)
  const [records, setRecords] = useState<UsageRecord[]>([])
  const [recordsTotal, setRecordsTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [recordsLoading, setRecordsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [expandedId, setExpandedId] = useState<number | null>(null)

  const [modelSort, setModelSort] = useState<{ key: ModelSortKey; dir: SortDir }>({ key: 'cost_usd', dir: 'desc' })
  const [userSort, setUserSort] = useState<{ key: UserSortKey; dir: SortDir }>({ key: 'cost_usd', dir: 'desc' })

  const visibilityRef = useRef<boolean>(true)
  const debouncedSearch = useDebounced(search, 300)
  const PAGE_SIZE = 25

  const loadSummary = useCallback(async (w: UsageWindow, silent = false) => {
    if (!silent) setLoading(true)
    try {
      const res = await fetch(`/api/litellm/dashboard/summary?window=${w}`, { method: 'GET' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      const data: SummaryResponse = await res.json()
      setSummary(data)
      setError(null)
    } catch (err: any) {
      setError(err?.message || tFallback(t, 'loadError', 'Failed to load usage data'))
    } finally {
      if (!silent) setLoading(false)
    }
  }, [t])

  const loadRecords = useCallback(async (q: string, offset: number, silent = false) => {
    if (!silent) setRecordsLoading(true)
    try {
      const qs = new URLSearchParams()
      qs.set('limit', String(PAGE_SIZE))
      qs.set('offset', String(offset))
      if (q) {
        // Treat search as "either model OR user_id contains"; backend currently ANDs,
        // so we just hit the `model` filter as a broad contains match.
        qs.set('model', q)
      }
      const res = await fetch(`/api/litellm/dashboard/records?${qs.toString()}`, { method: 'GET' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      const data: RecordsResponse = await res.json()
      setRecords(data.records || [])
      setRecordsTotal(data.total || 0)
    } catch (err: any) {
      // Non-fatal: just show an empty records table, main error banner stays tied to summary
      setRecords([])
      setRecordsTotal(0)
    } finally {
      if (!silent) setRecordsLoading(false)
    }
  }, [])

  // Initial + on window change
  useEffect(() => {
    loadSummary(window, false)
  }, [window, loadSummary])

  // Records: reset to page 0 when search changes, otherwise paginate
  useEffect(() => {
    setPage(0)
  }, [debouncedSearch])

  useEffect(() => {
    loadRecords(debouncedSearch, page * PAGE_SIZE, false)
  }, [debouncedSearch, page, loadRecords])

  // Visibility-aware auto refresh every 60s
  useEffect(() => {
    const onVisibility = () => {
      visibilityRef.current = !document.hidden
    }
    document.addEventListener('visibilitychange', onVisibility)
    const interval = setInterval(() => {
      if (!visibilityRef.current) return
      loadSummary(window, true)
      loadRecords(debouncedSearch, page * PAGE_SIZE, true)
    }, 60_000)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      clearInterval(interval)
    }
  }, [window, debouncedSearch, page, loadSummary, loadRecords])

  const totals = summary?.totals

  const chartData = useMemo(() => {
    if (!summary?.by_hour) return []
    return summary.by_hour.map(row => ({
      label: shortBucketLabel(row.bucket, summary.window),
      cost: Number(row.cost_usd.toFixed(4)),
      calls: row.calls,
    }))
  }, [summary])

  const sortedByModel = useMemo(() => {
    if (!summary?.by_model) return []
    const { key, dir } = modelSort
    const sign = dir === 'asc' ? 1 : -1
    return [...summary.by_model].sort((a, b) => {
      const av = (a as any)[key] ?? 0
      const bv = (b as any)[key] ?? 0
      if (av === bv) return 0
      return av < bv ? -1 * sign : 1 * sign
    })
  }, [summary, modelSort])

  const sortedByUser = useMemo(() => {
    if (!summary?.by_user) return []
    const { key, dir } = userSort
    const sign = dir === 'asc' ? 1 : -1
    return [...summary.by_user].sort((a, b) => {
      const av = (a as any)[key] ?? 0
      const bv = (b as any)[key] ?? 0
      if (av === bv) return 0
      return av < bv ? -1 * sign : 1 * sign
    })
  }, [summary, userSort])

  function toggleModelSort(key: ModelSortKey) {
    setModelSort(prev => (prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }))
  }
  function toggleUserSort(key: UserSortKey) {
    setUserSort(prev => (prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }))
  }

  const showEmpty = !loading && (!totals || totals.calls === 0) && !error

  return (
    <div className="m-4 space-y-4" data-testid="litellm-usage-panel">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-foreground">
          {tFallback(t, 'title', 'LLM Usage & Cost')}
        </h2>
        <div className="flex items-center gap-2">
          {/* Window selector */}
          <div className="flex gap-1" role="tablist" aria-label={tFallback(t, 'windowAria', 'Time window')}>
            {(['24h', '7d', '30d', 'all'] as const).map(w => (
              <button
                key={w}
                role="tab"
                aria-selected={window === w}
                data-testid={`window-${w}`}
                onClick={() => setWindow(w)}
                className={`px-2.5 py-1 text-xs rounded uppercase transition-colors ${
                  window === w
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {w}
              </button>
            ))}
          </div>
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              loadSummary(window, false)
              loadRecords(debouncedSearch, page * PAGE_SIZE, false)
            }}
            disabled={loading}
            title={tFallback(t, 'refresh', 'Refresh')}
          >
            {loading ? tFallback(t, 'refreshing', 'Refreshing…') : tFallback(t, 'refresh', 'Refresh')}
          </Button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400 flex items-center justify-between" data-testid="litellm-error">
          <span>{error}</span>
          <Button size="xs" variant="outline" onClick={() => loadSummary(window, false)}>
            {tFallback(t, 'retry', 'Retry')}
          </Button>
        </div>
      )}

      {/* Loading skeleton (first load only) */}
      {loading && !summary ? (
        <div className="space-y-2" data-testid="litellm-skeleton">
          <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
            {[0, 1, 2, 3].map(i => (
              <div key={i} className="h-24 rounded-lg border border-border bg-card animate-pulse" />
            ))}
          </div>
          <div className="h-64 rounded-lg border border-border bg-card animate-pulse" />
        </div>
      ) : showEmpty ? (
        <div className="text-center py-12 text-muted-foreground text-sm" data-testid="litellm-empty">
          {tFallback(t, 'empty', 'No usage data for this window yet.')}
        </div>
      ) : (
        <>
          {/* Stat cards */}
          {totals && (
            <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
              <StatCard
                label={tFallback(t, 'totalCalls', 'Total Calls')}
                value={formatNumber(totals.calls)}
                testid="stat-calls"
              />
              <StatCard
                label={tFallback(t, 'totalCost', 'Total Cost')}
                value={formatCost(totals.cost_usd)}
                testid="stat-cost"
              />
              <StatCard
                label={tFallback(t, 'totalTokens', 'Total Tokens')}
                value={formatNumber(totals.total_tokens)}
                testid="stat-tokens"
              />
              <StatCard
                label={tFallback(t, 'avgLatency', 'Avg Latency')}
                value={formatLatency(totals.avg_latency_ms)}
                valueClass={latencyColorClass(totals.avg_latency_ms)}
                testid="stat-latency"
              />
            </div>
          )}

          {/* Secondary stats */}
          {totals && (
            <div className="grid gap-3 grid-cols-3">
              <MiniStat
                label={tFallback(t, 'cacheHitRate', 'Cache Hit Rate')}
                value={`${(totals.cache_hit_rate * 100).toFixed(1)}%`}
              />
              <MiniStat
                label={tFallback(t, 'errorRate', 'Error Rate')}
                value={`${(totals.error_rate * 100).toFixed(1)}%`}
                valueClass={totals.error_rate > 0.05 ? 'text-red-400' : 'text-foreground'}
              />
              <MiniStat
                label={tFallback(t, 'successRate', 'Success Rate')}
                value={`${(totals.success_rate * 100).toFixed(1)}%`}
                valueClass="text-green-400"
              />
            </div>
          )}

          {/* Time series */}
          {chartData.length > 0 && (
            <div className="rounded-lg border border-border bg-card p-3">
              <div className="text-xs text-muted-foreground mb-2">
                {tFallback(t, 'costOverTime', 'Cost & Calls Over Time')}
              </div>
              <div className="h-64" data-testid="litellm-chart">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                    <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'rgb(148 163 184)' }} />
                    <YAxis
                      yAxisId="left"
                      tick={{ fontSize: 10, fill: 'rgb(148 163 184)' }}
                      tickFormatter={(v: number) => `$${v.toFixed(2)}`}
                    />
                    <YAxis
                      yAxisId="right"
                      orientation="right"
                      tick={{ fontSize: 10, fill: 'rgb(148 163 184)' }}
                    />
                    <Tooltip
                      contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', fontSize: 12 }}
                      labelStyle={{ color: 'hsl(var(--foreground))' }}
                    />
                    <Bar yAxisId="left" dataKey="cost" name="cost ($)" fill="#38bdf8" />
                    <Line
                      yAxisId="right"
                      type="monotone"
                      dataKey="calls"
                      name="calls"
                      stroke="#f59e0b"
                      strokeWidth={2}
                      dot={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Breakdown tables */}
          <div className="grid gap-3 md:grid-cols-2">
            <BreakdownTable<ByModelRow, ModelSortKey>
              title={tFallback(t, 'byModel', 'By Model')}
              rows={sortedByModel}
              sort={modelSort}
              onToggleSort={toggleModelSort}
              testid="by-model"
              columns={[
                { key: 'model', label: 'Model', sortable: false, render: r => r.model },
                { key: 'calls', label: 'Calls', sortable: true, render: r => formatNumber(r.calls), align: 'right' },
                { key: 'cost_usd', label: 'Cost', sortable: true, render: r => formatCost(r.cost_usd), align: 'right' },
                { key: 'avg_tokens', label: 'Avg Tk', sortable: false, render: r => formatNumber(Math.round(r.avg_tokens)), align: 'right' },
                { key: 'avg_latency_ms', label: 'Lat', sortable: true, render: r => formatLatency(r.avg_latency_ms), align: 'right' },
              ]}
            />
            <BreakdownTable<ByUserRow, UserSortKey>
              title={tFallback(t, 'byAgent', 'By Agent')}
              rows={sortedByUser}
              sort={userSort}
              onToggleSort={toggleUserSort}
              testid="by-user"
              columns={[
                { key: 'user_id', label: 'Agent', sortable: false, render: r => r.user_id },
                { key: 'calls', label: 'Calls', sortable: true, render: r => formatNumber(r.calls), align: 'right' },
                { key: 'cost_usd', label: 'Cost', sortable: true, render: r => formatCost(r.cost_usd), align: 'right' },
                { key: 'total_tokens', label: 'Tokens', sortable: true, render: r => formatNumber(r.total_tokens), align: 'right' },
              ]}
            />
          </div>

          {/* Cache metrics */}
          <CacheMetricsSection />

          {/* Recent calls */}
          <div className="rounded-lg border border-border bg-card p-3">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <div className="text-xs text-muted-foreground">
                {tFallback(t, 'recentCalls', 'Recent Calls')}
                <span className="ml-2 text-[10px] opacity-60">
                  {recordsTotal > 0
                    ? tFallback(t, 'recordsCount', '{count} records', { count: recordsTotal })
                    : ''}
                </span>
              </div>
              <input
                type="text"
                aria-label={tFallback(t, 'searchAria', 'Search calls')}
                placeholder={tFallback(t, 'searchPlaceholder', 'Filter by model or agent…')}
                value={search}
                onChange={e => setSearch(e.target.value)}
                data-testid="litellm-search"
                className="flex-1 sm:max-w-xs bg-secondary border border-border rounded px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
              />
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground border-b border-border">
                    <th className="py-1.5 pr-2">{tFallback(t, 'colTime', 'Time')}</th>
                    <th className="py-1.5 pr-2">{tFallback(t, 'colModel', 'Model')}</th>
                    <th className="py-1.5 pr-2">{tFallback(t, 'colAgent', 'Agent')}</th>
                    <th className="py-1.5 pr-2 text-right">{tFallback(t, 'colPrompt', 'Prompt')}</th>
                    <th className="py-1.5 pr-2 text-right">{tFallback(t, 'colCompletion', 'Comp')}</th>
                    <th className="py-1.5 pr-2 text-right">{tFallback(t, 'colCost', 'Cost')}</th>
                    <th className="py-1.5 pr-2 text-right">{tFallback(t, 'colLatency', 'Latency')}</th>
                    <th className="py-1.5 pr-2">{tFallback(t, 'colStatus', 'Status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {recordsLoading && records.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-4 text-center text-muted-foreground">
                        {tFallback(t, 'loadingRecords', 'Loading…')}
                      </td>
                    </tr>
                  ) : records.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-4 text-center text-muted-foreground">
                        {tFallback(t, 'emptyRecords', 'No calls match this filter.')}
                      </td>
                    </tr>
                  ) : (
                    records.map(r => {
                      const isExpanded = expandedId === r.id
                      return (
                        <>
                          <tr
                            key={r.id}
                            onClick={() => setExpandedId(isExpanded ? null : r.id)}
                            className="border-b border-border/40 hover:bg-secondary/50 cursor-pointer"
                            data-testid="litellm-record-row"
                          >
                            <td className="py-1.5 pr-2 text-muted-foreground">{formatTimestamp(r.created_at)}</td>
                            <td className="py-1.5 pr-2 font-mono text-[11px]">{r.model || '—'}</td>
                            <td className="py-1.5 pr-2 font-mono text-[11px]">{r.user_id || '—'}</td>
                            <td className="py-1.5 pr-2 text-right">{formatNumber(r.prompt_tokens || 0)}</td>
                            <td className="py-1.5 pr-2 text-right">{formatNumber(r.completion_tokens || 0)}</td>
                            <td className="py-1.5 pr-2 text-right">{formatCost(r.response_cost || 0)}</td>
                            <td className={`py-1.5 pr-2 text-right ${latencyColorClass(r.latency_ms || 0)}`}>
                              {formatLatency(r.latency_ms || 0)}
                            </td>
                            <td className="py-1.5 pr-2">
                              <span
                                className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] ${
                                  r.status === 'success'
                                    ? 'bg-green-500/20 text-green-400'
                                    : 'bg-red-500/20 text-red-400'
                                }`}
                              >
                                {r.status || 'unknown'}
                              </span>
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr key={`${r.id}-exp`}>
                              <td colSpan={8} className="bg-secondary/40 p-2">
                                <pre className="text-[10px] font-mono whitespace-pre-wrap break-all">
                                  {JSON.stringify(r, null, 2)}
                                </pre>
                              </td>
                            </tr>
                          )}
                        </>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {recordsTotal > PAGE_SIZE && (
              <div className="flex items-center justify-between mt-2 text-xs text-muted-foreground">
                <span>
                  {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, recordsTotal)} of {recordsTotal}
                </span>
                <div className="flex gap-1">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => setPage(p => Math.max(0, p - 1))}
                    disabled={page === 0}
                  >
                    {tFallback(t, 'prev', 'Prev')}
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => setPage(p => (p + 1) * PAGE_SIZE < recordsTotal ? p + 1 : p)}
                    disabled={(page + 1) * PAGE_SIZE >= recordsTotal}
                  >
                    {tFallback(t, 'next', 'Next')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ---------- Cache metrics section ----------

function CacheMetricsSection() {
  const [cacheData, setCacheData] = useState<CacheResponse | null>(null)
  const [cacheLoading, setCacheLoading] = useState(true)
  const [cacheError, setCacheError] = useState<string | null>(null)
  const [cacheWindow, setCacheWindow] = useState<CacheWindow2>('30d')

  useEffect(() => {
    setCacheLoading(true)
    setCacheError(null)
    fetch(`/api/litellm/cache?window=${cacheWindow}`)
      .then(r => {
        if (!r.ok) return r.json().then(d => { throw new Error(d.error || `HTTP ${r.status}`) })
        return r.json()
      })
      .then((d: CacheResponse) => setCacheData(d))
      .catch(e => setCacheError(e?.message || 'Failed to load cache data'))
      .finally(() => setCacheLoading(false))
  }, [cacheWindow])

  const totals = cacheData?.totals
  const chartData = (cacheData?.rows ?? []).map(r => ({
    day: r.day.slice(5),  // 'MM-DD'
    reads: r.cache_read_tokens,
    writes: r.cache_write_tokens,
    hit_pct: r.input_tokens > 0 ? (r.cache_read_tokens / r.input_tokens) * 100 : 0,
  }))

  return (
    <div className="rounded-lg border border-border bg-card p-3 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground font-medium">Anthropic Cache Performance</div>
        <div className="flex gap-1">
          {(['7d', '30d', 'all'] as CacheWindow2[]).map(w => (
            <button
              key={w}
              onClick={() => setCacheWindow(w)}
              className={`px-2 py-0.5 text-[10px] rounded uppercase transition-colors ${
                cacheWindow === w
                  ? 'bg-secondary text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {w}
            </button>
          ))}
        </div>
      </div>

      {cacheError && (
        <div className="text-xs text-red-400">{cacheError}</div>
      )}

      {cacheLoading && !cacheData ? (
        <div className="h-24 rounded bg-secondary/40 animate-pulse" />
      ) : totals ? (
        <>
          <div className="grid gap-2 grid-cols-2 md:grid-cols-4">
            <StatCard
              label="Hit Rate"
              value={`${((totals.hit_rate ?? 0) * 100).toFixed(1)}%`}
              valueClass="text-blue-400"
            />
            <StatCard
              label="Est. Savings"
              value={`$${(totals.est_savings_usd ?? 0).toFixed(4)}`}
              valueClass="text-green-400"
            />
            <StatCard
              label="Cache Reads"
              value={`${((totals.cache_read_tokens ?? 0) / 1_000_000).toFixed(2)}M`}
            />
            <StatCard
              label="Cache Writes"
              value={`${((totals.cache_write_tokens ?? 0) / 1_000_000).toFixed(2)}M`}
              valueClass="text-amber-400"
            />
          </div>

          {chartData.length > 0 && (
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                  <XAxis dataKey="day" tick={{ fontSize: 9, fill: 'rgb(148 163 184)' }} />
                  <YAxis
                    yAxisId="left"
                    tick={{ fontSize: 9, fill: 'rgb(148 163 184)' }}
                    tickFormatter={(v: number) => `${(v / 1_000).toFixed(0)}K`}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tick={{ fontSize: 9, fill: 'rgb(148 163 184)' }}
                    tickFormatter={(v: number) => `${v.toFixed(0)}%`}
                  />
                  <Tooltip
                    contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', fontSize: 11 }}
                    labelStyle={{ color: 'hsl(var(--foreground))' }}
                  />
                  <Bar yAxisId="left" dataKey="reads" name="cache reads" fill="#38bdf8" stackId="a" />
                  <Bar yAxisId="left" dataKey="writes" name="cache writes" fill="#f59e0b" stackId="a" />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="hit_pct"
                    name="hit rate %"
                    stroke="#4ade80"
                    strokeWidth={2}
                    dot={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
        </>
      ) : (
        <div className="text-xs text-muted-foreground py-4 text-center">No cache data for this window.</div>
      )}
    </div>
  )
}

// ---------- Small components ----------

function StatCard({
  label,
  value,
  valueClass = 'text-foreground',
  testid,
}: {
  label: string
  value: string
  valueClass?: string
  testid?: string
}) {
  return (
    <div
      className="rounded-lg border border-border bg-card p-3"
      data-testid={testid}
    >
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${valueClass}`}>{value}</div>
    </div>
  )
}

function MiniStat({
  label,
  value,
  valueClass = 'text-foreground',
}: {
  label: string
  value: string
  valueClass?: string
}) {
  return (
    <div className="rounded-md border border-border bg-card p-2 flex items-baseline justify-between">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className={`text-sm font-medium ${valueClass}`}>{value}</span>
    </div>
  )
}

interface Column<R, K extends string> {
  key: K | string
  label: string
  sortable: boolean
  render: (r: R) => React.ReactNode
  align?: 'left' | 'right'
}

function BreakdownTable<R extends { [k: string]: any }, K extends string>({
  title,
  rows,
  columns,
  sort,
  onToggleSort,
  testid,
}: {
  title: string
  rows: R[]
  columns: Column<R, K>[]
  sort: { key: K; dir: SortDir }
  onToggleSort: (key: K) => void
  testid?: string
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3" data-testid={testid}>
      <div className="text-xs text-muted-foreground mb-2">{title}</div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground border-b border-border">
              {columns.map(c => {
                const isActive = sort.key === c.key
                const arrow = isActive ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''
                return (
                  <th
                    key={c.key as string}
                    className={`py-1.5 pr-2 ${c.align === 'right' ? 'text-right' : ''} ${
                      c.sortable ? 'cursor-pointer select-none hover:text-foreground' : ''
                    }`}
                    onClick={() => c.sortable && onToggleSort(c.key as K)}
                    data-testid={c.sortable ? `sort-${c.key as string}` : undefined}
                  >
                    {c.label}
                    {c.sortable ? arrow : null}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="py-4 text-center text-muted-foreground">
                  —
                </td>
              </tr>
            ) : (
              rows.map((r, i) => (
                <tr key={i} className="border-b border-border/40">
                  {columns.map(c => (
                    <td
                      key={c.key as string}
                      className={`py-1 pr-2 font-mono text-[11px] ${c.align === 'right' ? 'text-right' : ''}`}
                    >
                      {c.render(r)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default LitellmUsagePanel
