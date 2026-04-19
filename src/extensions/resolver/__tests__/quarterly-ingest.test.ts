import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  extractRunDateFromFilename,
  extractModelFromFilename,
  parseBenchmarkFile,
  computeF1,
  rankModels,
  ingestQuarterlyResolverMetrics,
} from '../quarterly-ingest'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURE_DIR = path.join(__dirname, 'fixtures')

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-quarterly-test-'))
}

function mkDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE IF NOT EXISTS resolver_quarterly_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_date DATE NOT NULL,
      model_id TEXT NOT NULL,
      must_include_recall REAL,
      f1_score REAL,
      latency_p50_ms REAL,
      latency_p95_ms REAL,
      cost_per_1k_calls_usd REAL,
      rank_in_run INTEGER,
      is_recommended_production BOOL NOT NULL DEFAULT 0,
      notes TEXT,
      source_file TEXT
    )
  `)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_rqm_run_model ON resolver_quarterly_metrics(run_date, model_id)`)
  db.exec(`
    CREATE TABLE IF NOT EXISTS resolver_production_model_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      effective_from DATE NOT NULL,
      effective_to DATE,
      model_id TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT 'initial',
      source_file TEXT
    )
  `)
  return db
}

function writeBenchmarkFile(dir: string, filename: string, overrides: Record<string, unknown> = {}): string {
  const defaults = {
    timestamp: '2026-04-18T00:00:00Z',
    model: 'gpt-5.4-mini',
    total_cases: 116,
    must_include_accuracy: 0.991,
    avg_recall: 0.971,
    avg_precision: 0.805,
    errors: 0,
    latency_p50: 3425,
    latency_p95: 5824,
    latency_mean: 3796,
    usage: { input_tokens: 120000, output_tokens: 4000, total_tokens: 124000, cost_usd: 0.025 },
    votes: 1,
  }
  const data = { ...defaults, ...overrides }
  const filePath = path.join(dir, filename)
  fs.writeFileSync(filePath, JSON.stringify(data))
  return filePath
}

// ---------------------------------------------------------------------------
// Unit tests — parsing helpers
// ---------------------------------------------------------------------------

describe('extractRunDateFromFilename', () => {
  it('extracts date from standard filename', () => {
    expect(extractRunDateFromFilename('2026-04-18-claude-sonnet-4-6-run1.json')).toBe('2026-04-18')
  })

  it('extracts date from absolute path', () => {
    expect(extractRunDateFromFilename('/some/path/2026-01-01-gpt-5.4-mini-run2.json')).toBe('2026-01-01')
  })

  it('returns null for non-date filenames', () => {
    expect(extractRunDateFromFilename('benchmark.json')).toBeNull()
    expect(extractRunDateFromFilename('telemetry.json')).toBeNull()
  })
})

describe('extractModelFromFilename', () => {
  it('extracts model slug from standard filename', () => {
    expect(extractModelFromFilename('2026-04-18-claude-sonnet-4-6-run1.json')).toBe('claude-sonnet-4-6')
  })

  it('extracts gpt model slug', () => {
    expect(extractModelFromFilename('2026-04-18-gpt-5-4-run1.json')).toBe('gpt-5-4')
  })

  it('handles no run suffix', () => {
    expect(extractModelFromFilename('2026-04-18-benchmark.json')).toBe('benchmark')
  })
})

describe('computeF1', () => {
  it('computes F1 correctly for balanced recall/precision', () => {
    const f1 = computeF1(0.8, 0.8)
    expect(f1).toBeCloseTo(0.8)
  })

  it('computes F1 with skewed inputs', () => {
    const f1 = computeF1(1.0, 0.5)
    expect(f1).toBeCloseTo(0.667, 2)
  })

  it('returns null when both are zero', () => {
    expect(computeF1(0, 0)).toBeNull()
  })
})

