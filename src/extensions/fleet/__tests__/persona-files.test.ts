import { describe, expect, it } from 'vitest'
import {
  PERSONA_FILES,
  canReadPersona,
  canWritePersona,
  readablePersonaFiles,
  isPersonaFile,
} from '../lib/persona-files'

// Pins the §3 access matrices so a Phase-2 edit that misorders or mistypes a
// role row fails loudly here rather than silently widening access.
describe('persona-files matrices', () => {
  it('exposes exactly the four seeded persona files', () => {
    expect([...PERSONA_FILES]).toEqual([
      'IDENTITY.md',
      'SOUL.md',
      'USER.md',
      'AGENTS.md',
    ])
  })

  it('admin may read AND write all four files', () => {
    for (const f of PERSONA_FILES) {
      expect(canReadPersona('admin', f)).toBe(true)
      expect(canWritePersona('admin', f)).toBe(true)
    }
    expect(readablePersonaFiles('admin')).toHaveLength(4)
  })

  it('owner (forward contract) may read all but write only IDENTITY.md + USER.md', () => {
    for (const f of PERSONA_FILES) {
      expect(canReadPersona('owner', f)).toBe(true)
    }
    expect(canWritePersona('owner', 'IDENTITY.md')).toBe(true)
    expect(canWritePersona('owner', 'USER.md')).toBe(true)
    expect(canWritePersona('owner', 'SOUL.md')).toBe(false)
    expect(canWritePersona('owner', 'AGENTS.md')).toBe(false)
  })

  it('operator/viewer/undefined get no access (Phase-1 admin-only)', () => {
    for (const role of ['operator', 'viewer', undefined] as const) {
      expect(readablePersonaFiles(role)).toHaveLength(0)
      for (const f of PERSONA_FILES) {
        expect(canReadPersona(role, f)).toBe(false)
        expect(canWritePersona(role, f)).toBe(false)
      }
    }
  })

  it('isPersonaFile gates the allow-list', () => {
    expect(isPersonaFile('IDENTITY.md')).toBe(true)
    expect(isPersonaFile('TOOLS.md')).toBe(false)
    expect(isPersonaFile('../config/openclaw.json')).toBe(false)
  })
})
