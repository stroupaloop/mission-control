'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'

// ---------- Types ----------

type Risk = 'low' | 'medium' | 'high' | 'critical'
type Status = 'pending' | 'approved' | 'denied'
type FilterTab = 'all' | 'pending' | 'resolved'
type ApprovalAction = 'approve' | 'deny' | 'approve_and_add'

export interface OapDecision {
  decision_id: string
  capability?: string
  agent?: string
  agent_name?: string
  passport?: { agent?: string; name?: string; agent_id?: string }
  risk?: Risk | string
  reason?: string
  context?: string
  created_at?: string | number
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

interface PendingRow extends OapDecision {
  _id: string
  _risk: Risk
  _agentLabel: string
  _capability: string
  _shortId: string
  _createdAtMs: number
  _status: Status
}

// ---------- Styling ----------

const RISK_BORDER: Record<Risk, string> = {
  low: 'border-l-green-500',
  medium: 'border-l-yellow-500',
  high: 'border-l-orange-500',
  critical: 'border-l-red-500',
}

const RISK_BADGE: Record<Risk, { bg: string; text: string }> = {
  low: { bg: 'bg-green-500/20', text: 'text-green-400' },
  medium: { bg: 'bg-yellow-500/20', text: 'text-yellow-400' },
  high: { bg: 'bg-orange-500/20', text: 'text-orange-400' },
  critical: { bg: 'bg-red-500/20', text: 'text-red-400' },
}

// ---------- Helpers ----------

function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function normalizeRisk(r: unknown): Risk {
  const v = String(r || 'low').toLowerCase()
  if (v === 'critical' || v === 'high' || v === 'medium' || v === 'low') return v
  return 'low'
}

function parseCreatedAt(v: unknown): number {
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000
  if (typeof v === 'string') {
    const n = Date.parse(v)
    if (!isNaN(n)) return n
  }
  return Date.now()
}

function shortId(id: string): string {
  if (!id) return ''
  if (id.length <= 10) return id
  return `${id.slice(0, 6)}…${id.slice(-4)}`
}

function toRow(d: OapDecision, overrideStatus: Status = 'pending'): PendingRow {
  const id = String(d.decision_id || '')
  const agentLabel =
    (d.agent_name as string) ||
    (d.passport?.name as string) ||
    (d.passport?.agent as string) ||
    (d.passport?.agent_id as string) ||
    (d.agent as string) ||
    'unknown'
  const capability = String(d.capability || 'unknown')
  const risk = normalizeRisk(d.risk)
  const createdAtMs = parseCreatedAt(d.created_at)
  return {
    ...d,
    _id: id,
    _risk: risk,
    _agentLabel: agentLabel,
    _capability: capability,
    _shortId: shortId(id),
    _createdAtMs: createdAtMs,
    _status: overrideStatus,
  }
}

// ---------- Toast ----------

interface Toast {
  id: number
  message: string
  kind: 'error' | 'info' | 'success'
}

// ---------- Main Panel ----------

export function OapApprovalsPanel() {
  const t = useTranslations('oapApprovals')
  const [rows, setRows] = useState<PendingRow[]>([])
  const [resolvedRows, setResolvedRows] = useState<PendingRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<FilterTab>('pending')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [toasts, setToasts] = useState<Toast[]>([])
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set())
  const pausedRef = useRef(false)
  const visibilityRef = useRef<boolean>(true)

  const pushToast = useCallback((message: string, kind: Toast['kind'] = 'info') => {
    const id = Date.now() + Math.random()
    setToasts(ts => [...ts, { id, message, kind }])
    setTimeout(() => {
      setToasts(ts => ts.filter(t => t.id !== id))
    }, 4000)
  }, [])

