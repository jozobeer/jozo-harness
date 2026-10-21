import { describe, expect, test } from 'vitest'
import {
  changesOf,
  diffRowsOf,
  fileChangesOf,
  foldRows,
  hunksOf,
  pathInWorkspace,
  totalsOf,
  type ChangeFragment,
} from '../src/ui/diff.ts'
import { traceOf } from '../src/ui/trace.ts'

const fragment = (
  removed: ReadonlyArray<string>,
  added: ReadonlyArray<string>,
  turn = 1,
): ChangeFragment => ({ turn, tool: 'edit', result: '', removed, added })

const events = (
  calls: ReadonlyArray<{ name: string; args: unknown; summary?: string; diffs?: unknown }>,
) =>
  traceOf(
    calls.flatMap((call, index) => {
      const seq = index * 3 + 2
      return [
        ...(index === 0 ? [{ seq: 1, time: 1, type: 'turn/start', data: { turn: 1 } }] : []),
        { seq, time: seq, type: 'step/start', data: { step: index + 1 } },
        {
          seq: seq + 1,
          time: seq + 1,
          type: 'tool/call',
          data: {
            callId: 'c' + String(index),
            name: call.name,
            arguments: JSON.stringify(call.args),
            summary: call.summary ?? '',
          },
        },
        {
          seq: seq + 2,
          time: seq + 2,
          type: 'tool/result',
          data: {
            callId: 'c' + String(index),
            isError: false,
            summary: '',
            content: [],
            ...(call.diffs === undefined ? {} : { diffs: call.diffs }),
          },
        },
      ]
    }),
  )

describe('the path a change names', () => {
  test('loses the cwd prefix, so a file written relatively and absolutely is one file', () => {
    expect(pathInWorkspace('/work', 'notes.txt')).toBe('notes.txt')
    expect(pathInWorkspace('/work', '/work/notes.txt')).toBe('notes.txt')
    expect(pathInWorkspace('/work/', '/work/./src/../notes.txt')).toBe('notes.txt')
    expect(pathInWorkspace('/work', './notes.txt')).toBe('notes.txt')
  })

  test('keeps a path outside the cwd, and folds nothing into a false match', () => {
    expect(pathInWorkspace('/work', '/elsewhere/notes.txt')).toBe('/elsewhere/notes.txt')
    expect(pathInWorkspace('/work', '/workshop/notes.txt')).toBe('/workshop/notes.txt')
    expect(pathInWorkspace('', '/work/notes.txt')).toBe('/work/notes.txt')
    expect(pathInWorkspace('/work', '../notes.txt')).toBe('../notes.txt')
  })
})

describe('the files a session changed', () => {
  test('sums +n, −n and the edit count over every call, once per normalized path', () => {
    const turns = events([
      { name: 'edit', args: { path: 'notes.txt', oldString: 'a', newString: 'b\nc' } },
      { name: 'edit', args: { path: '/work/notes.txt', oldString: 'x', newString: 'y' } },
      { name: 'write', args: { path: '/work/src/new.ts', content: 'one\ntwo\nthree' } },
      { name: 'read', args: { path: 'notes.txt' } },
    ])

    expect(fileChangesOf(turns, '/work')).toEqual([
      { path: 'notes.txt', edits: 2, added: 3, removed: 2 },
      { path: 'src/new.ts', edits: 1, added: 3, removed: 0 },
    ])
  })

  test('draws the file changes the log recorded at execution time', () => {
    const turns = events([
      {
        name: 'write',
        args: { path: 'notes.txt', content: 'new' },
        diffs: [{ path: 'notes.txt', oldStart: 3, newStart: 3, removed: ['old'], added: ['new'] }],
      },
    ])

    expect(fileChangesOf(turns, '/work')).toEqual([
      { path: 'notes.txt', edits: 1, added: 1, removed: 1 },
    ])
    const changes = changesOf(turns, 'notes.txt', '/work')
    expect(changes).toEqual([
      {
        turn: 1,
        tool: 'write',
        result: '',
        removed: ['old'],
        added: ['new'],
        oldStart: 3,
        newStart: 3,
      },
    ])
    expect(hunksOf(changes)[0]?.lines[0]).toEqual({
      kind: 'del',
      text: 'old',
      oldLine: 3,
      newLine: undefined,
    })
  })

  test('reads both the spellings the edit tool has used for its strings', () => {
    const turns = events([
      { name: 'edit', args: { path: 'a.ts', oldString: 'now', newString: 'then' } },
      { name: 'edit', args: { path: 'b.ts', old_string: 'old', new_string: 'new' } },
    ])

    expect(changesOf(turns, 'a.ts', '/w')[0]?.removed).toEqual(['now'])
    expect(changesOf(turns, 'a.ts', '/w')[0]?.added).toEqual(['then'])
    expect(changesOf(turns, 'b.ts', '/w')[0]?.removed).toEqual(['old'])
    expect(changesOf(turns, 'b.ts', '/w')[0]?.added).toEqual(['new'])
  })

  test('keeps a call whose arguments do not parse quiet instead of failing the list', () => {
    const turns = traceOf([
      { seq: 1, time: 1, type: 'turn/start', data: { turn: 1 } },
      {
        seq: 2,
        time: 2,
        type: 'tool/call',
        data: { callId: 'c1', name: 'edit', arguments: '{', summary: '' },
      },
    ])

    expect(fileChangesOf(turns, '/w')).toEqual([])
  })
})

