'use client'

// Minimal line-level diff for the persona Settings tab's "diff before save"
// affordance (memo §6). Shows the current server content vs the operator's local
// edits so they can eyeball exactly what a PUT will change — important because
// the agent self-edits these same files, so an operator should see what they're
// about to overwrite.
//
// Deliberately dependency-free: the repo carries no diff component or diff lib,
// and a persona file is small human-authored markdown (hundreds of lines at
// most), so a classic O(n·m) LCS over LINES is more than fast enough. A guard
// below falls back to a plain "content changed" notice if either side is
// pathologically large, so the LCS can never blow up the render thread.

const MAX_DIFF_LINES = 4000
// The LCS allocates an (n+1)×(m+1) cell matrix, so a per-side line cap alone
// isn't enough — a 4000×4000 file (well under the server's 1 MiB cap when lines
// are short) would still build ~16M cells synchronously during render and freeze
// the Settings tab. Cap the PRODUCT so the matrix can never exceed this.
const MAX_DIFF_CELLS = 500_000

export type DiffRow =
  | { type: 'same'; text: string }
  | { type: 'add'; text: string }
  | { type: 'del'; text: string }

/**
 * Longest-common-subsequence line diff. Returns the rows in order with each
 * line tagged `same` (unchanged), `del` (only in `before`), or `add` (only in
 * `after`). Pure + exported so the test suite can assert on it directly.
 */
export function diffLines(before: string, after: string): DiffRow[] {
  const a = before.split('\n')
  const b = after.split('\n')
  const n = a.length
  const m = b.length

  // dp[i][j] = LCS length of a[i:] and b[j:].
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  )
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const rows: DiffRow[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: 'same', text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: 'del', text: a[i] })
      i++
    } else {
      rows.push({ type: 'add', text: b[j] })
      j++
    }
  }
  while (i < n) rows.push({ type: 'del', text: a[i++] })
  while (j < m) rows.push({ type: 'add', text: b[j++] })
  return rows
}

interface Props {
  before: string
  after: string
}

export function PersonaDiff({ before, after }: Props) {
  if (before === after) {
    return (
      <div
        className="text-xs text-muted-foreground"
        data-testid="persona-diff-nochange"
      >
        No changes to save.
      </div>
    )
  }

  // Pathological-size guard: skip the O(n·m) LCS and just say it changed.
  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')
  const tooLarge =
    beforeLines.length > MAX_DIFF_LINES ||
    afterLines.length > MAX_DIFF_LINES ||
    beforeLines.length * afterLines.length > MAX_DIFF_CELLS
  if (tooLarge) {
    return (
      <div
        className="text-xs text-muted-foreground"
        data-testid="persona-diff-toolarge"
      >
        File is large — line-by-line diff suppressed. Your edits will replace the
        current server content on save.
      </div>
    )
  }

  const rows = diffLines(before, after)

  return (
    <pre
      className="text-xs font-mono bg-surface-2 border border-border rounded p-2 overflow-x-auto max-h-64 overflow-y-auto"
      data-testid="persona-diff"
    >
      {rows.map((row, idx) => {
        const cls =
          row.type === 'add'
            ? 'text-green-400'
            : row.type === 'del'
              ? 'text-red-400'
              : 'text-muted-foreground'
        const prefix =
          row.type === 'add' ? '+ ' : row.type === 'del' ? '- ' : '  '
        return (
          <div key={idx} className={cls}>
            {/* Render whitespace-only / empty lines visibly. */}
            {prefix}
            {row.text || ' '}
          </div>
        )
      })}
    </pre>
  )
}
