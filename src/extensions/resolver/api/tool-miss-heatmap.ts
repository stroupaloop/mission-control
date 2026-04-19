/**
 * GET /api/resolver/tool-miss-heatmap?days=7
 *
 * Aggregates resolver_telemetry rows over last N days, counting how often each
 * tool appears in llm_tools (selected by LLM) vs available_tools minus final_tools
 * (i.e. what was available but NOT selected — proxy for misses).
 *
 * miss = tool in available_tools AND tool NOT in final_tools (false negative)
 */

import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { logger } from '@/lib/logger'
import { ensureResolverTables } from '../telemetry'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const rawDays = Number(searchParams.get('days') ?? '7')
    const days = Number.isFinite(rawDays) ? Math.min(Math.max(Math.floor(rawDays), 1), 90) : 7

    const db = getDatabase()
    ensureResolverTables(db)

    const sinceTs = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60

    const rows = db
      .prepare(
        `SELECT available_tools, final_tools, llm_tools
         FROM resolver_telemetry
         WHERE created_at >= ?
           AND available_tools IS NOT NULL
           AND final_tools IS NOT NULL`,
      )
      .all(sinceTs) as Array<{
        available_tools: string
        final_tools: string
        llm_tools: string | null
      }>

    const missCount = new Map<string, number>()
    const selectCount = new Map<string, number>()

    for (const row of rows) {
      let available: string[] = []
      let finalTools: string[] = []
      let llmTools: string[] = []

      try { available = JSON.parse(row.available_tools) } catch { continue }
      try { finalTools = JSON.parse(row.final_tools) } catch { continue }
      try { llmTools = row.llm_tools ? JSON.parse(row.llm_tools) : [] } catch { llmTools = [] }

      const finalSet = new Set(finalTools)
      const llmSet = new Set(llmTools)

      for (const tool of available) {
        if (!finalSet.has(tool)) {
          missCount.set(tool, (missCount.get(tool) ?? 0) + 1)
        }
        if (llmSet.has(tool)) {
          selectCount.set(tool, (selectCount.get(tool) ?? 0) + 1)
        }
      }
    }

    const allTools = new Set([...missCount.keys(), ...selectCount.keys()])
    const tools = [...allTools]
      .map(toolId => {
        const mc = missCount.get(toolId) ?? 0
        const sc = selectCount.get(toolId) ?? 0
        const total = mc + sc
        return {
          toolId,
          missCount: mc,
          selectCount: sc,
          missRate: total > 0 ? Math.round((mc / total) * 1000) / 10 : 0,
        }
      })
      .filter(t => t.missCount > 0)
      .sort((a, b) => b.missCount - a.missCount)
      .slice(0, 30)

    return NextResponse.json({ days, rows: rows.length, tools })
  } catch (err: any) {
    logger.error({ err }, 'resolver tool-miss-heatmap failed')
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
