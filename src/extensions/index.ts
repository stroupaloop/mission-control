/**
 * Extensions index — @stroupaloop/mission-control
 *
 * This is the single mount point for all AMS customizations. Each extension
 * declares its API routes, startup hooks, and scheduled tasks via the manifest
 * in extensions.config.ts. The main application calls `mountExtensions()` once
 * at boot (in src/lib/db.ts alongside initScheduler) to wire everything in.
 *
 * Separation of concerns:
 *   - Upstream files under src/app/api/, src/lib/, src/components/ are untouched
 *     except for the ONE import line added to src/lib/db.ts.
 *   - All AMS-specific logic lives under src/extensions/<area>/.
 *   - This file is the only cross-cutting glue.
 */

import { extensions } from './extensions.config'
import type { ExtensionManifest } from './extensions.config'

// Re-export the type for consumers
export type { ExtensionManifest }

let mounted = false

/**
 * Register all extension routes and run startup hooks.
 * Called once from src/lib/db.ts after the scheduler is initialized.
 * Safe to call multiple times (idempotent via `mounted` guard).
 */
export async function mountExtensions(): Promise<void> {
  if (mounted) return
  mounted = true

  for (const ext of extensions) {
    // Run startup hooks
    if (ext.startupHooks) {
      for (const hook of ext.startupHooks) {
        try {
          await hook()
        } catch (err) {
          console.error(`[extensions] startup hook failed for ${ext.id}:`, err)
        }
      }
    }

    // Note: API routes in Next.js app router are file-based and are wired by
    // placing the handlers in src/extensions/<area>/api/ and re-exporting them
    // from src/app/api/<path>/route.ts shim files. See each extension's api/
    // directory for the handler implementations, and the corresponding shims
    // in src/app/api/ for the Next.js routing entry points.
  }
}

/**
 * Register extension scheduled tasks with the MC scheduler.
 * Called from src/lib/scheduler.ts initScheduler() to add extension tasks
 * to the built-in task registry.
 */
export function getExtensionScheduledTasks(): Array<{
  id: string
  name: string
  intervalMs: number
  fn: () => Promise<{ ok: boolean; message: string }>
}> {
  const result: Array<{
    id: string
    name: string
    intervalMs: number
    fn: () => Promise<{ ok: boolean; message: string }>
  }> = []

  for (const ext of extensions) {
    if (ext.scheduledTasks) {
      for (const task of ext.scheduledTasks) {
        result.push({
          id: `${ext.id}:${task.name}`,
          name: task.name,
          intervalMs: task.intervalMs,
          fn: async () => {
            try {
              await task.fn()
              return { ok: true, message: `${ext.id}:${task.name} completed` }
            } catch (err: any) {
              return { ok: false, message: err?.message ?? 'unknown error' }
            }
          },
        })
      }
    }
  }

  return result
}
