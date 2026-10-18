import { describe, expect, test } from 'vitest'
import type { UiEvent } from '@jozo-harness/ui-protocol'
import { boardOf, emptyWatched, entryOf, watchedAfter, type Watched } from '../src/ui/board.ts'

const at = (seq: number, type: string, data: unknown): UiEvent => ({
  kind: 'session',
  event: { seq, time: seq * 1000, type, data },
})

const follow = (...events: ReadonlyArray<UiEvent>): Watched =>
  events.reduce(watchedAfter, emptyWatched)

const summary = (id: string, createdAt = 1, updatedAt = createdAt) => ({
  id,
  cwd: '/work/' + id,
  createdAt,
  updatedAt,
  title: id,
})

const working = follow(
  at(1, 'turn/start', { turn: 1 }),
  at(2, 'step/start', { step: 1 }),
  at(3, 'tool/call', { callId: 'c1', name: 'bash', arguments: '{}', summary: 'pnpm test' }),
)

describe('the board', () => {
  test('a running session says what it is doing and since when', () => {
    const entry = entryOf(summary('a'), working)
    expect(entry).toMatchObject({
      status: 'running',
      since: 1000,
      calls: 1,
      doing: 'bash pnpm test',
    })
  })

  test('an approval puts the session on the waiting list, ahead of the running ones', () => {
    const asking = follow(
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'safety/approval/requested', { callId: 'c9', tool: 'bash', reason: 'network' }),
    )
    const board = boardOf(
      [summary('a'), summary('b'), summary('c', 5)],
      new Map([
        ['a', working],
        ['b', asking],
      ]),
    )
    expect(board.waiting.map((entry) => entry.summary.id)).toEqual(['b'])
    expect(board.waiting[0]?.waiting).toEqual({
      kind: 'approval',
      request: { callId: 'c9', tool: 'bash', reason: 'network' },
    })
    expect(board.running.map((entry) => entry.summary.id)).toEqual(['a'])
    expect(board.rest.map((entry) => [entry.summary.id, entry.status])).toEqual([['c', 'closed']])
  })

  test('a session changed later rises above one created later', () => {
    const board = boardOf([summary('old', 1000, 9000), summary('new', 5000)], new Map())
    expect(board.rest.map((entry) => entry.summary.id)).toEqual(['old', 'new'])
    expect(board.rest[0]?.since).toBe(9000)
  })

  test('a pinned session sits at the top of its group even when it changed longer ago', () => {
    const board = boardOf(
      [summary('newer', 5000), { ...summary('pinned', 1000), pinned: true }],
      new Map(),
    )
    expect(board.rest.map((entry) => entry.summary.id)).toEqual(['pinned', 'newer'])
  })

  test('a finished session keeps the first line of its answer, and a replayed event counts once', () => {
    const step = at(2, 'step/start', { step: 1 })
    const done = follow(
      at(1, 'turn/start', { turn: 1 }),
      step,
      step,
      at(3, 'assistant/message', { content: [{ type: 'text', text: 'fixed it\nmore' }] }),
      at(4, 'interaction/ask/requested', { id: 'q', question: 'which?', options: [] }),
      at(5, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    )
    expect(done.trace.map((turn) => turn.steps.length)).toEqual([1])
    expect(entryOf(summary('a'), done)).toMatchObject({
      status: 'idle',
      said: 'fixed it',
      since: 5000,
    })
    const asking = follow(
      at(1, 'interaction/ask/requested', { id: 'q', question: 'which?', options: [] }),
    )
    expect(entryOf(summary('a'), asking).waiting?.kind).toBe('ask')
  })
})
