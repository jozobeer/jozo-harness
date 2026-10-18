import { describe, expect, test } from 'vitest'
import { applyEvent, emptyConversation, summaryBodyOf, type Conversation } from '../src/index.ts'
import type { UiSessionEvent } from '@jozo-harness/ui-protocol'

const event = (seq: number, type: string, data: unknown): UiSessionEvent =>
  ({ seq, time: seq, type, data }) as unknown as UiSessionEvent

const apply = (state: Conversation, ...events: ReadonlyArray<UiSessionEvent>): Conversation =>
  events.reduce((current, each) => applyEvent(current, { kind: 'session', event: each }), state)

const toolBlock = (state: Conversation) => state.blocks.find((block) => block.kind === 'tool')

describe('the line a tool shows', () => {
  test('comes from the log when the pipeline rendered one', () => {
    const state = apply(
      emptyConversation,
      event(1, 'tool/call', {
        callId: 'c1',
        name: 'bash',
        arguments: '{"command":"ls -la"}',
        summary: 'bash ls -la',
      }),
      event(2, 'tool/result', {
        callId: 'c1',
        isError: false,
        content: [{ type: 'text', text: 'a\nb\n[exit code: 0]' }],
        summary: 'exit 0',
      }),
    )

    expect(toolBlock(state)).toMatchObject({ summary: 'bash ls -la', result: 'exit 0' })
  })

  test('is made here for a log written before summaries were recorded', () => {
    const state = apply(
      emptyConversation,
      event(1, 'tool/call', { callId: 'c1', name: 'bash', arguments: '{"command":"ls -la"}' }),
      event(2, 'tool/result', {
        callId: 'c1',
        isError: true,
        content: [{ type: 'text', text: 'boom\nmore' }],
      }),
    )

    expect(toolBlock(state)).toMatchObject({ summary: '{"command":"ls -la"}', result: 'boom' })
  })
})

describe('the body of a recorded summary', () => {
  test('drops the tool name the line starts with', () => {
    expect(summaryBodyOf('bash', 'bash ls -la')).toBe('ls -la')
    expect(summaryBodyOf('glob', 'glob **/*.{ts,tsx}')).toBe('**/*.{ts,tsx}')
  })

  test('leaves a line alone when it does not begin with the name', () => {
    expect(summaryBodyOf('bash', 'pnpm test')).toBe('pnpm test')
    expect(summaryBodyOf('web_fetch', 'fetch https://example.com')).toBe(
      'fetch https://example.com',
    )
    expect(summaryBodyOf('read', 'readme.md')).toBe('readme.md')
  })

  test('a line that is only the name leaves an empty body', () => {
    expect(summaryBodyOf('bash', 'bash')).toBe('')
    expect(summaryBodyOf('', 'anything')).toBe('anything')
  })
})
