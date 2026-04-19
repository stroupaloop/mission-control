import { describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Mock drift alerts to avoid calling the openclaw gateway during tests
vi.mock('../drift-alerts', () => ({
  sendDriftAlert: vi.fn(async () => undefined),
  formatDriftAlertMessage: vi.fn(() => 'mocked'),
}))

import {
  extractWeekStartFromFilename,
  extractDollarsSaved,
  extractTokensSaved,
  extractMustIncludeRecall,
  extractTopMissTools,
  parseWeeklyMarkdown,
  ingestWeeklyResolverMetrics,
} from '../weekly-ingest'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'weekly-2026-04-19.md')

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-weekly-test-'))
}

function mkDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE IF NOT EXISTS resolver_weekly_metrics (
      week_start DATE PRIMARY KEY,
      must_include_recall_curated REAL,
      must_include_recall_live REAL,
      drift_delta_pp REAL,
      flagged_drift BOOL NOT NULL DEFAULT 0,
      top_miss_tools TEXT,
      auto_proposed_overrides TEXT,
      tokens_saved_total INTEGER,
      dollars_saved_total REAL,
      ingested_at TEXT NOT NULL DEFAULT (datetime('now')),
      source_file TEXT
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS resolver_drift_alerts_sent (
      week_start DATE PRIMARY KEY,
      sent_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  return db
}

// ---------------------------------------------------------------------------
// Unit tests — parsing helpers
// ---------------------------------------------------------------------------

describe('extractWeekStartFromFilename', () => {
  it('extracts date from valid filename', () => {
    expect(extractWeekStartFromFilename('weekly-2026-04-19.md')).toBe('2026-04-19')
  })
  it('extracts date from absolute path', () => {
    expect(extractWeekStartFromFilename('/some/path/weekly-2026-01-01.md')).toBe('2026-01-01')
  })
  it('returns null for non-weekly files', () => {
    expect(extractWeekStartFromFilename('2026-04-19.md')).toBeNull()
    expect(extractWeekStartFromFilename('weekly.md')).toBeNull()
  })
})

describe('extractDollarsSaved', () => {
  it('extracts dollar amount from cumulative line', () => {
    const content = '| **Cumulative (2 days)** | 2 days | 52 runs | 6,800 | ~$1.76 |'
    expect(extractDollarsSaved(content)).toBeCloseTo(1.76)
  })

  it('extracts from daily rate as weekly projection', () => {
    const content = 'Token savings: ~$0.88/day'
    const result = extractDollarsSaved(content)
    expect(result).toBeCloseTo(0.88 * 7, 0)
  })

  it('returns 0 when nothing found', () => {
    expect(extractDollarsSaved('No savings data here')).toBe(0)
  })
})

describe('extractTokensSaved', () => {
  it('returns 0 for content without token data', () => {
    expect(extractTokensSaved('No token data')).toBe(0)
  })

  it('extracts tokens freed from content', () => {
    const content = 'Daily context freed: 176,800 tokens freed daily'
    expect(extractTokensSaved(content)).toBeGreaterThan(0)
  })
})

describe('extractMustIncludeRecall', () => {
  it('extracts accuracy from must_include_accuracy pattern', () => {
    const content = 'must_include_accuracy: 0.991'
    const { curated } = extractMustIncludeRecall(content)
    expect(curated).toBeCloseTo(0.991)
  })

  it('extracts from percentage pattern', () => {
    const content = 'accuracy: 98.5%'
    const { live } = extractMustIncludeRecall(content)
    expect(live).toBeCloseTo(0.985)
  })

  it('returns nulls when nothing found', () => {
    const { curated, live } = extractMustIncludeRecall('No accuracy data')
    expect(curated).toBeNull()
    expect(live).toBeNull()
  })
})

describe('extractTopMissTools', () => {
  it('returns empty array when no tool misses', () => {
    expect(extractTopMissTools('No tool data')).toEqual([])
  })

  it('extracts tools from miss-context lines', () => {
    const content = [
      '| Tool starvation cases | 0 | 0% | ✅ NONE |',
      'error: web_fetch timed out — miss detected',
      'web_search miss in research task',
    ].join('\n')
    const tools = extractTopMissTools(content)
    expect(Array.isArray(tools)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// parseWeeklyMarkdown — integration with actual fixture
// ---------------------------------------------------------------------------

describe('parseWeeklyMarkdown with actual fixture', () => {
  it('parses real weekly report correctly', () => {
    const content = fs.readFileSync(FIXTURE_PATH, 'utf-8')
    const row = parseWeeklyMarkdown(FIXTURE_PATH, content)
    expect(row).not.toBeNull()
    expect(row!.week_start).toBe('2026-04-19')
    expect(typeof row!.dollars_saved_total).toBe('number')
    expect(Array.isArray(row!.top_miss_tools)).toBe(true)
    expect(Array.isArray(row!.auto_proposed_overrides)).toBe(true)
    expect(row!.source_file).toBe(FIXTURE_PATH)
  })

  it('returns null for file with no parseable date', () => {
    const row = parseWeeklyMarkdown('/tmp/nodate.md', 'No dates here')
    expect(row).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Drift detection
// ---------------------------------------------------------------------------

describe('drift detection', () => {
  it('does NOT flag drift when delta ≤ 3pp', () => {
    const db = mkDb()
    db.prepare(`INSERT INTO resolver_weekly_metrics
      (week_start, must_include_recall_live, drift_delta_pp, flagged_drift)
      VALUES ('2026-04-12', 0.85, 0, 0)`).run()

    const tmpDir = mkTmpDir()
    const filePath = path.join(tmpDir, 'weekly-2026-04-19.md')
    fs.writeFileSync(filePath, `# Weekly\n**Report Date:** Sunday, April 19, 2026\nmust_include_accuracy: 0.823\n~$1.76/day\n`)

    const result = ingestWeeklyResolverMetrics({ db, auditDir: tmpDir })
    expect(result.weeksIngested).toBe(1)
    expect(result.driftAlertsFired).toBe(0)

    const row: any = db.prepare('SELECT * FROM resolver_weekly_metrics WHERE week_start = ?').get('2026-04-19')
    expect(row.flagged_drift).toBe(0)
    expect(Math.abs(row.drift_delta_pp)).toBeLessThanOrEqual(3)
  })

  it('flags drift when delta > 3pp', () => {
    const db = mkDb()
    db.prepare(`INSERT INTO resolver_weekly_metrics
      (week_start, must_include_recall_live, drift_delta_pp, flagged_drift)
      VALUES ('2026-04-12', 0.95, 0, 0)`).run()

    const tmpDir = mkTmpDir()
    const filePath = path.join(tmpDir, 'weekly-2026-04-19.md')
    fs.writeFileSync(filePath, `# Weekly\n**Report Date:** Sunday, April 19, 2026\nmust_include_accuracy: 0.90\n~$1.76/day\n`)

    ingestWeeklyResolverMetrics({ db, auditDir: tmpDir })

    const row: any = db.prepare('SELECT * FROM resolver_weekly_metrics WHERE week_start = ?').get('2026-04-19')
    expect(row.flagged_drift).toBe(1)
    expect(Math.abs(row.drift_delta_pp)).toBeGreaterThan(3)
  })

  it('does NOT flag drift exactly at 3pp boundary', () => {
    const db = mkDb()
    db.prepare(`INSERT INTO resolver_weekly_metrics
      (week_start, must_include_recall_live, drift_delta_pp, flagged_drift)
      VALUES ('2026-04-12', 0.95, 0, 0)`).run()

    const tmpDir = mkTmpDir()
    const filePath = path.join(tmpDir, 'weekly-2026-04-19.md')
    fs.writeFileSync(filePath, `# Weekly\n**Report Date:** Sunday, April 19, 2026\nmust_include_accuracy: 0.92\n~$1.76/day\n`)

    ingestWeeklyResolverMetrics({ db, auditDir: tmpDir })

    const row: any = db.prepare('SELECT * FROM resolver_weekly_metrics WHERE week_start = ?').get('2026-04-19')
    expect(row.flagged_drift).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe('empty state handling', () => {
  it('returns zero counts when no files exist', () => {
    const tmpDir = mkTmpDir()
    const result = ingestWeeklyResolverMetrics({ db: mkDb(), auditDir: tmpDir })
    expect(result.weeksIngested).toBe(0)
    expect(result.driftAlertsFired).toBe(0)
    expect(result.errors).toBe(0)
  })

  it('returns zero counts when auditDir is empty string', () => {
    const result = ingestWeeklyResolverMetrics({ db: mkDb(), auditDir: '' })
    expect(result.weeksIngested).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Upsert / idempotency
// ---------------------------------------------------------------------------

describe('upsert idempotency', () => {
  it('re-ingesting same file does not duplicate rows', () => {
    const db = mkDb()
    const tmpDir = mkTmpDir()
    const filePath = path.join(tmpDir, 'weekly-2026-04-19.md')
    fs.writeFileSync(filePath, `# Weekly\n**Report Date:** Sunday, April 19, 2026\n~$1.76/day\n`)

    ingestWeeklyResolverMetrics({ db, auditDir: tmpDir })
    ingestWeeklyResolverMetrics({ db, auditDir: tmpDir })

    const count: any = db.prepare('SELECT COUNT(*) AS c FROM resolver_weekly_metrics').get()
    expect(count.c).toBe(1)
  })
})