  const loadPending = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const res = await fetch('/api/oap/approvals', { method: 'GET' })
      if (res.status === 502) {
        setError(t('sidecarUnreachable'))
        return
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      const data = await res.json().catch(() => ({ pending: [] }))
      const list: OapDecision[] = Array.isArray(data.pending) ? data.pending : []
      setRows(list.map(d => toRow(d, 'pending')))
      setError(null)
    } catch (err: any) {
      if (typeof console !== 'undefined') console.error('oap-approvals fetch failed', err)
      setError(err?.message || t('loadError'))
    } finally {
      if (!silent) setLoading(false)
    }
  }, [t])

  // Initial load
  useEffect(() => {
    loadPending(false)
  }, [loadPending])

  // Visibility-aware auto refresh every 30s
  useEffect(() => {
    const onVisibility = () => {
      visibilityRef.current = !document.hidden
    }
    document.addEventListener('visibilitychange', onVisibility)
    const interval = setInterval(() => {
      if (!visibilityRef.current) return
      if (pausedRef.current) return
      loadPending(true)
    }, 30000)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      clearInterval(interval)
    }
  }, [loadPending])

  const combined = useMemo<PendingRow[]>(() => {
    // Merge resolved rows on top, but filters decide display
    if (filter === 'pending') return rows
    if (filter === 'resolved') return resolvedRows
    return [...rows, ...resolvedRows]
  }, [rows, resolvedRows, filter])

  const displayRows = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return combined
    return combined.filter(r => {
      return (
        r._id.toLowerCase().includes(q) ||
        r._agentLabel.toLowerCase().includes(q) ||
        r._capability.toLowerCase().includes(q)
      )
    })
  }, [combined, search])

  const pendingCount = rows.length

  // ---- Actions ----

  const resolveDecision = useCallback(
    async (decisionId: string, action: ApprovalAction, options?: { silent?: boolean }) => {
      // Find and optimistically remove
      let snapshot: PendingRow | undefined
      setRows(prev => {
        snapshot = prev.find(r => r._id === decisionId)
        return prev.filter(r => r._id !== decisionId)
      })
      setBusyIds(prev => {
        const next = new Set(prev)
        next.add(decisionId)
        return next
      })
      try {
        const res = await fetch('/api/oap/approvals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision_id: decisionId, action }),
        })
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          throw new Error(data.error || `HTTP ${res.status}`)
        }
        // Record as resolved for resolved filter tab
        if (snapshot) {
          const newStatus: Status = action === 'deny' ? 'denied' : 'approved'
          setResolvedRows(prev => [{ ...snapshot!, _status: newStatus }, ...prev].slice(0, 500))
        }
        if (!options?.silent) {
          const label =
            action === 'deny'
              ? t('toastDenied', { id: shortId(decisionId) })
              : action === 'approve_and_add'
              ? t('toastApprovedAndAdded', { id: shortId(decisionId) })
              : t('toastApproved', { id: shortId(decisionId) })
          pushToast(label, 'success')
        }
      } catch (err: any) {
        // Roll back
        if (snapshot) {
          setRows(prev => {
            if (prev.some(r => r._id === decisionId)) return prev
            return [snapshot!, ...prev]
          })
        }
        pushToast(t('toastActionFailed', { error: err?.message || 'unknown' }), 'error')
      } finally {
        setBusyIds(prev => {
          const next = new Set(prev)
          next.delete(decisionId)
          return next
        })
      }
    },
    [pushToast, t]
  )

  const handleBulk = useCallback(
    async (action: ApprovalAction) => {
      const ids = Array.from(selected)
      if (ids.length === 0) return
      setSelected(new Set())
      for (const id of ids) {
        // Intentionally sequential to avoid spamming sidecar
        // eslint-disable-next-line no-await-in-loop
        await resolveDecision(id, action, { silent: true })
      }
      pushToast(t('toastBulkDone', { count: ids.length }), 'success')
    },
    [selected, resolveDecision, pushToast, t]
  )

  const toggleSelect = useCallback((id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleExpanded = useCallback((id: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const selectAllVisible = useCallback(() => {
    setSelected(new Set(displayRows.filter(r => r._status === 'pending').map(r => r._id)))
  }, [displayRows])

  const clearSelection = useCallback(() => setSelected(new Set()), [])

  // ---- Render ----

  return (
    <div className="m-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
          {pendingCount > 0 && (
            <span
              className="inline-flex items-center rounded-full bg-red-500/20 px-2.5 py-0.5 text-xs font-medium text-red-400"
              data-testid="oap-pending-badge"
            >
              {t('pendingBadge', { count: pendingCount })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="xs"
            variant="outline"
            onClick={() => loadPending(false)}
            disabled={loading}
            title={t('refresh')}
          >
            {loading ? t('refreshing') : t('refresh')}
          </Button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400 flex items-center justify-between">
          <span>{error}</span>
          <Button size="xs" variant="outline" onClick={() => loadPending(false)}>
            {t('retry')}
          </Button>
        </div>
      )}

      {/* Filter tabs + search */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-1" role="tablist" aria-label={t('filtersAria')}>
          {(['all', 'pending', 'resolved'] as const).map(tab => (
            <button
              key={tab}
              role="tab"
              aria-selected={filter === tab}
              onClick={() => setFilter(tab)}
              className={`px-2.5 py-1 text-xs rounded capitalize transition-colors ${
                filter === tab
                  ? 'bg-secondary text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t(`filter${tab.charAt(0).toUpperCase() + tab.slice(1)}` as 'filterAll' | 'filterPending' | 'filterResolved')}
            </button>
          ))}
        </div>
        <input
          type="text"
          aria-label={t('searchAria')}
          placeholder={t('searchPlaceholder')}
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="flex-1 sm:max-w-xs bg-secondary border border-border rounded px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
        />
      </div>

      {/* Bulk actions bar */}
      {selected.size > 0 && (
        <div className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">
              {t('selectedCount', { count: selected.size })}
            </span>
            <button
              onClick={clearSelection}
              className="underline text-muted-foreground hover:text-foreground"
            >
              {t('clear')}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="xs"
              className="bg-green-600 hover:bg-green-700 text-white"
              onClick={() => handleBulk('approve')}
            >
              {t('bulkApprove')}
            </Button>
            <Button
              size="xs"
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={() => handleBulk('deny')}
            >
              {t('bulkDeny')}
            </Button>
          </div>
        </div>
      )}

      {/* List */}
      {loading && rows.length === 0 ? (
        <div className="space-y-2" data-testid="oap-skeleton">
          {[0, 1, 2, 3, 4].map(i => (
            <div
              key={i}
              className="h-20 rounded-lg border border-border bg-card animate-pulse"
            />
          ))}
        </div>
      ) : displayRows.length === 0 ? (
        <div
          className="text-center py-12 text-muted-foreground text-sm"
          data-testid="oap-empty-state"
        >
          {filter === 'pending' ? t('emptyPending') : t('emptyAll')}
        </div>
      ) : (
        <>
          {/* Select all bar (only in pending view) */}
          {filter !== 'resolved' && displayRows.some(r => r._status === 'pending') && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground px-1">
              <button
                onClick={selectAllVisible}
                className="underline hover:text-foreground"
              >
                {t('selectAllVisible', { count: displayRows.filter(r => r._status === 'pending').length })}
              </button>
            </div>
          )}
          <div className="space-y-2">
            {displayRows.map(row => (
              <OapRow
                key={row._id}
                row={row}
                selected={selected.has(row._id)}
                expanded={expanded.has(row._id)}
                busy={busyIds.has(row._id)}
                onToggleSelect={() => toggleSelect(row._id)}
                onToggleExpanded={() => toggleExpanded(row._id)}
                onApprove={() => resolveDecision(row._id, 'approve')}
                onApproveAndAdd={() => resolveDecision(row._id, 'approve_and_add')}
                onDeny={() => resolveDecision(row._id, 'deny')}
              />
            ))}
          </div>
        </>
      )}

      {/* Toasts */}
      {toasts.length > 0 && (
        <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
          {toasts.map(toast => (
            <div
              key={toast.id}
              role="status"
              className={`pointer-events-auto rounded-lg border px-3 py-2 text-xs shadow-lg ${
                toast.kind === 'error'
                  ? 'border-red-500/40 bg-red-500/10 text-red-400'
                  : toast.kind === 'success'
                  ? 'border-green-500/40 bg-green-500/10 text-green-400'
                  : 'border-border bg-card text-foreground'
              }`}
            >
              {toast.message}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------- Row ----------

function OapRow({
  row,
  selected,
  expanded,
  busy,
  onToggleSelect,
  onToggleExpanded,
  onApprove,
  onApproveAndAdd,
  onDeny,
}: {
  row: PendingRow
  selected: boolean
  expanded: boolean
  busy: boolean
  onToggleSelect: () => void
  onToggleExpanded: () => void
  onApprove: () => void
  onApproveAndAdd: () => void
  onDeny: () => void
}) {
  const t = useTranslations('oapApprovals')
  const riskBorder = RISK_BORDER[row._risk]
  const riskBadge = RISK_BADGE[row._risk]
  const isPending = row._status === 'pending'
  const reason = (row.reason as string) || (row.context as string) || ''

  return (
    <div
      data-testid="oap-row"
      data-decision-id={row._id}
      className={`rounded-lg border border-border bg-card p-3 border-l-4 ${riskBorder} ${busy ? 'opacity-60' : ''}`}
    >
      <div className="flex items-start gap-3">
        {isPending && (
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelect}
            aria-label={t('selectRow', { id: row._shortId })}
            className="mt-1.5 shrink-0 cursor-pointer"
          />
        )}
        <div className="flex-1 min-w-0">
          {/* Top row: meta */}
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium text-foreground">{row._agentLabel}</span>
            <span
              className="font-mono text-xs bg-secondary rounded px-1.5 py-0.5 text-muted-foreground"
              title={row._capability}
            >
              {row._capability}
            </span>
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${riskBadge.bg} ${riskBadge.text}`}
            >
              {row._risk}
            </span>
            <span
              className="font-mono text-xs text-muted-foreground"
              title={row._id}
            >
              {row._shortId}
            </span>
            <span className="text-xs text-muted-foreground">
              {timeAgo(row._createdAtMs)}
            </span>
            {!isPending && (
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                  row._status === 'approved'
                    ? 'bg-green-500/20 text-green-400'
                    : 'bg-red-500/20 text-red-400'
                }`}
              >
                {row._status === 'approved' ? t('statusApproved') : t('statusDenied')}
              </span>
            )}
          </div>

          {/* Reason snippet */}
          {reason && (
            <div className="mt-1 text-xs text-muted-foreground line-clamp-2">
              {reason}
            </div>
          )}

          {/* Expanded details */}
          {expanded && (
            <pre className="mt-2 bg-secondary rounded p-2 text-xs font-mono overflow-auto max-h-64 text-foreground border border-border">
              {JSON.stringify(row, (k, v) => (k.startsWith('_') ? undefined : v), 2)}
            </pre>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1.5 shrink-0">
          <Button
            size="xs"
            variant="ghost"
            onClick={onToggleExpanded}
            title={expanded ? t('hideDetails') : t('showDetails')}
            aria-label={expanded ? t('hideDetails') : t('showDetails')}
          >
            👁
          </Button>
          {isPending && (
            <>
              <Button
                size="xs"
                className="bg-green-600 hover:bg-green-700 text-white"
                onClick={onApprove}
                disabled={busy}
                aria-label={t('approve')}
              >
                ✅ {t('approve')}
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={onApproveAndAdd}
                disabled={busy}
                title={t('approveAndAddHint')}
                aria-label={t('approveAndAdd')}
              >
                ✅➕
              </Button>
              <Button
                size="xs"
                className="bg-red-600 hover:bg-red-700 text-white"
                onClick={onDeny}
                disabled={busy}
                aria-label={t('deny')}
              >
                ❌ {t('deny')}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export default OapApprovalsPanel