describe('the hunks a change makes', () => {
  test('numbers the old and new sides, and says where each hunk stands', () => {
    const hunks = hunksOf([fragment(['one', 'two'], ['one', 'two', 'three'])])

    expect(hunks).toHaveLength(1)
    expect(hunks[0]?.header).toBe('@@ -1,2 +1,3 @@')
    expect(hunks[0]?.lines).toEqual([
      { kind: 'del', text: 'one', oldLine: 1, newLine: undefined },
      { kind: 'del', text: 'two', oldLine: 2, newLine: undefined },
      { kind: 'add', text: 'one', oldLine: undefined, newLine: 1 },
      { kind: 'add', text: 'two', oldLine: undefined, newLine: 2 },
      { kind: 'add', text: 'three', oldLine: undefined, newLine: 3 },
    ])
  })

  test('carries the gutters on from one call to the next, with a gap between them', () => {
    const hunks = hunksOf([fragment(['a'], ['b'], 1), fragment(['c', 'd'], ['c'], 2)])

    expect(hunks.map((hunk) => hunk.header)).toEqual(['@@ -1,1 +1,1 @@', '@@ -2,2 +2,1 @@'])
    const rows = diffRowsOf(hunks)
    expect(rows[0]).toEqual({ kind: 'hunk', header: '@@ -1,1 +1,1 @@' })
    expect(rows[2]).toEqual({ kind: 'add', text: 'b', oldLine: undefined, newLine: 1 })
    expect(rows[3]).toEqual({ kind: 'gap' })
    expect(rows[4]).toEqual({ kind: 'hunk', header: '@@ -2,2 +2,1 @@' })
    expect(rows[5]).toEqual({ kind: 'del', text: 'c', oldLine: 2, newLine: undefined })
  })

  test('counts a write as added lines from an empty old side', () => {
    const hunks = hunksOf([{ turn: 1, tool: 'write', result: '', removed: [], added: ['a', 'b'] }])

    expect(hunks[0]?.header).toBe('@@ -1,0 +1,2 @@')
    expect(hunks[0]?.lines).toEqual([
      { kind: 'add', text: 'a', oldLine: undefined, newLine: 1 },
      { kind: 'add', text: 'b', oldLine: undefined, newLine: 2 },
    ])
  })

  test('leaves a call that carries no text out of the diff', () => {
    expect(hunksOf([fragment([], [])])).toEqual([])
  })
})

describe('a diff too long for the pane', () => {
  const rows = diffRowsOf(
    hunksOf([
      fragment(
        ['old'],
        Array.from({ length: 20 }, (_, n) => String(n)),
      ),
    ]),
  )

  test('keeps the head and the tail, and says how many rows wait between them', () => {
    const folded = foldRows(rows)

    expect(folded.head).toHaveLength(8)
    expect(folded.tail).toHaveLength(8)
    expect(folded.hidden).toBe(rows.length - 16)
  })

  test('draws a diff no longer than the fold whole', () => {
    const short = rows.slice(0, 10)

    expect(foldRows(short)).toEqual({ head: short, tail: [], hidden: 0 })
  })
})

describe('the totals of a set of changes', () => {
  test('adds the lines each call changed', () => {
    expect(totalsOf([fragment(['a', 'b'], ['c']), fragment(['d'], ['e', 'f'])])).toEqual({
      added: 3,
      removed: 3,
    })
    expect(totalsOf([])).toEqual({ added: 0, removed: 0 })
  })
})
