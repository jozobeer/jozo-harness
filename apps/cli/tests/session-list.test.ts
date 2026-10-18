import type { PluginRow } from '@jozo-harness/kernel'
import type { SessionEvent } from '@jozo-harness/session'
import { describe, expect, test } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  renderSessionHead,
  renderSessionList,
  renderTranscript,
  sessionRootOf,
} from '../src/session-list.ts'

const row = (id: string, name: string, config?: unknown, disabled?: boolean): PluginRow =>
  ({
    id,
    name,
    ...(config === undefined ? {} : { config }),
    ...(disabled === true ? { disabled: true } : {}),
  }) as PluginRow

const event = (seq: number, type: string, data: unknown): SessionEvent =>
  ({ seq, time: seq, type, data }) as unknown as SessionEvent

describe('where the sessions live', () => {
  test('is the row the profile gave, with ~ expanded', () => {
    expect(
      sessionRootOf([row('session-jsonl', '@jozo-harness/session-jsonl', { root: '~/work/logs' })]),
    ).toBe(join(homedir(), 'work/logs'))
    expect(
      sessionRootOf([row('session-jsonl', '@jozo-harness/session-jsonl', { root: '/srv/logs' })]),
    ).toBe('/srv/logs')
  })

  test('falls back to the place jozo-harness keeps them, and skips a disabled row', () => {
    expect(sessionRootOf([])).toBe(join(homedir(), '.jzh/sessions'))
    expect(
      sessionRootOf([
        row('session-jsonl', '@jozo-harness/session-jsonl', { root: '/gone' }, true),
        row('kernel', '@jozo-harness/kernel'),
      ]),
    ).toBe(join(homedir(), '.jzh/sessions'))
    expect(sessionRootOf([row('session-jsonl', '@jozo-harness/session-jsonl', { root: '' })])).toBe(
      join(homedir(), '.jzh/sessions'),
    )
  })
})

describe('reading the sessions back', () => {
  test('the list names each one, newest first', () => {
    const text = renderSessionList([
      {
        id: 'older',
        cwd: '/work',
        createdAt: Date.UTC(2026, 0, 2, 3, 4, 5),
        updatedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
        title: 'count the files',
      },
      {
        id: 'newer',
        cwd: '/home/me',
        createdAt: Date.UTC(2026, 1, 3, 4, 5, 6),
        updatedAt: Date.UTC(2026, 1, 3, 4, 5, 6),
        title: '',
      },
    ])

    expect(text.split('\n')[0]).toBe('newer  2026-02-03 04:05:06  /home/me')
    expect(text).toContain('count the files')
    expect(text).toContain('older  2026-01-02 03:04:05  /work')
    expect(renderSessionList([])).toBe('no sessions yet\n')
  })

  test('the list follows the last change, not the moment it started', () => {
    const text = renderSessionList([
      {
        id: 'used-again',
        cwd: '/work',
        createdAt: Date.UTC(2026, 0, 2, 3, 4, 5),
        updatedAt: Date.UTC(2026, 1, 3, 4, 5, 6),
        title: 'count the files',
      },
      {
        id: 'made-later',
        cwd: '/home/me',
        createdAt: Date.UTC(2026, 1, 2, 3, 4, 5),
        updatedAt: Date.UTC(2026, 1, 2, 3, 4, 5),
        title: '',
      },
    ])

    expect(text.split('\n')[0]).toBe('used-again  2026-02-03 04:05:06  /work  count the files')
  })

  test('a transcript shows the messages the log folds to', () => {
    const text = renderTranscript([
      event(1, 'session/header', { formatVersion: 1, createdAt: 0, cwd: '/work' }),
      event(2, 'user/message', { text: 'count the files', source: 'user' }),
      event(3, 'turn/start', { turn: 1 }),
      event(4, 'assistant/message', { content: [{ type: 'text', text: 'twelve files' }] }),
      event(5, 'tool/call', { callId: 'c1', name: 'glob', arguments: '{"pattern":"*"}' }),
      event(6, 'tool/result', {
        callId: 'c1',
        isError: false,
        content: [{ type: 'text', text: 'a.txt' }],
      }),
      event(7, 'turn/end', { turn: 1, reason: 'completed' }),
    ])

    expect(text).toContain('[user] count the files')
    expect(text).toContain('[assistant] twelve files')
    expect(text).toContain('[tool result] a.txt')
    expect(
      renderTranscript([event(1, 'session/header', { formatVersion: 1, createdAt: 0, cwd: '/w' })]),
    ).toBe('(nothing was said yet)\n')
  })

  test('a browse opens with the session it is reading', () => {
    const head = renderSessionHead({
      id: 's-1',
      cwd: '/work',
      createdAt: 0,
      updatedAt: 0,
      title: 'count the files',
    })

    expect(head).toContain('session s-1')
    expect(head).toContain('cwd /work')
  })
})
