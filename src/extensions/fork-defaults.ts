/**
 * Fork-level default settings.
 *
 * Applied once during mountExtensions() before any extension hooks so UI
 * preferences are settled before the first page render.
 *
 * These are the AMS-fork opinions about upstream defaults (onboarding bypass,
 * default nav mode, etc.). Runs server-side at boot, writes to the settings
 * store that backs the upstream settings table.
 */

import { getDatabase } from '@/lib/db'

type SettingsRow = { key: string; value: string }

/**
 * Apply AMS fork defaults to the settings table if they haven't been
 * overridden by an admin. Idempotent — writes are keyed and skip if present.
 */
export function applyForkDefaults(): void {
  // Env-controlled kill switch — set MC_DISABLE_FORK_DEFAULTS=1 to skip.
  if (process.env.MC_DISABLE_FORK_DEFAULTS === '1') return

  try {
    const db = getDatabase()

    const defaults: SettingsRow[] = []

    // Onboarding bypass — fork runs admin-first, no wizard flow.
    if (process.env.MC_DISABLE_ONBOARDING !== 'false') {
      defaults.push({ key: 'onboarding.completed', value: 'true' })
      defaults.push({ key: 'onboarding.skipped', value: 'true' })
    }

    // Default the nav to "full" (expanded sidebar) when NEXT_PUBLIC_
    // MC_DEFAULT_INTERFACE_MODE is set to "full". Upstream defaults to
    // collapsed.
    if (process.env.NEXT_PUBLIC_MC_DEFAULT_INTERFACE_MODE === 'full') {
      defaults.push({ key: 'interface.mode', value: 'full' })
    }

    if (defaults.length === 0) return

    const stmt = db.prepare(
      'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
    )
    const tx = db.transaction((rows: SettingsRow[]) => {
      for (const row of rows) stmt.run(row.key, row.value)
    })
    tx(defaults)
  } catch (err) {
    // Don't crash boot on settings-write failure — this is a UX convenience,
    // not a correctness requirement.
    console.warn('[fork-defaults] could not apply defaults:', err)
  }
}
