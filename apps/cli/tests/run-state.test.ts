import { describe, expect, test } from 'vitest'
import type { SessionEvent } from '@jozo-harness/session'
import { promptSectionsOf, skillsOf, todosOf } from '../src/run-state.ts'

let seq = 0
const event = (type: string, data: unknown): SessionEvent => {
  seq += 1
  return { seq, time: seq, type, data } as SessionEvent
}

const call = (callId: string, name: string, args: unknown): SessionEvent =>
  event('tool/call', { callId, name, arguments: JSON.stringify(args) })

const result = (callId: string, isError = false): SessionEvent =>
  event('tool/result', { callId, isError, content: [] })

describe('the run state projections', () => {
  test('the latest successful todo_write is the list a page shows', () => {
    const events = [
      call('t1', 'todo_write', {
        todos: [{ content: 'read the issue', status: 'completed' }],
      }),
      result('t1'),
      call('t2', 'todo_write', {
        todos: [
          { content: 'write the test', status: 'completed' },
          { content: 'fix the code', status: 'in_progress' },
          { content: 'run the tests', status: 'pending' },
        ],
      }),
      result('t2'),
    ]

    expect(todosOf(events)).toEqual({
      todos: [
        { content: 'write the test', status: 'completed' },
        { content: 'fix the code', status: 'in_progress' },
        { content: 'run the tests', status: 'pending' },
      ],
      counts: { pending: 1, inProgress: 1, completed: 1 },
    })
  })

  test('a failed todo_write leaves the previous list standing', () => {
    const events = [
      call('t1', 'todo_write', { todos: [{ content: 'kept', status: 'pending' }] }),
      result('t1'),
      call('t2', 'todo_write', { todos: [{ content: 'lost', status: 'completed' }] }),
      result('t2', true),
    ]

    expect(todosOf(events)?.todos).toEqual([{ content: 'kept', status: 'pending' }])
  })

  test('loaded skills are listed once, in the order they were read, and a failed read is not listed', () => {
    const events = [
      call('s1', 'skill', { name: 'code-complete' }),
      result('s1'),
      call('s2', 'skill', { name: 'missing' }),
      result('s2', true),
      call('s3', 'skill', { name: 'typescript-best-practices' }),
      result('s3'),
      call('s4', 'skill', { name: 'code-complete' }),
      result('s4'),
    ]

    expect(skillsOf(events)).toEqual(['code-complete', 'typescript-best-practices'])
  })

  test('the newest system prompt says which sections it used; an old log says none', () => {
    const events = [
      event('system/message', { text: 'first' }),
      event('system/message', { text: 'second', sections: ['identity', 'agents-md:1'] }),
      event('system/message', { text: 'third' }),
    ]

    expect(promptSectionsOf(events)).toEqual([])
    expect(promptSectionsOf(events.slice(0, 2))).toEqual(['identity', 'agents-md:1'])
  })
})
