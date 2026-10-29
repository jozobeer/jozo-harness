import { describe, expect, test } from 'vitest'
import type { UiSessionEvent } from '@jozo-harness/ui-protocol'
import { dataText, emptyLog, folded, keysOf, logAfter } from '../src/ui/log.ts'

const event = (seq: number, type: string, data: unknown): UiSessionEvent => ({
  seq,
  time: seq * 10,
  type,
  data,
})

const read = (events: ReadonlyArray<UiSessionEvent>) => events.reduce(logAfter, emptyLog)

describe('the session log', () => {
  test('list every event with the seq, time, and type the log wrote', () => {
    const log = read([
      event(1, 'session/header', { cwd: '/work' }),
      event(2, 'turn/start', { turn: 1 }),
    ])

    expect(log.events.map((one) => [one.seq, one.time, one.type])).toEqual([
      [1, 10, 'session/header'],
      [2, 20, 'turn/start'],
    ])
  })

  test('name the turn and step a call and its result belong to', () => {
    const log = read([
      event(1, 'turn/start', { turn: 2 }),
      event(2, 'step/start', { step: 3 }),
      event(3, 'tool/call', { callId: 'call-1', name: 'read', arguments: '{}' }),
      event(4, 'tool/result', { callId: 'call-1', isError: false, content: [] }),
    ])

    expect(log.events[2]?.node).toEqual({ turn: 2, step: 3, callId: 'call-1' })
    expect(log.events[3]?.node).toEqual({ turn: 2, step: 3, callId: 'call-1' })
  })

  test('put a call written outside any open turn under the standalone turn', () => {
    const log = read([
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      event(3, 'tool/call', { callId: 'call-9', name: 'skill', arguments: '{}' }),
    ])

    expect(log.events[2]?.node).toEqual({ turn: 0, step: 0, callId: 'call-9' })
  })

  test('name no node for an event the conversation does not draw', () => {
    const log = read([event(1, 'session/header', { cwd: '/work' })])

    expect(log.events[0]?.node).toBeUndefined()
  })

  test('keep the keys a data value carries, nested ones included, to filter by', () => {
    const keys = keysOf({ callId: 'c1', content: [{ type: 'text', text: 'hi' }] })

    expect([...keys].sort()).toEqual(['callId', 'content', 'text', 'type'])
  })

  test('fold a long string and a long list, saying how much was left out', () => {
    const long = folded({ text: 'x'.repeat(200), items: Array.from({ length: 30 }, () => 1) })
    const shown = long as { readonly text: string; readonly items: ReadonlyArray<unknown> }

    expect(shown.text.endsWith('… (200 chars)')).toBe(true)
    expect(shown.text.length).toBeLessThan(200)
    expect(shown.items).toHaveLength(25)
    expect(shown.items.at(-1)).toBe('… (6 more)')
  })

  test('print the data as indented text for the detail panel', () => {
    expect(dataText({ callId: 'c1' })).toBe('{\n  "callId": "c1"\n}')
  })
})
