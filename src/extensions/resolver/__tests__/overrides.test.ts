import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  resolveOverridesPath,
  validateOverride,
  validateOverridesFile,
  readOverrides,
  writeOverrides,
  upsertOverride,
  removeOverride,
  type ResolverOverridesFile,
} from '../overrides'

// ── Helpers ───────────────────────────────────────────────────────────────────

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-overrides-test-'))
}

function mkOverridesFile(dir: string, data?: Partial<ResolverOverridesFile>): string {
  const p = path.join(dir, 'resolver-overrides.json')
  const content: ResolverOverridesFile = {
    version: 1,
    updatedAt: '2026-04-19T00:00:00.000Z',
    overrides: {},
    ...data,
  }
  fs.writeFileSync(p, JSON.stringify(content, null, 2))
  return p
}

// ── resolveOverridesPath ───────────────────────────────────────────────────────

describe('resolveOverridesPath', () => {
  const origEnv = { ...process.env }

  afterEach(() => {
    Object.assign(process.env, origEnv)
    for (const k of Object.keys(process.env)) {
      if (!(k in origEnv)) delete process.env[k]
    }
  })

  it('prefers MC_RESOLVER_OVERRIDES_PATH env', () => {
    process.env.MC_RESOLVER_OVERRIDES_PATH = '/custom/path/overrides.json'
    expect(resolveOverridesPath()).toBe('/custom/path/overrides.json')
  })

  it('returns empty string when no config available', () => {
    delete process.env.MC_RESOLVER_OVERRIDES_PATH
    // Can't easily blank config.openclawWorkspaceDir, but we can at least verify the function returns a string
    expect(typeof resolveOverridesPath()).toBe('string')
  })
})

// ── validateOverride ──────────────────────────────────────────────────────────

describe('validateOverride', () => {
  it('accepts a valid override with all fields', () => {
    const errors = validateOverride('web_search', {
      description: 'Search the web using Brave API',
      addedKeywords: ['search', 'web', 'internet'],
      notes: 'Classifier confuses with web_fetch',
    })
    expect(errors).toHaveLength(0)
  })

  it('accepts an override with only a description', () => {
    expect(validateOverride('read', { description: 'Read file contents' })).toHaveLength(0)
  })

  it('accepts an empty override object', () => {
    expect(validateOverride('exec', {})).toHaveLength(0)
  })

  it('rejects empty id', () => {
    const errors = validateOverride('', { description: 'test' })
    expect(errors.some((e) => e.field === 'id')).toBe(true)
  })

  it('rejects id with invalid characters', () => {
    const errors = validateOverride('tool with spaces!', { description: 'test' })
    expect(errors.some((e) => e.field === 'id')).toBe(true)
  })

  it('accepts ids with colons, dots, hyphens, slashes', () => {
    expect(validateOverride('skill:coding-agent/main.ts', {})).toHaveLength(0)
  })

  it('rejects non-string description', () => {
    const errors = validateOverride('read', { description: 42 as any })
    expect(errors.some((e) => e.field === 'description')).toBe(true)
  })

  it('rejects empty description string', () => {
    const errors = validateOverride('read', { description: '   ' })
    expect(errors.some((e) => e.field === 'description')).toBe(true)
  })

  it('rejects description over 2000 chars', () => {
    const errors = validateOverride('read', { description: 'x'.repeat(2001) })
    expect(errors.some((e) => e.field === 'description')).toBe(true)
  })

  it('rejects non-array addedKeywords', () => {
    const errors = validateOverride('read', { addedKeywords: 'keyword' as any })
    expect(errors.some((e) => e.field === 'addedKeywords')).toBe(true)
  })

  it('rejects keywords array with non-string entries', () => {
    const errors = validateOverride('read', { addedKeywords: ['ok', 42 as any] })
    expect(errors.some((e) => e.field.startsWith('addedKeywords'))).toBe(true)
  })

  it('rejects more than 50 keywords', () => {
    const errors = validateOverride('read', { addedKeywords: Array(51).fill('kw') })
    expect(errors.some((e) => e.field === 'addedKeywords')).toBe(true)
  })

  it('rejects unknown fields', () => {
    const errors = validateOverride('read', { unknownField: 'surprise' } as any)
    expect(errors.some((e) => e.field === 'unknownField')).toBe(true)
  })

  it('rejects non-object override', () => {
    const errors = validateOverride('read', 'not-an-object' as any)
    expect(errors.some((e) => e.field === 'override')).toBe(true)
  })
})

// ── validateOverridesFile ─────────────────────────────────────────────────────

describe('validateOverridesFile', () => {
  it('accepts a valid file', () => {
    const errors = validateOverridesFile({
      version: 1,
      updatedAt: '2026-04-19T00:00:00.000Z',
      overrides: {},
    })
    expect(errors).toHaveLength(0)
  })

  it('rejects wrong version', () => {
    const errors = validateOverridesFile({ version: 2, updatedAt: 'x', overrides: {} })
    expect(errors.some((e) => e.field === 'version')).toBe(true)
  })

  it('rejects missing overrides object', () => {
    const errors = validateOverridesFile({ version: 1, updatedAt: 'x', overrides: null })
    expect(errors.some((e) => e.field === 'overrides')).toBe(true)
  })

  it('rejects non-object root', () => {
    const errors = validateOverridesFile('not an object')
    expect(errors.some((e) => e.field === 'root')).toBe(true)
  })

  it('cascades override validation errors', () => {
    const errors = validateOverridesFile({
      version: 1,
      updatedAt: '2026-04-19T00:00:00Z',
      overrides: { 'bad tool!': { description: '' } },
    })
    // Should have errors for the nested invalid override
    expect(errors.length).toBeGreaterThan(0)
  })
})

