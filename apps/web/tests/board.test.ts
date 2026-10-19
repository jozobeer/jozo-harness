import { describe, expect, test } from 'vitest'
import type { UiEvent } from '@jozo-harness/ui-protocol'
import {
  RECENT_PAGE,
  atKey,
  boardOf,
  byKey,
  emptyWatched,
  entryOf,
  keysOf,
  recentGroupsOf,
  visibleSessions,
  watchedAfter,
  type Watched,
} from '../src/ui/board.ts'

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
  at(3, 'tool/call', { callId: 'c1', name: 'bash', arguments: '{}', summary: 'bash pnpm test' }),
)

describe('the board', () => {
  test('an empty session is hidden unless the page reads it or the reader asks for empties', () => {
    const quiet = { ...summary('quiet'), empty: true }
    const said = summary('said')

    expect(visibleSessions([quiet, said], {}).map((item) => item.id)).toEqual(['said'])
    expect(visibleSessions([quiet, said], { opened: ['quiet'] }).map((item) => item.id)).toEqual([
      'quiet',
      'said',
    ])
    expect(visibleSessions([quiet, said], { showEmpty: true }).map((item) => item.id)).toEqual([
      'quiet',
      'said',
    ])
    expect(visibleSessions([{ ...quiet, archived: true }], {}).map((item) => item.id)).toEqual([])
    expect(
      visibleSessions([{ ...quiet, archived: true }], { showEmpty: true, showArchived: true }).map(
        (item) => item.id,
      ),
    ).toEqual(['quiet'])
  })

  test('a running session says what it is doing and since when', () => {
    const entry = entryOf(summary('a'), working)
    expect(entry).toMatchObject({
      status: 'running',
      since: 1000,
      calls: 1,
      doing: 'bash pnpm test',
      ended: undefined,
    })
  })

  test('a session tells how its last turn ended, past a skill load written after it', () => {
    const failed = follow(
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'turn/end', {
        turn: 1,
        reason: { kind: 'error', failure: { code: 'llm', message: 'down' } },
      }),
      at(3, 'tool/call', { callId: 's1', name: 'skill', arguments: '{}', summary: 'SKILL.md' }),
    )
    expect(failed.trace.map((turn) => turn.standalone)).toEqual([false, true])
    expect(entryOf(summary('a'), failed).ended).toEqual({ outcome: 'error', at: 2000 })
    expect(entryOf(summary('a'), undefined).ended).toBeUndefined()
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

  test('Recent folds by workspace, with the workspaces by their latest update', () => {
    const folder = (id: string, cwd: string, updatedAt: number, pinned = false) => ({
      id,
      cwd,
      createdAt: 1,
      updatedAt,
      title: id,
      pinned,
    })
    const groups = recentGroupsOf(
      boardOf(
        [
          folder('one-new', '/work/one', 9000),
          folder('two-old', '/work/two', 1000),
          folder('one-pinned', '/work/one', 2000, true),
          folder('two-new', '/work/two', 7000),
        ],
        new Map(),
      ).rest,
    )

    expect(groups.map((group) => group.cwd)).toEqual(['/work/one', '/work/two'])
    expect(groups[0]?.updatedAt).toBe(9000)
    expect(groups[0]?.entries.map((entry) => entry.summary.id)).toEqual(['one-pinned', 'one-new'])
    expect(groups[1]?.entries.map((entry) => entry.summary.id)).toEqual(['two-new', 'two-old'])
  })

  test('a workspace shows five rows before Show more', () => {
    expect(RECENT_PAGE).toBe(5)
  })

  test('a row is found again by the key its session keeps, though the board builds it anew', () => {
    const sessions = [summary('a', 3), summary('b', 2), summary('c', 1)]
    const first = boardOf(sessions, new Map())
    const second = boardOf(sessions, new Map())

    // The board builds new rows every time; the rail must key by what does not move.
    expect(second.rest[0]).not.toBe(first.rest[0])
    expect(keysOf(second.rest, (entry) => entry.summary.id)).toEqual(['a', 'b', 'c'])
    expect(keysOf(second.rest, (entry) => entry.summary.id)).toEqual(
      keysOf(first.rest, (entry) => entry.summary.id),
    )

    const rows = byKey(second.rest, (entry) => entry.summary.id)
    expect(atKey(rows, 'b')).toBe(second.rest[1])
    expect(() => atKey(rows, 'gone')).toThrow('no entry for gone')
  })

  test('a folder is found again by its cwd, so Recent keeps the fold it drew', () => {
    const groups = recentGroupsOf(boardOf([summary('a', 2), summary('b', 1)], new Map()).rest)
    expect(keysOf(groups, (group) => group.cwd)).toEqual(['/work/a', '/work/b'])
    expect(
      atKey(
        byKey(groups, (group) => group.cwd),
        '/work/b',
      ),
    ).toBe(groups[1])
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
      ended: { outcome: 'completed', at: 5000 },
    })
    const asking = follow(
      at(1, 'interaction/ask/requested', { id: 'q', question: 'which?', options: [] }),
    )
    expect(entryOf(summary('a'), asking).waiting?.kind).toBe('ask')
  })
})
