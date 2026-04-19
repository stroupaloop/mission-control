import { describe, expect, it, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ensureResolverTables,
  ingestResolverTelemetry,
  parseJsonlChunk,
  rebuildResolverDailyMetrics,
} from '../telemetry'

function mkTmpFile(contents = ''): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-telemetry-'))
  const file = path.join(dir, 'resolver-telemetry.jsonl')
  fs.writeFileSync(file, contents)
  return file
}

function mkDb(): Database.Database {
  const db = new Database(':memory:')
  ensureResolverTables(db)
  // litellm_usage is needed by the metrics rollup join
  db.exec(`
    CREATE TABLE IF NOT EXISTS litellm_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prompt_tokens INTEGER,
      response_cost REAL,
      created_at INTEGER DEFAULT (unixepoch())
    )
  `)
  return db
}

function enderPayload() {
  return {
    turn: 44,
    toolsAllow: [
      'read', 'write', 'edit', 'exec', 'process',
      'memory_search', 'memory_add', 'session_status', 'web_search', 'web_fetch',
    ],
    availableTools: Array.from({ length: 24 }, (_, i) => `tool_${i}`),
    source: 'llm',
    confidence: 0.93,
    reasoning: 'Need inspect GitHub issue and related context',
    llmLatencyMs: 648,
    llmTools: ['web_search', 'web_fetch'],
    finalTools: ['web_search', 'web_fetch'],
    ts: '2026-04-18T22:00:00.000Z',
  }
}

describe('parseJsonlChunk', () => {
  it('parses well-formed JSONL', () => {
    const chunk = `${JSON.stringify({ turn: 1 })}\n${JSON.stringify({ turn: 2 })}\n`
    const { entries, bytesConsumed, malformed } = parseJsonlChunk(chunk)
    expect(entries).toHaveLength(2)
    expect(entries[0].turn).toBe(1)
    expect(entries[1].turn).toBe(2)
    expect(bytesConsumed).toBe(Buffer.byteLength(chunk, 'utf-8'))
    expect(malformed).toBe(0)
  })

  it('defers partial trailing line — does not consume its bytes', () => {
    const complete = `${JSON.stringify({ turn: 1 })}\n`
    const partial = `{"turn": 2, "partial":`
    const { entries, bytesConsumed } = parseJsonlChunk(complete + partial)
    expect(entries).toHaveLength(1)
    expect(bytesConsumed).toBe(Buffer.byteLength(complete, 'utf-8'))
  })

  it('counts malformed lines without aborting ingest', () => {
    const chunk = `${JSON.stringify({ turn: 1 })}\nnot-json\n${JSON.stringify({ turn: 3 })}\n`
    const { entries, malformed } = parseJsonlChunk(chunk)
    expect(entries).toHaveLength(2)
    expect(malformed).toBe(1)
  })

  it('handles empty input', () => {
    expect(parseJsonlChunk('')).toEqual({ entries: [], bytesConsumed: 0, malformed: 0 })
  })
})

