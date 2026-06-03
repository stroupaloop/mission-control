import { describe, expect, it } from 'vitest'
import { diffLines } from '../panels/persona-diff'

describe('diffLines', () => {
  it('reports all-same when content is identical', () => {
    const rows = diffLines('a\nb\nc', 'a\nb\nc')
    expect(rows.every((r) => r.type === 'same')).toBe(true)
    expect(rows.map((r) => r.text)).toEqual(['a', 'b', 'c'])
  })

  it('tags an added line', () => {
    const rows = diffLines('a\nc', 'a\nb\nc')
    expect(rows).toEqual([
      { type: 'same', text: 'a' },
      { type: 'add', text: 'b' },
      { type: 'same', text: 'c' },
    ])
  })

  it('tags a deleted line', () => {
    const rows = diffLines('a\nb\nc', 'a\nc')
    expect(rows).toEqual([
      { type: 'same', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'same', text: 'c' },
    ])
  })

  it('tags a modified line as del + add', () => {
    const rows = diffLines('hello world', 'hello there')
    expect(rows).toContainEqual({ type: 'del', text: 'hello world' })
    expect(rows).toContainEqual({ type: 'add', text: 'hello there' })
  })

  it('preserves order with interleaved changes', () => {
    const rows = diffLines('line1\nline2\nline3', 'line1\nCHANGED\nline3\nline4')
    expect(rows).toEqual([
      { type: 'same', text: 'line1' },
      { type: 'del', text: 'line2' },
      { type: 'add', text: 'CHANGED' },
      { type: 'same', text: 'line3' },
      { type: 'add', text: 'line4' },
    ])
  })
})
