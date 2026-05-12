/**
 * Fork-regression: extension manifest + client registration contract.
 *
 * Catches integration-shape failures that per-extension unit tests miss:
 *   - A scheduled task disappears from the manifest (silent drop after rebase).
 *   - A panel's componentMap entry goes missing (renders as upstream-blank).
 *   - The Symbol-guarded one-time nav registration regresses to append-blind
 *     behavior (HMR / Strict Mode would duplicate every nav item).
 *
 * Sibling to `client-boot.test.ts` (onboarding suppression) and
 * `fork-contract.test.ts` (upstream byte-clean check, ships separately).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Server-side: scheduled task contract ─────────────────────────────────────
//
// The manifest in extensions.config.ts is the source of truth for what
// mountExtensions() registers. Test the manifest directly rather than poking
// the module-private extensionTaskState array — same guarantee, no test-only
// production-code export required.

vi.mock('@/lib/db', () => ({
  getDatabase: () => ({}),
}))

vi.mock('../resolver/telemetry', () => ({
  ensureResolverTables: vi.fn(),
  ingestResolverTelemetry: vi.fn(),
  rebuildResolverDailyMetrics: vi.fn(),
}))

vi.mock('../litellm/cache-metrics', () => ({
  ensureCacheDailyTable: vi.fn(),
  rollupCacheMetrics: vi.fn(() => ({ rows_upserted: 0 })),
}))

vi.mock('../litellm/usage', () => ({
  ensureLitellmUsageTable: vi.fn(),
}))

describe('extensions.config — scheduled task manifest', () => {
  it('declares exactly the 3 expected scheduled tasks across all extensions', async () => {
    const { extensions } = await import('../extensions.config')
    const taskIds = extensions
      .flatMap((ext) => (ext.scheduledTasks ?? []).map((t) => `${ext.id}:${t.name}`))
      .sort()
    expect(taskIds).toEqual(
      [
        'litellm:litellm_cache_rollup',
        'resolver:resolver_metrics_rollup',
        'resolver:resolver_telemetry_ingest',
      ].sort(),
    )
  })

  it('every scheduled task has a positive intervalMs and an async fn', async () => {
    const { extensions } = await import('../extensions.config')
    for (const ext of extensions) {
      for (const task of ext.scheduledTasks ?? []) {
        expect(task.intervalMs, `${ext.id}:${task.name}`).toBeGreaterThan(0)
        expect(typeof task.fn, `${ext.id}:${task.name}`).toBe('function')
      }
    }
  })

  it('every scheduled task fn resolves without throwing under happy-path mocks', async () => {
    // Catches "task body throws synchronously on import" regressions —
    // the kind that would leave the task wedged in `running=true` after
    // one tick and silently stop firing forever.
    const { extensions } = await import('../extensions.config')
    for (const ext of extensions) {
      for (const task of ext.scheduledTasks ?? []) {
        await expect(
          task.fn(),
          `${ext.id}:${task.name} threw under happy-path mocks`,
        ).resolves.not.toThrow()
      }
    }
  })

  it('declares the expected api routes per extension (nav-registration sibling check)', async () => {
    const { extensions } = await import('../extensions.config')
    const byId = Object.fromEntries(extensions.map((e) => [e.id, e]))
    expect(byId.resolver.apiRoutes.map((r) => r.path)).toContain('/resolver/metrics')
    expect(byId.litellm.apiRoutes.map((r) => r.path)).toContain('/litellm/usage/summary')
    expect(byId.oap.apiRoutes.map((r) => r.path)).toContain('/oap/approvals')
    expect(byId.fleet.apiRoutes.map((r) => r.path)).toContain('/fleet/services')
    expect(byId.mcp.apiRoutes.map((r) => r.path)).toContain('/mcp-audit/verify')
    expect(byId['security-audit'].apiRoutes.map((r) => r.path)).toContain('/security-audit')
  })
})

// ── Client-side: nav registration + Symbol guard ─────────────────────────────
//
// client.ts populates the upstream plugin registry via `registerNavItems` /
// `registerPanel`. The Symbol-keyed one-time guard prevents re-registration
// across HMR / React Strict Mode. Verify both shapes here.

const FORK_NAV_REGISTERED = Symbol.for('@stroupaloop/mc-fork:nav-registered')

// vi.mock factories are hoisted above top-level const declarations, so the
// mock fns must be initialized inside `vi.hoisted` to avoid a TDZ error.
const { registerNavItemsMock, registerPanelMock } = vi.hoisted(() => ({
  registerNavItemsMock: vi.fn(),
  registerPanelMock: vi.fn(),
}))

vi.mock('@/lib/plugins', () => ({
  registerNavItems: (items: unknown[]) => registerNavItemsMock(items),
  registerPanel: (id: string, component: unknown) => registerPanelMock(id, component),
}))

describe('client.ts — nav + panel registration', () => {
  beforeEach(() => {
    registerNavItemsMock.mockClear()
    registerPanelMock.mockClear()
    // Symbol.for keys live on the global registry — clear so each test
    // starts from a clean slate.
    delete (globalThis as Record<symbol, unknown>)[FORK_NAV_REGISTERED]
    vi.resetModules()
  })

  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[FORK_NAV_REGISTERED]
  })

  it('registers the expected 5 panels (one per UI extension)', async () => {
    const { __clientExtensionsRegistered } = await import('../client')
    expect(__clientExtensionsRegistered.panels.sort()).toEqual(
      ['fleet', 'litellm-usage', 'oap-approvals', 'oap-audit', 'resolver-intelligence'],
    )
  })

  it('registers nav items for every panel declared in clientExtensions', async () => {
    const { __clientExtensionsRegistered } = await import('../client')
    expect(__clientExtensionsRegistered.navItems.sort()).toEqual(
      ['fleet', 'litellm-usage', 'oap-approvals', 'oap-audit', 'resolver-intelligence'],
    )
  })

  it('calls registerNavItems exactly once per process (Symbol guard works)', async () => {
    await import('../client')
    expect(registerNavItemsMock).toHaveBeenCalledTimes(1)

    // Re-import after resetModules → fresh module evaluation. The Symbol
    // flag survives on globalThis, so the second eval must not re-register.
    vi.resetModules()
    await import('../client')
    expect(registerNavItemsMock).toHaveBeenCalledTimes(1)
  })

  it('passes nav items with the expected shape (id + label + groupId + icon)', async () => {
    await import('../client')
    const calls = registerNavItemsMock.mock.calls
    expect(calls).toHaveLength(1)
    const items = calls[0][0] as Array<{
      id: string
      label: string
      groupId: string
      icon: string
    }>
    for (const item of items) {
      expect(item.id).toBeTypeOf('string')
      expect(item.label).toBeTypeOf('string')
      expect(item.groupId).toBeTypeOf('string')
      expect(item.icon).toBeTypeOf('string')
    }
  })
})
