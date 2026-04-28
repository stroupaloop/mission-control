/**
 * Client-side extension manifest — pure data, no server imports.
 *
 * This file is imported into the CLIENT module graph by src/extensions/client.ts.
 * It MUST NOT import from extensions.config.ts (which pulls in server-only code
 * like better-sqlite3 and the scheduler) or from any extension's server-side
 * implementation (e.g. ./resolver/telemetry).
 *
 * Keep this file dependency-free apart from type-only imports. Panel component
 * references live in client.ts via a string-keyed componentMap, not here.
 */

import type { PanelDescriptor } from './extensions.config.ts.types'

export interface ClientExtensionManifest {
  id: 'resolver' | 'litellm' | 'oap' | 'mcp' | 'security-audit' | 'fleet'
  displayName: string
  panels?: PanelDescriptor[]
}

// ── Client manifest list ─────────────────────────────────────────────────────
//
// Must stay in sync with extensions.config.ts (server side). Lint rule
// (future work): generate this from extensions.config.ts at build time to
// prevent drift. For now it's manually mirrored — see comment in client.ts.

export const clientExtensions: ClientExtensionManifest[] = [
  {
    id: 'resolver',
    displayName: 'Resolver Intelligence',
    panels: [
      {
        id: 'resolver-intelligence',
        label: 'Resolver Intelligence',
        groupId: 'observe',
        icon: 'brain-circuit',
      },
    ],
  },
  {
    id: 'oap',
    displayName: 'OAP',
    panels: [
      {
        id: 'oap-approvals',
        label: 'OAP Approvals',
        groupId: 'observe',
        icon: 'shield-check',
      },
      {
        id: 'oap-audit',
        label: 'OAP Audit Trail',
        groupId: 'observe',
        icon: 'file-clock',
      },
    ],
  },
  {
    id: 'litellm',
    displayName: 'LiteLLM',
    panels: [
      {
        id: 'litellm-usage',
        label: 'LiteLLM Usage',
        groupId: 'observe',
        icon: 'activity',
      },
    ],
  },
  {
    id: 'fleet',
    displayName: 'Fleet',
    panels: [
      {
        id: 'fleet',
        label: 'Fleet',
        groupId: 'automate',
        icon: 'cpu',
      },
    ],
  },
  // mcp and security-audit are backend-only extensions (scheduled tasks +
  // startup hooks). No UI panels to register.
]
