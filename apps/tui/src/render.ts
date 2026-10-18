import {
  plainText,
  summaryBodyOf,
  type Conversation,
  type ConversationBlock,
  type NoticeLevel,
} from '@jozo-harness/ui-view'
import type { TuiState } from './state.ts'
import { linesBelow, windowTop, type Viewport } from './scroll.ts'
import { clipText, displayWidth, wrapText, type Size } from './wrap.ts'

export interface Screen {
  readonly lines: ReadonlyArray<string>
  readonly cursor: { readonly row: number; readonly column: number }
}

export interface RenderOptions {
  readonly color?: boolean
}

type Tone = 'plain' | 'dim' | 'user' | 'tool' | 'error' | 'warn' | 'ask' | 'live' | 'title'

interface DisplayLine {
  readonly text: string
  readonly tone: Tone
}

const RESET = '\u001b[0m'
const CODES: Record<Tone, string> = {
  plain: '',
  dim: '\u001b[2m',
  user: '\u001b[36m',
  tool: '\u001b[32m',
  error: '\u001b[31m',
  warn: '\u001b[33m',
  ask: '\u001b[35m',
  live: '\u001b[2m',
  title: '\u001b[1m',
}

const paint = (line: DisplayLine, color: boolean): string =>
  color && CODES[line.tone] !== '' ? CODES[line.tone] + line.text + RESET : line.text

const noticeTone = (level: NoticeLevel): Tone =>
  level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'dim'

const wrapped = (text: string, width: number, tone: Tone): ReadonlyArray<DisplayLine> =>
  wrapText(plainText(text), width).map((line) => ({ text: line, tone }))

const prefixed = (
  prefix: string,
  text: string,
  width: number,
  tone: Tone,
): ReadonlyArray<DisplayLine> => {
  const body = wrapped(text, Math.max(1, width - displayWidth(prefix)), tone)
  const pad = ' '.repeat(displayWidth(prefix))
  return body.map((line, index) => ({
    text: (index === 0 ? prefix : pad) + line.text,
    tone: line.tone,
  }))
}

const toolLines = (
  block: Extract<ConversationBlock, { kind: 'tool' }>,
  width: number,
): ReadonlyArray<DisplayLine> => {
  const head: DisplayLine = {
    text: clipText('⏺ ' + block.name + ' ' + summaryBodyOf(block.name, block.summary), width),
    tone: block.status === 'error' ? 'error' : 'tool',
  }
  if (block.result === '') return [head]
  return [
    head,
    ...prefixed('  └ ', block.result, width, block.status === 'error' ? 'error' : 'dim'),
  ]
}

const blockLines = (block: ConversationBlock, width: number): ReadonlyArray<DisplayLine> => {
  switch (block.kind) {
    case 'user':
      return prefixed('› ', block.text, width, 'user')
    case 'assistant':
      return wrapped(block.text, width, 'plain')
    case 'tool':
      return toolLines(block, width)
    case 'ask':
      return [
        ...prefixed('? ', block.question, width, 'ask'),
        ...(block.answer === undefined ? [] : prefixed('  = ', block.answer, width, 'dim')),
      ]
    case 'notice':
      return prefixed('· ', block.text, width, noticeTone(block.level))
  }
}

const conversationLines = (state: TuiState, width: number): ReadonlyArray<DisplayLine> => [
  ...state.conversation.blocks.flatMap((block) => blockLines(block, width)),
  ...(state.conversation.live === '' ? [] : wrapped(state.conversation.live, width, 'live')),
]

const hintOf = (conversation: Conversation, back: number): string => {
  if (conversation.approval !== undefined) return 'approval: y/n'
  if (conversation.ask !== undefined) return 'question: Enter'
  if (back > 0) return (back === 1 ? '1 line back' : back + ' lines back') + ' (Esc: tail)'
  return conversation.running ? 'working…' : 'idle'
}

const statusLine = (state: TuiState, width: number, viewport: Viewport): DisplayLine => {
  const left = clipText(plainText(state.title), width)
  const hint = hintOf(state.conversation, linesBelow(state.scroll, viewport))
  const gap = Math.max(1, width - displayWidth(left) - displayWidth(hint))
  return { text: clipText(left + ' '.repeat(gap) + hint, width), tone: 'title' }
}

interface Prompt {
  readonly prefix: string
  readonly tone: Tone
  readonly modal: boolean
}

const promptOf = (conversation: Conversation): Prompt => {
  if (conversation.approval !== undefined) {
    return {
      prefix: '⚠ approve ' + conversation.approval.tool + '? [y/n] ',
      tone: 'warn',
      modal: true,
    }
  }
  return conversation.ask !== undefined
    ? { prefix: '? ', tone: 'ask', modal: false }
    : { prefix: '› ', tone: 'plain', modal: false }
}

const inputLine = (state: TuiState, width: number): { line: DisplayLine; column: number } => {
  const prompt = promptOf(state.conversation)
  const text = prompt.modal ? '' : plainText(state.editor.text)
  const before = prompt.modal
    ? prompt.prefix
    : prompt.prefix + plainText(state.editor.text.slice(0, state.editor.cursor))
  return {
    line: { text: clipText(prompt.prefix + text, width), tone: prompt.tone },
    column: Math.max(0, Math.min(width - 1, displayWidth(before))),
  }
}

/** The smallest terminal the screen is drawn for. */
const MIN_COLUMNS = 20
const MIN_ROWS = 3

interface Layout {
  readonly columns: number
  readonly rows: number
  readonly content: ReadonlyArray<DisplayLine>
  readonly viewport: Viewport
}

const layoutOf = (state: TuiState, size: Size): Layout => {
  const columns = Math.max(MIN_COLUMNS, size.columns)
  const rows = Math.max(MIN_ROWS, size.rows)
  const content = conversationLines(state, columns)
  return { columns, rows, content, viewport: { lines: content.length, height: rows - 2 } }
}

/** The room the conversation has, for the keys that scroll it. */
export const viewportOf = (state: TuiState, size: Size): Viewport => layoutOf(state, size).viewport

/** Builds a full screen: status, conversation window, input, and a cursor position. */
export const render = (state: TuiState, size: Size, options?: RenderOptions): Screen => {
  const color = options?.color ?? true
  const { columns, rows, content, viewport } = layoutOf(state, size)
  const top = windowTop(state.scroll, viewport)
  const body = content.slice(top, top + viewport.height)
  const blank: DisplayLine = { text: '', tone: 'plain' }
  const blanks = Array.from({ length: viewport.height - body.length }, () => blank)
  const input = inputLine(state, columns)
  const display = [statusLine(state, columns, viewport), ...blanks, ...body, input.line]
  return {
    lines: display.map((line) => paint({ ...line, text: clipText(line.text, columns) }, color)),
    cursor: { row: rows - 1, column: input.column },
  }
}

/** The bytes that repaint the whole screen and park the cursor. */
export const screenText = (screen: Screen): string =>
  '\u001b[H' +
  screen.lines.map((line) => line + '\u001b[K').join('\r\n') +
  '\u001b[' +
  String(screen.cursor.row + 1) +
  ';' +
  String(screen.cursor.column + 1) +
  'H'
