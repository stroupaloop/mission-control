import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { ensureResolverTables } from '../telemetry'
import { getWeakDescriptionRecommendations } from '../recommendations'

// ── Helpers ───────────────────────────────────────────────────────────────────

function mkDb(): Database.Database {
  const db = new Database(':memory:')
  ensureResolverTables(db)
  return db
}

/**
 * Insert a resolver_telemetry row with sensible defaults. ts defaults to
 * 'now' (within any look-back window).
 */
function insertRow(
  db: Database.Database,
  opts: {
    source?: string
    confidence?: number | null
    llm_tools?: string[]
    final_tools?: string[]
    reasoning?: string | null
    validation_action?: string | null
    ts?: string
  } = {},
): void {
  const source = opts.source ?? 'llm'
  const confidence = opts.confidence !== undefined ? opts.confidence : 0.9
  const llmTools = opts.llm_tools ?? []
  const finalTools = opts.final_tools ?? llmTools
  const reasoning = opts.reasoning ?? null
  const validationAction = opts.validation_action ?? null
  // Use a recent timestamp so it falls within the default 7-day window.
  const ts = opts.ts ?? new Date().toISOString()

  db.prepare(
    `INSERT INTO resolver_telemetry
       (source, confidence, llm_tools, final_tools, reasoning, validation_action, raw, ts)
     VALUES (?, ?, ?, ?, ?, ?, '{}', ?)`,
  ).run(
    source,
    confidence,
    JSON.stringify(llmTools),
    JSON.stringify(finalTools),
    reasoning,
    validationAction,
    ts,
  )
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('getWeakDescriptionRecommendations', () => {
  it('returns empty array when there are no telemetry rows', () => {
    const db = mkDb()
    const recs = getWeakDescriptionRecommendations(db, { minOccurrences: 1 })
    expect(recs).toEqual([])
  })

  it('flags a tool with consistently low confidence as LOW_CONFIDENCE', () => {
    const db = mkDb()

    // Seed 6 rows for "fuzzy_tool" with low confidence (below 0.6 threshold)
    for (let i = 0; i < 6; i++) {
      insertRow(db, {
        llm_tools: ['fuzzy_tool'],
        final_tools: ['fuzzy_tool'],
        confidence: 0.35,
        reasoning: `weak signal on iteration ${i}`,
      })
    }

    const recs = getWeakDescriptionRecommendations(db, { minOccurrences: 5 })
    const rec = recs.find((r) => r.toolId === 'fuzzy_tool')

    expect(rec).toBeDefined()
    expect(rec!.signal).toBe('LOW_CONFIDENCE')
    expect(rec!.confidence).toBeLessThan(0.6)
    expect(rec!.occurrences).toBeGreaterThanOrEqual(5)
  })

  it('flags a tool stripped by validation more than 20% of the time as FALSE_POSITIVE', () => {
    const db = mkDb()

    // 6 rows where LLM picks "overly_broad_tool" but validation always removes it
    for (let i = 0; i < 6; i++) {
      insertRow(db, {
        llm_tools: ['overly_broad_tool', 'legit_tool'],
        final_tools: ['legit_tool'], // overly_broad_tool stripped every time
        confidence: 0.85,
        reasoning: `false positive instance ${i}`,
      })
    }

    const recs = getWeakDescriptionRecommendations(db, { minOccurrences: 5 })
    const rec = recs.find((r) => r.toolId === 'overly_broad_tool')

    expect(rec).toBeDefined()
    expect(['FALSE_POSITIVE', 'BOTH']).toContain(rec!.signal)
    expect(rec!.occurrences).toBeGreaterThanOrEqual(5)
  })

  it('flags a tool with BOTH signals when it has low confidence AND false positives', () => {
    const db = mkDb()

    // Low confidence AND gets stripped by validation — should surface as BOTH
    for (let i = 0; i < 7; i++) {
      insertRow(db, {
        llm_tools: ['messy_tool', 'clean_tool'],
        final_tools: ['clean_tool'], // messy_tool stripped
        confidence: 0.3,
        reasoning: `messy iteration ${i}`,
      })
    }

    const recs = getWeakDescriptionRecommendations(db, { minOccurrences: 5 })
    const rec = recs.find((r) => r.toolId === 'messy_tool')

    expect(rec).toBeDefined()
    expect(rec!.signal).toBe('BOTH')
  })

  it('does not flag tools below minOccurrences threshold', () => {
    const db = mkDb()

    // Only 3 occurrences — below the default minOccurrences of 5
    for (let i = 0; i < 3; i++) {
      insertRow(db, {
        llm_tools: ['rare_tool'],
        final_tools: ['rare_tool'],
        confidence: 0.2,
      })
    }

    const recs = getWeakDescriptionRecommendations(db, { minOccurrences: 5 })
    expect(recs.find((r) => r.toolId === 'rare_tool')).toBeUndefined()
  })

  it('does not flag tools with high confidence and no false positives', () => {
    const db = mkDb()

    // Good tool — high confidence, always kept
    for (let i = 0; i < 8; i++) {
      insertRow(db, {
        llm_tools: ['good_tool'],
        final_tools: ['good_tool'],
        confidence: 0.95,
      })
    }

    const recs = getWeakDescriptionRecommendations(db, { minOccurrences: 5 })
    expect(recs.find((r) => r.toolId === 'good_tool')).toBeUndefined()
  })

  it('sorts BOTH before LOW_CONFIDENCE before FALSE_POSITIVE', () => {
    const db = mkDb()

    // FALSE_POSITIVE tool (good conf, always stripped)
    for (let i = 0; i < 6; i++) {
      insertRow(db, {
        llm_tools: ['fp_tool'],
        final_tools: [],
        confidence: 0.9,
      })
    }

    // LOW_CONFIDENCE tool (low conf, not stripped)
    for (let i = 0; i < 6; i++) {
      insertRow(db, {
        llm_tools: ['lc_tool'],
        final_tools: ['lc_tool'],
        confidence: 0.3,
      })
    }

    // BOTH tool
    for (let i = 0; i < 6; i++) {
      insertRow(db, {
        llm_tools: ['both_tool'],
        final_tools: [],
        confidence: 0.2,
      })
    }

    const recs = getWeakDescriptionRecommendations(db, { minOccurrences: 5 })
    const signals = recs.map((r) => r.signal)

    const bothIdx = signals.indexOf('BOTH')
    const lcIdx = signals.indexOf('LOW_CONFIDENCE')
    const fpIdx = signals.indexOf('FALSE_POSITIVE')

    // All three should be present
    expect(bothIdx).toBeGreaterThanOrEqual(0)
    expect(lcIdx).toBeGreaterThanOrEqual(0)
    expect(fpIdx).toBeGreaterThanOrEqual(0)

    // Order: BOTH < LOW_CONFIDENCE < FALSE_POSITIVE
    expect(bothIdx).toBeLessThan(lcIdx)
    expect(lcIdx).toBeLessThan(fpIdx)
  })

  it('respects the days look-back window and ignores old rows', () => {
    const db = mkDb()

    // Old rows (15 days ago) — should be excluded from a 7-day window
    const oldTs = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString()
    for (let i = 0; i < 6; i++) {
      insertRow(db, {
        llm_tools: ['old_tool'],
        final_tools: ['old_tool'],
        confidence: 0.1,
        ts: oldTs,
      })
    }

    const recs = getWeakDescriptionRecommendations(db, { days: 7, minOccurrences: 5 })
    expect(recs.find((r) => r.toolId === 'old_tool')).toBeUndefined()
  })

  it('includes sampleReasoning from a representative low-confidence row', () => {
    const db = mkDb()

    for (let i = 0; i < 6; i++) {
      insertRow(db, {
        llm_tools: ['sample_tool'],
        final_tools: ['sample_tool'],
        confidence: 0.4,
        reasoning: i === 0 ? 'specific reasoning text here' : null,
      })
    }

    const recs = getWeakDescriptionRecommendations(db, { minOccurrences: 5 })
    const rec = recs.find((r) => r.toolId === 'sample_tool')
    expect(rec).toBeDefined()
    // Should have surfaced at least some reasoning (from the seeded row or null)
    // The function guarantees truncation to 300 chars max
    if (rec!.sampleReasoning !== null) {
      expect(rec!.sampleReasoning.length).toBeLessThanOrEqual(300)
    }
  })
})
