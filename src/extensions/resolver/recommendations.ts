/**
 * Resolver Weak-Description Recommendations
 *
 * Analyzes resolver_telemetry to surface tools/skills whose descriptions are
 * likely causing classifier confusion, based on telemetry heuristics.
 *
 * Heuristic signals (v1):
 *   1. LOW_CONFIDENCE  — avg confidence < 0.6 when this tool appears in llm_tools or final_tools
 *   2. FALSE_POSITIVE  — LLM selected this tool but validation stripped it (llmExtra)
 *      Indicates the description is triggering false matches.
 *
 * What's explicitly out of scope for v1:
 *   - "Never picked despite relevance" — too noisy without semantic similarity scoring
 *   - Cross-session clustering — requires embeddings or LLM-assisted grouping
 *
 * Returns recommendations sorted by signal severity (worst first).
 */

import { getDatabase } from '@/lib/db'

export type WeakDescriptionSignal = 'LOW_CONFIDENCE' | 'FALSE_POSITIVE' | 'BOTH'

export interface WeakDescriptionRecommendation {
  toolId: string
  signal: WeakDescriptionSignal
  /** Average confidence when this tool was in llm_tools or final_tools */
  confidence: number | null
  /** How many telemetry rows this tool appeared in over the window */
  occurrences: number
  /** Sample reasoning string from a recent low-confidence or false-positive row */
  sampleReasoning: string | null
  /** Human-readable suggested action */
  suggestedAction: string
}

export interface RecommendationOptions {
  days?: number
  minOccurrences?: number
}

/**
 * Extract distinct tool IDs from a JSON array column in a row.
 * Returns an empty array on any parse error.
 */
function parseToolArray(jsonStr: string | null): string[] {
  if (!jsonStr) return []
  try {
    const parsed = JSON.parse(jsonStr)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((t) => typeof t === 'string')
  } catch {
    return []
  }
}

/**
 * Return weak-description recommendations derived from resolver_telemetry.
 *
 * @param db - Better-sqlite3 database (or compatible). Defaults to the MC singleton.
 * @param options.days - Look-back window in days (default 7).
 * @param options.minOccurrences - Minimum appearances before a tool is flagged (default 5).
 */
export function getWeakDescriptionRecommendations(
  db?: ReturnType<typeof getDatabase>,
  options: RecommendationOptions = {},
): WeakDescriptionRecommendation[] {
  const resolvedDb = db ?? getDatabase()
  const days = Math.max(1, Math.floor(options.days ?? 7))
  const minOccurrences = Math.max(1, Math.floor(options.minOccurrences ?? 5))

  // Pull all rows within the window that have LLM-sourced decisions
  const rows = resolvedDb
    .prepare(
      `SELECT
         id,
         llm_tools,
         final_tools,
         confidence,
         reasoning,
         validation_action,
         ts
       FROM resolver_telemetry
       WHERE source = 'llm'
         AND ts >= datetime('now', '-' || ? || ' days')
       ORDER BY ts DESC`,
    )
    .all(days) as Array<{
      id: number
      llm_tools: string | null
      final_tools: string | null
      confidence: number | null
      reasoning: string | null
      validation_action: string | null
      ts: string | null
    }>

  // Aggregate per tool
  const toolStats = new Map<
    string,
    {
      confidences: number[]
      falsePositiveCount: number
      occurrences: number
      sampleReasoning: string | null
      sampleLowConfReasoning: string | null
      sampleFPReasoning: string | null
    }
  >()

  for (const row of rows) {
    const llmTools = parseToolArray(row.llm_tools)
    const finalTools = parseToolArray(row.final_tools)

    // Tools LLM picked but were NOT in final (false positives — stripped by validation)
    const llmToolSet = new Set(llmTools)
    const finalToolSet = new Set(finalTools)
    const falsePositives = llmTools.filter((t) => !finalToolSet.has(t))

    // All tools in this decision (union of llm + final)
    const allDecisionTools = new Set([...llmTools, ...finalTools])

    for (const tool of allDecisionTools) {
      if (!toolStats.has(tool)) {
        toolStats.set(tool, {
          confidences: [],
          falsePositiveCount: 0,
          occurrences: 0,
          sampleReasoning: row.reasoning,
          sampleLowConfReasoning: null,
          sampleFPReasoning: null,
        })
      }
      const stats = toolStats.get(tool)!
      stats.occurrences++

      if (row.confidence !== null) {
        stats.confidences.push(row.confidence)
        if (row.confidence < 0.6 && !stats.sampleLowConfReasoning && row.reasoning) {
          stats.sampleLowConfReasoning = row.reasoning
        }
      }

      if (falsePositives.includes(tool)) {
        stats.falsePositiveCount++
        if (!stats.sampleFPReasoning && row.reasoning) {
          stats.sampleFPReasoning = row.reasoning
        }
      }
    }
  }

  const recommendations: WeakDescriptionRecommendation[] = []

  for (const [toolId, stats] of toolStats) {
    if (stats.occurrences < minOccurrences) continue

    const avgConf =
      stats.confidences.length > 0
        ? stats.confidences.reduce((a, b) => a + b, 0) / stats.confidences.length
        : null

    const hasLowConf = avgConf !== null && avgConf < 0.6
    // False positive rate: > 20% of appearances were stripped by validation
    const fpRate = stats.falsePositiveCount / stats.occurrences
    const hasFP = fpRate > 0.2

    if (!hasLowConf && !hasFP) continue

    let signal: WeakDescriptionSignal
    let suggestedAction: string
    let sampleReasoning: string | null

    if (hasLowConf && hasFP) {
      signal = 'BOTH'
      suggestedAction =
        'Description is both ambiguous (low confidence) and triggering false positives. ' +
        'Add a more specific description and remove misleading keywords.'
      sampleReasoning = stats.sampleLowConfReasoning ?? stats.sampleFPReasoning
    } else if (hasLowConf) {
      signal = 'LOW_CONFIDENCE'
      suggestedAction =
        `Avg confidence ${avgConf !== null ? (avgConf * 100).toFixed(0) : '?'}% — ` +
        'description may be too vague. Provide a more specific description and add distinguishing keywords.'
      sampleReasoning = stats.sampleLowConfReasoning ?? stats.sampleReasoning
    } else {
      signal = 'FALSE_POSITIVE'
      const fpPct = (fpRate * 100).toFixed(0)
      suggestedAction =
        `${fpPct}% of appearances were false positives (stripped by validation). ` +
        'Description may be over-broad. Narrow the description to reduce spurious matches.'
      sampleReasoning = stats.sampleFPReasoning ?? stats.sampleReasoning
    }

    recommendations.push({
      toolId,
      signal,
      confidence: avgConf,
      occurrences: stats.occurrences,
      sampleReasoning: sampleReasoning ? sampleReasoning.slice(0, 300) : null,
      suggestedAction,
    })
  }

  // Sort: BOTH worst → LOW_CONFIDENCE → FALSE_POSITIVE; within same signal, lowest confidence first
  const signalOrder: Record<WeakDescriptionSignal, number> = { BOTH: 0, LOW_CONFIDENCE: 1, FALSE_POSITIVE: 2 }
  recommendations.sort((a, b) => {
    const so = signalOrder[a.signal] - signalOrder[b.signal]
    if (so !== 0) return so
    // Within same signal, sort by confidence ascending (worst first), nulls last
    const ac = a.confidence ?? 1
    const bc = b.confidence ?? 1
    return ac - bc
  })

  return recommendations
}
