import { describe, expect, test } from 'vitest'
import type { UiSessionEvent } from '@jozo-harness/ui-protocol'
import { axisEndOf, toolsOf, traceOf, writtenPath } from '../src/ui/trace.ts'

const event = (type: string, data: unknown, time: number): UiSessionEvent => ({
  seq: time,
  time,
  type,
  data,
})

const claim = (text: string, source: string, time: number): UiSessionEvent =>
  event('agent/inbox/claimed', { target: 'next-turn', message: { text, source } }, time)

const said = (time: number, ...content: ReadonlyArray<unknown>): UiSessionEvent =>
  event('assistant/message', { content }, time)

describe('the trace', () => {
  test('a turn holds the prompt, its steps and tools, the answer, and the files it wrote', () => {
    const [turn] = traceOf([
      event('turn/start', { turn: 1 }, 10),
      claim('fix the ledger', 'user', 11),
      event('step/start', { step: 1 }, 12),
      said(13, { type: 'reasoning', text: 'read it first' }, { type: 'text', text: 'Reading.' }),
      event(
        'tool/call',
        { callId: 'c1', name: 'edit', arguments: '{"path":"a.ts"}', summary: 'edit a.ts' },
        14,
      ),
      event(
        'tool/result',
        {
          callId: 'c1',
          isError: false,
          summary: 'lines: 1 → 2',
          content: [{ type: 'text', text: 'ok' }],
        },
        15,
      ),
      event(
        'tool/call',
        { callId: 'c2', name: 'write', arguments: '{"file_path":"a.ts"}', summary: 'write a.ts' },
        16,
      ),
      event(
        'tool/result',
        {
          callId: 'c2',
          isError: true,
          summary: 'denied',
          content: [],
          error: { name: 'ToolError', code: 'denied' },
          diffs: [
            {
              path: 'a.ts',
              oldStart: 4,
              newStart: 4,
              removed: ['old'],
              added: ['new'],
            },
          ],
        },
        17,
      ),
      event('step/end', { step: 1 }, 18),
      event('step/start', { step: 2 }, 19),
      said(20, { type: 'text', text: 'Done.' }),
      event('step/end', { step: 2 }, 21),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 22),
    ])
    expect(turn?.prompt).toBe('fix the ledger')
    expect(turn?.answer).toBe('Done.')
    expect(turn?.outcome).toBe('completed')
    expect(turn?.endedAt).toBe(22)
    expect(turn?.changed).toEqual([{ path: 'a.ts', edits: 2 }])
    expect(turn?.steps[0]?.reasoning).toBe('read it first')
    expect(
      turn === undefined
        ? []
        : toolsOf(turn).map((tool) => [
            tool.status,
            tool.result,
            tool.endedAt,
            tool.diffs,
            tool.errorCode,
          ]),
    ).toEqual([
      ['done', 'lines: 1 → 2', 15, [], ''],
      [
        'error',
        'denied',
        17,
        [{ path: 'a.ts', oldStart: 4, newStart: 4, removed: ['old'], added: ['new'] }],
        'denied',
      ],
    ])
  })

  test('only the human claims the prompt, and a running turn has no end', () => {
    const [turn] = traceOf([
      event('turn/start', { turn: 2 }, 5),
      claim('a reminder', 'schedule', 6),
      claim('the real ask', 'user', 7),
      claim('a later one', 'user', 8),
      event('step/start', { step: 1 }, 9),
      event('tool/call', { callId: 'c1', name: 'bash', arguments: '{}', summary: 'bash ls' }, 10),
    ])
    expect(turn?.prompt).toBe('the real ask')
    expect(turn?.endedAt).toBeUndefined()
    expect(turn?.outcome).toBe('')
    expect(turn === undefined ? [] : toolsOf(turn).map((tool) => tool.status)).toEqual(['running'])
  })

  test('a running turn ends its axis at its last event, and a finished one at its end', () => {
    const running = traceOf([
      event('turn/start', { turn: 1 }, 10),
      event('step/start', { step: 1 }, 20),
      event('tool/call', { callId: 'c1', name: 'bash', arguments: '{}', summary: 'bash ls' }, 30),
      event('tool/result', { callId: 'c1', isError: false, summary: 'ok', content: [] }, 40),
      event('step/start', { step: 2 }, 50),
      event('tool/call', { callId: 'c2', name: 'bash', arguments: '{}', summary: 'bash pwd' }, 60),
    ])
    expect(running[0] === undefined ? 0 : axisEndOf(running[0])).toBe(60)

    const finished = traceOf([
      event('turn/start', { turn: 1 }, 100),
      event('step/start', { step: 1 }, 110),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 120),
    ])
    expect(finished[0] === undefined ? 0 : axisEndOf(finished[0])).toBe(120)
  })

  test('a call written before any turn stands on its own, so a forced skill load stays visible', () => {
    const path = '/home/me/.agents/skills/review/SKILL.md'
    const entries = traceOf([
      said(10, {
        type: 'tool-call',
        id: 's1',
        name: 'skill',
        arguments: '{"name":"review"}',
      }),
      event(
        'tool/call',
        { callId: 's1', name: 'skill', arguments: '{"name":"review"}', summary: path },
        11,
      ),
      event(
        'tool/result',
        {
          callId: 's1',
          isError: false,
          summary: 'review does things',
          content: [{ type: 'text', text: '# review' }],
        },
        12,
      ),
      event('turn/start', { turn: 1 }, 20),
      claim('check the diff', 'user', 21),
      event('step/start', { step: 1 }, 22),
    ])
    const [load, turn] = entries
    expect(entries.map((entry) => entry.standalone)).toEqual([true, false])
    expect(load?.prompt).toBe('')
    expect(load?.endedAt).toBe(12)
    expect(
      load === undefined
        ? []
        : toolsOf(load).map((tool) => [
            tool.name,
            tool.status,
            tool.summary,
            tool.result,
            tool.startedAt,
            tool.endedAt,
          ]),
    ).toEqual([['skill', 'done', path, 'review does things', 11, 12]])
    expect(turn?.turn).toBe(1)
    expect(turn?.prompt).toBe('check the diff')
    expect(turn === undefined ? [] : toolsOf(turn)).toEqual([])
  })

  test('a step or header before any turn and bodies it cannot read change nothing', () => {
    expect(traceOf([event('step/start', { step: 1 }, 1), event('session/header', {}, 2)])).toEqual(
      [],
    )
    const [turn] = traceOf([event('turn/start', null, 3), said(4, 'not a part')])
    expect(turn?.turn).toBe(0)
    expect(turn?.answer).toBe('')
  })

  test('a tool result keeps the image blocks it carried, and no broken one', () => {
    const [turn] = traceOf([
      event('turn/start', { turn: 1 }, 10),
      event('step/start', { step: 1 }, 11),
      event(
        'tool/call',
        { callId: 'c1', name: 'read_image', arguments: '{"path":"a.png"}', summary: '' },
        12,
      ),
      event(
        'tool/result',
        {
          callId: 'c1',
          isError: false,
          summary: '',
          content: [
            { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=', name: '/tmp/a.png' },
            { type: 'image', mediaType: 'image/png', data: '' },
          ],
        },
        13,
      ),
    ])
    const tool = turn === undefined ? undefined : toolsOf(turn)[0]
    expect(tool?.output).toBe('')
    expect(tool?.images).toEqual([
      { mediaType: 'image/png', data: 'iVBORw0KGgo=', name: '/tmp/a.png' },
    ])
  })

  test('a rating folds onto the answer it names, and the latest verdict wins', () => {
    const [turn] = traceOf([
      event('turn/start', { turn: 1 }, 10),
      event('step/start', { step: 1 }, 11),
      said(13, { type: 'text', text: 'Done.' }),
      event('feedback/rated', { target: 13, rating: 'like', memo: 'clear' }, 14),
      event('feedback/rated', { target: 13, rating: 'dislike' }, 15),
    ])

    expect(turn?.answer).toBe('Done.')
    expect(turn?.answerSeq).toBe(13)
    expect(turn?.feedback).toEqual({ rating: 'dislike', memo: '' })
  })

  test('a rating for an answer outside the turn changes nothing', () => {
    const [turn] = traceOf([
      event('turn/start', { turn: 1 }, 10),
      event('step/start', { step: 1 }, 11),
      said(13, { type: 'text', text: 'Done.' }),
      event('feedback/rated', { target: 99, rating: 'like' }, 14),
    ])

    expect(turn?.feedback).toBeUndefined()
  })

  test('only an edit or a write with a readable path names a file', () => {
    expect(writtenPath('edit', '{"path":"x.ts"}')).toBe('x.ts')
    expect(writtenPath('read', '{"path":"x.ts"}')).toBeUndefined()
    expect(writtenPath('edit', '{')).toBeUndefined()
    expect(writtenPath('write', '{}')).toBeUndefined()
  })
})
