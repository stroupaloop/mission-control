/**
 * Type-only module for extension manifest descriptors.
 *
 * Split out from extensions.config.ts so the types can be imported by the
 * client-side manifest (manifest.client.ts) without pulling in the server-only
 * implementation dependencies (better-sqlite3, scheduler, etc.).
 *
 * This file MUST contain only types/interfaces — no runtime code.
 */

export interface ApiRouteDescriptor {
  path: string
  methods: Array<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'>
}

export interface ScheduledTask {
  name: string
  intervalMs: number
  fn: () => Promise<void>
}

export interface PanelDescriptor {
  id: string
  label: string
  groupId: 'operations' | 'observability' | 'admin'
  icon?: string
}
