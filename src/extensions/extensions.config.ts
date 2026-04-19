/**
 * Extension manifest declarations — @stroupaloop/mission-control
 *
 * Each entry describes an AMS extension: which API routes it provides,
 * which startup hooks to run, and which recurring tasks to schedule.
 *
 * API routes are implemented as plain handler functions in
 * src/extensions/<area>/api/*.ts and re-exported from Next.js route shims.
 * This manifest is the authoritative registry — if an extension isn't listed
 * here, it won't have its hooks or scheduled tasks wired at boot.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ApiRouteDescriptor {
  /** URL path relative to /api, e.g. '/resolver/overrides' */
  path: string
  methods: Array<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'>
}

export interface ScheduledTask {
  name: string
  intervalMs: number
  fn: () => Promise<void>
}

/**
 * UI descriptor — a "panel" is a client-rendered page that appears under a
 * URL slug like /resolver-intelligence. The manifest only carries the string
 * id — the actual React component is registered in client.ts via a componentMap
 * so the manifest stays serializable and safe to import from the server graph.
 */
export interface PanelDescriptor {
  /** Stable panel id — used as URL slug and componentMap key */
  id: string
  /** Human-readable label shown in the nav rail */
  label: string
  /** Nav grouping — must match a group id recognized by nav-rail */
  groupId: 'operations' | 'observability' | 'admin'
  /** Optional lucide icon name (default sparkles) */
  icon?: string
}

export interface ExtensionManifest {
  id: 'resolver' | 'litellm' | 'oap' | 'mcp' | 'security-audit'
  /** Human-readable extension name */
  displayName: string
  /** API routes provided by this extension */
  apiRoutes: ApiRouteDescriptor[]
  /** Hooks run once at application boot (before first request) */
  startupHooks?: Array<() => void | Promise<void>>
  /** Recurring tasks registered with the MC scheduler */
  scheduledTasks?: ScheduledTask[]
  /** UI panels provided by this extension (client-registered via client.ts) */
  panels?: PanelDescriptor[]
}

// ── Resolver Extension ────────────────────────────────────────────────────────

import { ingestResolverTelemetry, rebuildResolverDailyMetrics, ensureResolverTables } from './resolver/telemetry'
import { getDatabase } from '@/lib/db'

const RESOLVER_TICK_MS = 60 * 1000 // 60s — tail JSONL every minute
const RESOLVER_ROLLUP_MS = 5 * 60 * 1000 // 5min — rebuild daily metrics

const resolverExtension: ExtensionManifest = {
  id: 'resolver',
  displayName: 'Resolver Intelligence',
  apiRoutes: [
    { path: '/resolver/recommendations', methods: ['GET'] },
    { path: '/resolver/overrides', methods: ['GET', 'POST'] },
    { path: '/resolver/overrides/:toolId', methods: ['DELETE'] },
  ],
  panels: [
    {
      id: 'resolver-intelligence',
      label: 'Resolver Intelligence',
      groupId: 'observability',
      icon: 'brain-circuit',
    },
  ],
  startupHooks: [
    () => {
      // Ensure resolver DB tables exist at boot time (idempotent migration)
      try {
        const db = getDatabase()
        ensureResolverTables(db)
      } catch {
        // Non-fatal — tables will be created on first ingest
      }
    },
  ],
  scheduledTasks: [
    {
      name: 'resolver_telemetry_ingest',
      intervalMs: RESOLVER_TICK_MS,
      fn: async () => {
        ingestResolverTelemetry()
      },
    },
    {
      name: 'resolver_metrics_rollup',
      intervalMs: RESOLVER_ROLLUP_MS,
      fn: async () => {
        rebuildResolverDailyMetrics()
      },
    },
  ],
}

// ── LiteLLM Extension ─────────────────────────────────────────────────────────

const litellmExtension: ExtensionManifest = {
  id: 'litellm',
  displayName: 'LiteLLM Usage & Attribution',
  apiRoutes: [
    { path: '/litellm/usage', methods: ['GET', 'POST'] },
    { path: '/litellm/usage/summary', methods: ['GET'] },
    { path: '/litellm/dashboard/records', methods: ['GET'] },
    { path: '/litellm/dashboard/summary', methods: ['GET'] },
  ],
}

// ── OAP Extension ──────────────────────────────────────────────────────────────

const oapExtension: ExtensionManifest = {
  id: 'oap',
  displayName: 'OAP Audit Ingest & Approvals',
  apiRoutes: [
    { path: '/audit', methods: ['GET', 'POST'] },
    { path: '/oap/approvals', methods: ['GET', 'POST', 'PATCH'] },
  ],
}

// ── MCP Extension ──────────────────────────────────────────────────────────────

const mcpExtension: ExtensionManifest = {
  id: 'mcp',
  displayName: 'MCP Audit Pipeline',
  apiRoutes: [
    { path: '/mcp-audit/verify', methods: ['GET'] },
  ],
}

// ── Security-Audit Extension ───────────────────────────────────────────────────

const securityAuditExtension: ExtensionManifest = {
  id: 'security-audit',
  displayName: 'Security Audit',
  apiRoutes: [
    { path: '/security-audit', methods: ['GET', 'POST'] },
  ],
}

// ── Registry ──────────────────────────────────────────────────────────────────

export const extensions: ExtensionManifest[] = [
  resolverExtension,
  litellmExtension,
  oapExtension,
  mcpExtension,
  securityAuditExtension,
]
