import type { User } from '@/lib/auth'

/**
 * Persona-file allow-list + §3 access matrices — the SINGLE SOURCE OF TRUTH
 * shared by the server handler (`api/workspace.ts`) and the Settings-tab UI
 * (`panels/persona-settings-form.tsx`).
 *
 * This module is intentionally free of server-only imports (no `node:fs`,
 * no AWS SDK) so a `'use client'` component can import it without dragging
 * server deps into the browser bundle. Both sides import from here rather than
 * each defining their own copy — the slack-token-patterns lesson (Round-3 audit
 * on PR #51): a mirrored copy silently drifts on the next server-side change.
 */

/**
 * The four persona files seeded to every agent's workspace by the
 * workspace-defaults + archetype overlay (memo §1.2). TOOLS.md is intentionally
 * absent — it is not seeded today, so editing it would be a no-op (memo §1.3,
 * deferred). This list is the authoritative read/write allow-list.
 */
export const PERSONA_FILES = [
  'IDENTITY.md',
  'SOUL.md',
  'USER.md',
  'AGENTS.md',
] as const
export type PersonaFile = (typeof PERSONA_FILES)[number]

/** Roles that can appear in the §3 matrix. `owner` is not yet a real MC role —
 *  its rows are the forward contract, inert until the ownership primitive lands
 *  (then the owner-tier UI lights up with no code change here). */
export type EditorRole = User['role'] | 'owner'

/**
 * §3 READ matrix — who may GET which files. Read is deliberately a SEPARATE
 * matrix from write: an owner may *view* SOUL.md/AGENTS.md (needed for the
 * "request a change" affordance) but never PUT them.
 */
export const READ_MATRIX: Partial<Record<EditorRole, readonly PersonaFile[]>> = {
  admin: PERSONA_FILES,
  // Phase-2 (owner self-service) — inert until the ownership primitive lands:
  owner: PERSONA_FILES,
}

/**
 * §3 WRITE matrix — who may PUT which files. SOUL.md + AGENTS.md are admin-only
 * because they carry the safety envelope (behavioral constraints, channel
 * segregation, heartbeat rules); an owner editing them would be a real liability.
 */
export const WRITE_MATRIX: Partial<Record<EditorRole, readonly PersonaFile[]>> =
  {
    admin: PERSONA_FILES,
    // Phase-2 (owner self-service) — inert until the ownership primitive lands:
    owner: ['IDENTITY.md', 'USER.md'],
  }

/**
 * Cap on persona-file size. These are human-authored markdown; 1 MiB is far
 * above any real persona file and bounds a pathological write. memory-core
 * indexes them on session start, so an enormous file would also bloat the agent.
 */
export const MAX_PERSONA_BYTES = 1024 * 1024

export function isPersonaFile(f: string): f is PersonaFile {
  return (PERSONA_FILES as readonly string[]).includes(f)
}

/** Whether `role` may GET `file` (drives which file tabs the UI fetches). */
export function canReadPersona(
  role: EditorRole | undefined,
  file: PersonaFile,
): boolean {
  if (!role) return false
  return (READ_MATRIX[role] ?? []).includes(file)
}

/** Whether `role` may PUT `file` (drives editor enable/disable + Save). */
export function canWritePersona(
  role: EditorRole | undefined,
  file: PersonaFile,
): boolean {
  if (!role) return false
  return (WRITE_MATRIX[role] ?? []).includes(file)
}

/** The persona files `role` may read, in canonical order (UI tab set). */
export function readablePersonaFiles(
  role: EditorRole | undefined,
): PersonaFile[] {
  return PERSONA_FILES.filter((f) => canReadPersona(role, f))
}
