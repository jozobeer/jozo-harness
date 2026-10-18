import { describe, expect, test } from 'vitest'
import { applyEvent, emptyConversation, type Conversation } from '@jozo-harness/ui-view'
import type { UiEvent } from '@jozo-harness/ui-protocol'
import {
  displayWidth,
  emptyEditor,
  insert,
  initialTuiState,
  render,
  viewportOf,
  type TuiState,
} from '../src/index.ts'

let seq = 0
const session = (type: string, data: unknown): UiEvent => {
  seq += 1
  return { kind: 'session', event: { seq, time: seq, type, data } }
}
const fold = (events: ReadonlyArray<UiEvent>): Conversation =>
  events.reduce(applyEvent, emptyConversation)

const state = (partial: Partial<TuiState> = {}): TuiState => ({
  ...initialTuiState,
  title: 'jozo-harness · stub/model',
  ...partial,
})
const screen = (value: TuiState, columns = 40, rows = 8) =>
  render(value, { columns, rows }, { color: false })

describe('tui render', () => {
  test('fills exactly the terminal height', () => {
    expect(screen(state()).lines).toHaveLength(8)
  })

  test('the status line carries the title and the running hint', () => {
    const lines = screen(state({ conversation: fold([session('turn/start', { turn: 1 })]) })).lines
    expect(lines[0]).toContain('jozo-harness · stub/model')
    expect(lines[0]).toContain('working')
  })

  test('the conversation tail sits above the input line', () => {
    const view = screen(
      state({
        conversation: fold([
          session('turn/start', { turn: 1 }),
          session('user/message', { text: 'hello', source: 'user' }),
          session('assistant/message', {
            provider: 'stub',
            model: 'm',
            content: [{ type: 'text', text: 'hi there' }],
            stream: [],
          }),
        ]),
      }),
    )
    const text = view.lines.join('\n')
    expect(text).toContain('› hello')
    expect(text).toContain('hi there')
  })

  test('long lines wrap inside the width', () => {
    const view = screen(
      state({
        conversation: fold([
          session('user/message', { text: 'abcdefghijklmnopqrstuvwxyz0123456789', source: 'user' }),
        ]),
      }),
      24,
      8,
    )
    for (const line of view.lines) expect(displayWidth(line)).toBeLessThanOrEqual(24)
    expect(view.lines.join('\n')).toContain('abcdefghijklmnopqrstuv')
    expect(view.lines.join('\n')).toContain('wxyz0123456789')
  })

  test('the cursor follows the typed text, counting wide characters as two', () => {
    const view = screen(state({ editor: insert(insert(emptyEditor, 'あ'), 'b') }))
    expect(view.lines[view.lines.length - 1]).toBe('› あb')
    expect(view.cursor).toEqual({ row: 7, column: 5 })
  })

  test('a pending approval replaces the input line with the question', () => {
    const view = screen(
      state({
        conversation: fold([
          session('turn/start', { turn: 1 }),
          session('safety/approval/requested', { callId: 'c1', tool: 'bash', reason: 'x' }),
        ]),
      }),
    )
    expect(view.lines[view.lines.length - 1]).toContain('[y/n]')
    expect(view.lines[0]).toContain('approval')
  })

  test('a tool line names the tool once even when the log repeats it', () => {
    const view = screen(
      state({
        conversation: fold([
          session('tool/call', {
            callId: 'c1',
            name: 'bash',
            arguments: '{"command":"ls -la"}',
            summary: 'bash ls -la',
          }),
        ]),
      }),
    )
    const text = view.lines.join('\n')
    expect(text).toContain('⏺ bash ls -la')
    expect(text).not.toContain('bash bash')
  })

  test('tool output cannot inject terminal controls', () => {
    const view = screen(
      state({
        conversation: fold([
          session('tool/call', { callId: 'c1', name: 'bash', arguments: '{}' }),
          session('tool/result', {
            callId: 'c1',
            isError: false,
            content: [{ type: 'text', text: '\u001b[31mred\u001b[0m' }],
          }),
        ]),
      }),
    )
    expect(view.lines.join('\n')).not.toContain('\u001b[31m')
    expect(view.lines.join('\n')).toContain('red')
  })

  const lines = fold(
    ['one', 'two', 'three', 'four', 'five'].map((text) =>
      session('user/message', { text, source: 'user' }),
    ),
  )

  test('a pinned window shows the lines above the tail', () => {
    const tail = screen(state({ conversation: lines }), 40, 5)
    expect(tail.lines.join('\n')).toContain('five')
    expect(tail.lines.join('\n')).not.toContain('one')

    const pinned = screen(state({ conversation: lines, scroll: { kind: 'pinned', top: 0 } }), 40, 5)
    expect(pinned.lines.join('\n')).toContain('one')
    expect(pinned.lines.join('\n')).toContain('three')
    expect(pinned.lines.join('\n')).not.toContain('five')
  })

  test('the status line says how far back the window is', () => {
    const read = (top: number): string =>
      screen(state({ conversation: lines, scroll: { kind: 'pinned', top } }), 60, 5).lines[0] ?? ''
    expect(read(0)).toContain('2 lines back')
    expect(read(0)).toContain('Esc')
    expect(read(1)).toContain('1 line back')
    expect(screen(state({ conversation: lines }), 60, 5).lines[0]).not.toContain('line back')
  })

  test('the viewport counts the wrapped lines and the window height', () => {
    expect(viewportOf(state({ conversation: lines }), { columns: 40, rows: 8 })).toEqual({
      lines: 5,
      height: 6,
    })
    // The smallest terminal is the same floor render uses.
    expect(viewportOf(state(), { columns: 40, rows: 1 })).toEqual({ lines: 0, height: 1 })
  })
})