describe('ingestResolverTelemetry', () => {
  let db: Database.Database
  beforeEach(() => { db = mkDb() })

  it('ingests new lines and advances the cursor', () => {
    const file = mkTmpFile(`${JSON.stringify(enderPayload())}\n`)
    const result = ingestResolverTelemetry({ db, filePath: file })
    expect(result.linesRead).toBe(1)
    expect(result.linesInserted).toBe(1)
    expect(result.endOffset).toBeGreaterThan(0)

    const row = db.prepare('SELECT source, confidence, turn FROM resolver_telemetry').get() as any
    expect(row.source).toBe('llm')
    expect(row.confidence).toBeCloseTo(0.93, 2)
    expect(row.turn).toBe(44)
  })

  it('is idempotent when run back-to-back with no new lines', () => {
    const file = mkTmpFile(`${JSON.stringify(enderPayload())}\n`)
    ingestResolverTelemetry({ db, filePath: file })
    const second = ingestResolverTelemetry({ db, filePath: file })
    expect(second.linesInserted).toBe(0)
    const count = (db.prepare('SELECT COUNT(*) AS c FROM resolver_telemetry').get() as any).c
    expect(count).toBe(1)
  })

  it('picks up appended lines without re-reading earlier content', () => {
    const file = mkTmpFile(`${JSON.stringify(enderPayload())}\n`)
    ingestResolverTelemetry({ db, filePath: file })
    fs.appendFileSync(file, `${JSON.stringify({ ...enderPayload(), turn: 45 })}\n`)
    const second = ingestResolverTelemetry({ db, filePath: file })
    expect(second.linesInserted).toBe(1)
    const count = (db.prepare('SELECT COUNT(*) AS c FROM resolver_telemetry').get() as any).c
    expect(count).toBe(2)
  })

  it('detects rotation when file shrinks and resumes from offset 0', () => {
    const file = mkTmpFile(`${JSON.stringify(enderPayload())}\n${JSON.stringify({ ...enderPayload(), turn: 45 })}\n`)
    ingestResolverTelemetry({ db, filePath: file })
    // Rotation: truncate + write a single new line
    fs.writeFileSync(file, `${JSON.stringify({ ...enderPayload(), turn: 99 })}\n`)
    const rotated = ingestResolverTelemetry({ db, filePath: file })
    expect(rotated.rotated).toBe(true)
    expect(rotated.linesInserted).toBe(1)
  })

  it('is a no-op when the file does not exist', () => {
    const result = ingestResolverTelemetry({ db, filePath: '/tmp/does-not-exist-xyz.jsonl' })
    expect(result.linesInserted).toBe(0)
    expect(result.linesRead).toBe(0)
  })

  it('is a no-op when filePath is empty', () => {
    const result = ingestResolverTelemetry({ db, filePath: '' })
    expect(result.linesInserted).toBe(0)
  })

  it('persists raw payload for future replay/debugging', () => {
    const file = mkTmpFile(`${JSON.stringify(enderPayload())}\n`)
    ingestResolverTelemetry({ db, filePath: file })
    const raw = (db.prepare('SELECT raw FROM resolver_telemetry').get() as any).raw
    const parsed = JSON.parse(raw)
    expect(parsed.reasoning).toMatch(/GitHub/)
  })

  it('swallows a single malformed line mid-file without crashing', () => {
    const file = mkTmpFile(
      `${JSON.stringify(enderPayload())}\nnot-json\n${JSON.stringify({ ...enderPayload(), turn: 46 })}\n`,
    )
    const result = ingestResolverTelemetry({ db, filePath: file })
    expect(result.linesInserted).toBe(2)
    expect(result.errors).toBe(1)
  })
})

describe('rebuildResolverDailyMetrics', () => {
  it('aggregates daily classifications + tools_narrowed', () => {
    const db = mkDb()
    const payload = enderPayload()
    db.prepare(
      `INSERT INTO resolver_telemetry (turn, source, confidence, llm_latency_ms,
          tools_allow, available_tools, raw, ts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`,
    ).run(
      payload.turn, payload.source, payload.confidence, payload.llmLatencyMs,
      JSON.stringify(payload.toolsAllow), JSON.stringify(payload.availableTools),
      JSON.stringify(payload), payload.ts,
    )

    const { days } = rebuildResolverDailyMetrics({ db, days: 30 })
    expect(days).toBe(1)

    const row = db.prepare(`SELECT classifications, tools_narrowed, tokens_saved_est
                            FROM resolver_metrics_daily`).get() as any
    expect(row.classifications).toBe(1)
    // available (24) − allowed (10) = 14 tools narrowed
    expect(row.tools_narrowed).toBe(14)
    // 14 tools × 150 tokens = 2100 tokens saved (plugin rule-of-thumb)
    expect(row.tokens_saved_est).toBe(2100)
  })
})