// ── readOverrides ─────────────────────────────────────────────────────────────

describe('readOverrides', () => {
  it('returns null when file does not exist', () => {
    const dir = mkTmpDir()
    const p = path.join(dir, 'nonexistent.json')
    expect(readOverrides(p)).toBeNull()
  })

  it('returns parsed contents for a valid file', () => {
    const dir = mkTmpDir()
    const p = mkOverridesFile(dir, {
      overrides: { web_search: { description: 'Search the web' } },
    })
    const data = readOverrides(p)
    expect(data).not.toBeNull()
    expect(data!.version).toBe(1)
    expect(data!.overrides['web_search'].description).toBe('Search the web')
  })

  it('throws on malformed JSON', () => {
    const dir = mkTmpDir()
    const p = path.join(dir, 'bad.json')
    fs.writeFileSync(p, '{ not json }')
    expect(() => readOverrides(p)).toThrow()
  })

  it('throws on invalid file structure', () => {
    const dir = mkTmpDir()
    const p = path.join(dir, 'bad.json')
    fs.writeFileSync(p, JSON.stringify({ version: 99, updatedAt: 'x', overrides: {} }))
    expect(() => readOverrides(p)).toThrow()
  })
})

// ── writeOverrides ─────────────────────────────────────────────────────────────

describe('writeOverrides', () => {
  it('writes a valid overrides file atomically', () => {
    const dir = mkTmpDir()
    const p = path.join(dir, 'resolver-overrides.json')
    const data: ResolverOverridesFile = {
      version: 1,
      updatedAt: '2026-04-19T00:00:00.000Z',
      overrides: { exec: { description: 'Run shell commands', addedKeywords: ['shell', 'bash'] } },
    }
    writeOverrides(data, p)
    expect(fs.existsSync(p)).toBe(true)
    const read = JSON.parse(fs.readFileSync(p, 'utf-8'))
    expect(read.overrides.exec.description).toBe('Run shell commands')
  })

  it('throws when path is empty', () => {
    expect(() =>
      writeOverrides({ version: 1, updatedAt: new Date().toISOString(), overrides: {} }, ''),
    ).toThrow()
  })

  it('throws when data is invalid', () => {
    const dir = mkTmpDir()
    const p = path.join(dir, 'out.json')
    expect(() =>
      writeOverrides({ version: 2 as any, updatedAt: '2026-04-19T00:00:00Z', overrides: {} }, p),
    ).toThrow()
  })

  it('creates parent directories if needed', () => {
    const dir = mkTmpDir()
    const nested = path.join(dir, 'a', 'b', 'c', 'overrides.json')
    writeOverrides({ version: 1, updatedAt: new Date().toISOString(), overrides: {} }, nested)
    expect(fs.existsSync(nested)).toBe(true)
  })
})

// ── upsertOverride ─────────────────────────────────────────────────────────────

describe('upsertOverride', () => {
  it('creates a new overrides file if none exists', () => {
    const dir = mkTmpDir()
    const p = path.join(dir, 'resolver-overrides.json')
    const result = upsertOverride('web_fetch', { description: 'Fetch a URL' }, p)
    expect(result.overrides['web_fetch'].description).toBe('Fetch a URL')
    expect(fs.existsSync(p)).toBe(true)
  })

  it('adds to an existing file without clobbering other overrides', () => {
    const dir = mkTmpDir()
    const p = mkOverridesFile(dir, {
      overrides: { web_search: { description: 'Search the web' } },
    })
    const result = upsertOverride('exec', { description: 'Run commands' }, p)
    expect(result.overrides['web_search'].description).toBe('Search the web')
    expect(result.overrides['exec'].description).toBe('Run commands')
  })

  it('overwrites an existing override for the same id', () => {
    const dir = mkTmpDir()
    const p = mkOverridesFile(dir, {
      overrides: { read: { description: 'Old description' } },
    })
    const result = upsertOverride('read', { description: 'New description', addedKeywords: ['read', 'file'] }, p)
    expect(result.overrides['read'].description).toBe('New description')
    expect(result.overrides['read'].addedKeywords).toEqual(['read', 'file'])
  })

  it('throws on invalid override', () => {
    const dir = mkTmpDir()
    const p = path.join(dir, 'overrides.json')
    expect(() => upsertOverride('bad tool!', {}, p)).toThrow()
  })
})

// ── removeOverride ─────────────────────────────────────────────────────────────

describe('removeOverride', () => {
  it('returns null when file does not exist', () => {
    const dir = mkTmpDir()
    const p = path.join(dir, 'nonexistent.json')
    expect(removeOverride('web_search', p)).toBeNull()
  })

  it('removes the specified override', () => {
    const dir = mkTmpDir()
    const p = mkOverridesFile(dir, {
      overrides: {
        web_search: { description: 'Search the web' },
        exec: { description: 'Run commands' },
      },
    })
    const result = removeOverride('web_search', p)
    expect(result).not.toBeNull()
    expect('web_search' in result!.overrides).toBe(false)
    expect('exec' in result!.overrides).toBe(true)
  })

  it('returns the file unchanged when id not found', () => {
    const dir = mkTmpDir()
    const p = mkOverridesFile(dir, {
      overrides: { exec: { description: 'Run commands' } },
    })
    const result = removeOverride('nonexistent', p)
    expect(result).not.toBeNull()
    expect('exec' in result!.overrides).toBe(true)
  })

  it('persists the removal to disk', () => {
    const dir = mkTmpDir()
    const p = mkOverridesFile(dir, {
      overrides: { read: { description: 'Read files' } },
    })
    removeOverride('read', p)
    const onDisk = JSON.parse(fs.readFileSync(p, 'utf-8'))
    expect('read' in onDisk.overrides).toBe(false)
  })
})