describe('rankModels', () => {
  it('ranks by must_include_accuracy desc', () => {
    const models = [
      { model: 'a', mustIncludeAccuracy: 0.95, avgRecall: 0.9 },
      { model: 'b', mustIncludeAccuracy: 0.99, avgRecall: 0.85 },
      { model: 'c', mustIncludeAccuracy: 0.97, avgRecall: 0.92 },
    ]
    const ranks = rankModels(models)
    expect(ranks.get('b')).toBe(1)
    expect(ranks.get('c')).toBe(2)
    expect(ranks.get('a')).toBe(3)
  })

  it('breaks ties by avgRecall', () => {
    const models = [
      { model: 'x', mustIncludeAccuracy: 0.99, avgRecall: 0.80 },
      { model: 'y', mustIncludeAccuracy: 0.99, avgRecall: 0.95 },
    ]
    const ranks = rankModels(models)
    expect(ranks.get('y')).toBe(1)
    expect(ranks.get('x')).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// parseBenchmarkFile
// ---------------------------------------------------------------------------

describe('parseBenchmarkFile', () => {
  it('parses a valid benchmark JSON', () => {
    const tmpDir = mkTmpDir()
    const fp = writeBenchmarkFile(tmpDir, '2026-04-18-gpt-5.4-mini-run1.json')
    const result = parseBenchmarkFile(fp)
    expect(result).not.toBeNull()
    expect(result!.model).toBe('gpt-5.4-mini')
    expect(result!.runDate).toBe('2026-04-18')
    expect(result!.mustIncludeAccuracy).toBeCloseTo(0.991)
  })

  it('parses fixture files', () => {
    const haiku = parseBenchmarkFile(path.join(FIXTURE_DIR, '2026-04-18-claude-haiku-4-5-run1.json'))
    expect(haiku).not.toBeNull()
    expect(haiku!.model).toBe('claude-haiku-4-5')
  })

  it('returns null for non-benchmark files', () => {
    const tmpDir = mkTmpDir()
    const fp = path.join(tmpDir, '2026-04-18-telemetry.json')
    fs.writeFileSync(fp, JSON.stringify({ someOtherField: true, ts: '2026-04-18' }))
    expect(parseBenchmarkFile(fp)).toBeNull()
  })

  it('returns null for files with bad JSON', () => {
    const tmpDir = mkTmpDir()
    const fp = path.join(tmpDir, '2026-04-18-bad.json')
    fs.writeFileSync(fp, 'not valid json')
    expect(parseBenchmarkFile(fp)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Incumbent upset detection
// ---------------------------------------------------------------------------

describe('incumbent upset detection', () => {
  it('creates initial production model entry on first run', () => {
    const db = mkDb()
    const tmpDir = mkTmpDir()
    writeBenchmarkFile(tmpDir, '2026-04-18-gpt-5.4-mini-run1.json', {
      model: 'gpt-5.4-mini',
      must_include_accuracy: 0.99,
    })

    const result = ingestQuarterlyResolverMetrics({ db, metricsDir: tmpDir })
    expect(result.incumbentUpsets).toBe(1)

    const history: any[] = db.prepare('SELECT * FROM resolver_production_model_history').all() as any[]
    expect(history.length).toBe(1)
    expect(history[0].model_id).toBe('gpt-5.4-mini')
    expect(history[0].reason).toBe('initial')
    expect(history[0].effective_to).toBeNull()
  })

  it('records upset when better model wins', () => {
    const db = mkDb()
    db.prepare(`INSERT INTO resolver_production_model_history
      (effective_from, effective_to, model_id, reason)
      VALUES ('2026-04-01', NULL, 'gpt-5.4-mini', 'initial')`).run()

    const tmpDir = mkTmpDir()
    writeBenchmarkFile(tmpDir, '2026-04-18-claude-haiku-4-5-run1.json', {
      model: 'claude-haiku-4-5',
      must_include_accuracy: 0.999,
    })
    writeBenchmarkFile(tmpDir, '2026-04-18-gpt-5.4-mini-run1.json', {
      model: 'gpt-5.4-mini',
      must_include_accuracy: 0.970,
    })

    const result = ingestQuarterlyResolverMetrics({ db, metricsDir: tmpDir })
    expect(result.incumbentUpsets).toBe(1)

    const history: any[] = db.prepare('SELECT * FROM resolver_production_model_history ORDER BY id').all() as any[]
    expect(history.length).toBe(2)
    expect(history[0].effective_to).toBe('2026-04-18')
    expect(history[1].model_id).toBe('claude-haiku-4-5')
    expect(history[1].reason).toBe('benchmark_upset')
  })

  it('does NOT record upset when incumbent stays on top', () => {
    const db = mkDb()
    db.prepare(`INSERT INTO resolver_production_model_history
      (effective_from, effective_to, model_id, reason)
      VALUES ('2026-04-01', NULL, 'gpt-5.4-mini', 'initial')`).run()

    const tmpDir = mkTmpDir()
    writeBenchmarkFile(tmpDir, '2026-04-18-gpt-5.4-mini-run1.json', {
      model: 'gpt-5.4-mini',
      must_include_accuracy: 0.991,
    })
    writeBenchmarkFile(tmpDir, '2026-04-18-claude-haiku-4-5-run1.json', {
      model: 'claude-haiku-4-5',
      must_include_accuracy: 0.970,
    })

    const result = ingestQuarterlyResolverMetrics({ db, metricsDir: tmpDir })
    expect(result.incumbentUpsets).toBe(0)

    const history: any[] = db.prepare('SELECT * FROM resolver_production_model_history').all() as any[]
    expect(history.length).toBe(1)
    expect(history[0].model_id).toBe('gpt-5.4-mini')
  })
})

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe('empty state handling', () => {
  it('returns zero counts when metrics dir is missing', () => {
    const result = ingestQuarterlyResolverMetrics({
      db: mkDb(),
      metricsDir: '/tmp/definitely-does-not-exist-resolver-test',
    })
    expect(result.runsIngested).toBe(0)
    expect(result.modelsIngested).toBe(0)
    expect(result.incumbentUpsets).toBe(0)
    expect(result.errors).toBe(0)
  })

  it('returns zero counts for dir with no JSON files', () => {
    const tmpDir = mkTmpDir()
    fs.writeFileSync(path.join(tmpDir, 'readme.txt'), 'no json here')
    const result = ingestQuarterlyResolverMetrics({ db: mkDb(), metricsDir: tmpDir })
    expect(result.runsIngested).toBe(0)
  })

  it('returns zero counts when metricsDir is empty string', () => {
    const result = ingestQuarterlyResolverMetrics({ db: mkDb(), metricsDir: '' })
    expect(result.runsIngested).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Upsert idempotency
// ---------------------------------------------------------------------------

describe('upsert idempotency', () => {
  it('re-ingesting same run does not duplicate rows', () => {
    const db = mkDb()
    const tmpDir = mkTmpDir()
    writeBenchmarkFile(tmpDir, '2026-04-18-gpt-5.4-mini-run1.json')

    ingestQuarterlyResolverMetrics({ db, metricsDir: tmpDir })
    ingestQuarterlyResolverMetrics({ db, metricsDir: tmpDir })

    const count: any = db.prepare('SELECT COUNT(*) AS c FROM resolver_quarterly_metrics').get()
    expect(count.c).toBe(1)
  })
})
