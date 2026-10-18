import type { ContentBlock } from '@jozo-harness/llm'
import type { ApprovalRequested, AskRequested } from '@jozo-harness/safety'
import type { SessionEvent } from '@jozo-harness/session'
import {
  sessionEventOf,
  type UiEvent,
  type UiSessionEvent,
  type UiStreamChunk,
} from '@jozo-harness/ui-protocol'
import { firstLine, oneLine, truncate } from './text.ts'

export type NoticeLevel = 'info' | 'warn' | 'error'
export type ToolStatus = 'running' | 'done' | 'error'

/** One rendered piece of the conversation. Views choose how to draw them. */
export type ConversationBlock =
  | { readonly kind: 'user'; readonly text: string }
  | { readonly kind: 'assistant'; readonly text: string }
  | {
      readonly kind: 'tool'
      readonly callId: string
      readonly name: string
      readonly summary: string
      readonly status: ToolStatus
      readonly result: string
      /** The whole body the result carried; a view may expand it where the summary is one line. */
      readonly output: string
    }
  | {
      readonly kind: 'ask'
      readonly id: string
      readonly question: string
      readonly options: ReadonlyArray<string>
      /** The answer once the human gave one; undefined while the question waits. */
      readonly answer: string | undefined
    }
  | { readonly kind: 'notice'; readonly level: NoticeLevel; readonly text: string }

/** Everything a UI derives from the event stream. No I/O, no timers. */
export interface Conversation {
  readonly blocks: ReadonlyArray<ConversationBlock>
  /** Text streamed for the step that has not settled yet. */
  readonly live: string
  /** Newest applied `seq`; the transport may replay a boundary event twice. */
  readonly lastSeq: number
  readonly running: boolean
  readonly approval: ApprovalRequested | undefined
  readonly ask: AskRequested | undefined
}

export const emptyConversation: Conversation = {
  blocks: [],
  live: '',
  lastSeq: 0,
  running: false,
  approval: undefined,
  ask: undefined,
}

const notice = (state: Conversation, level: NoticeLevel, text: string): Conversation => ({
  ...state,
  blocks: [...state.blocks, { kind: 'notice', level, text }],
})

const textOf = (content: ReadonlyArray<ContentBlock>): string =>
  content
    .flatMap((block) => (block.type === 'text' ? [block.text.trim()] : []))
    .filter((text) => text !== '')
    .join('\n\n')

/** How much of one result a view may carry: a page stays bounded even after a huge read. */
const OUTPUT_LIMIT = 16_384

const resultOf = (content: ReadonlyArray<ContentBlock>): string =>
  truncate(firstLine(textOf(content)), 200)

const outputOf = (content: ReadonlyArray<ContentBlock>): string =>
  truncate(textOf(content), OUTPUT_LIMIT)

/** The event types each handler owns; a type the tables do not name goes to the generic view. */
const STEP_TYPES: ReadonlySet<string> = new Set([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
])
const MESSAGE_TYPES: ReadonlySet<string> = new Set(['user/message', 'assistant/message'])
const TOOL_TYPES: ReadonlySet<string> = new Set(['tool/call', 'tool/result'])
const COMMAND_TYPES: ReadonlySet<string> = new Set(['command/run', 'command/done'])

type StepEvent = Extract<
  SessionEvent,
  { type: 'turn/start' | 'turn/end' | 'step/start' | 'step/end' }
>

const applyTurn = (state: Conversation, event: StepEvent): Conversation => {
  switch (event.type) {
    case 'turn/start':
      return { ...state, running: true, live: '' }
    case 'turn/end': {
      const ended = { ...state, running: false, live: '', approval: undefined, ask: undefined }
      const reason = event.data.reason
      if (reason.kind === 'error') {
        return notice(ended, 'error', reason.failure.code + ': ' + reason.failure.message)
      }
      if (reason.kind === 'max-tokens') {
        return notice(ended, 'warn', 'the answer reached the token cap')
      }
      return reason.kind === 'cancelled' ? notice(ended, 'info', 'cancelled') : ended
    }
    case 'step/start':
      return { ...state, live: '' }
    case 'step/end':
      return state
  }
}

type MessageEvent = Extract<SessionEvent, { type: 'user/message' | 'assistant/message' }>

const applyMessage = (state: Conversation, event: MessageEvent): Conversation => {
  switch (event.type) {
    case 'user/message':
      return event.data.source === 'user'
        ? { ...state, blocks: [...state.blocks, { kind: 'user', text: event.data.text }] }
        : state
    case 'assistant/message': {
      const text = textOf(event.data.content)
      return text === ''
        ? { ...state, live: '' }
        : {
            ...state,
            live: '',
            blocks: [...state.blocks, { kind: 'assistant', text }],
          }
    }
  }
}

type ToolEvent = Extract<SessionEvent, { type: 'tool/call' | 'tool/result' }>

/** The line the pipeline rendered, or one made here for a log written before it did. */
const recordedOr = (summary: string | undefined, fallback: () => string): string =>
  summary === undefined || summary === '' ? fallback() : summary

const callBlock = (data: {
  readonly callId: string
  readonly name: string
  readonly arguments: string
  readonly summary?: string
}): ConversationBlock => ({
  kind: 'tool',
  callId: data.callId,
  name: data.name,
  summary: recordedOr(data.summary, () => truncate(oneLine(data.arguments), 80)),
  status: 'running',
  result: '',
  output: '',
})

const applyTool = (state: Conversation, event: ToolEvent): Conversation => {
  if (event.type === 'tool/call') {
    return { ...state, blocks: [...state.blocks, callBlock(event.data)] }
  }
  const { callId, isError } = event.data
  const result = recordedOr(event.data.summary, () => resultOf(event.data.content))
  const output = outputOf(event.data.content)
  const status: ToolStatus = isError ? 'error' : 'done'
  return {
    ...state,
    blocks: state.blocks.map((block) =>
      block.kind === 'tool' && block.callId === callId
        ? { ...block, status, result, output }
        : block,
    ),
  }
}

/** Events a UI shows without a model turn: approvals, questions, cwd moves. */
const askBlock = (request: AskRequested): ConversationBlock => ({
  kind: 'ask',
  id: request.id,
  question: request.question,
  options: request.options,
  answer: undefined,
})

/** Records the answer on the block that asked, and stops the question from waiting. */
const settleAsk = (
  state: Conversation,
  answered: { readonly id: string; readonly answer: string },
): Conversation => ({
  ...state,
  ask: state.ask?.id === answered.id ? undefined : state.ask,
  blocks: state.blocks.map((block) =>
    block.kind === 'ask' && block.id === answered.id
      ? { ...block, answer: answered.answer }
      : block,
  ),
})

const applyInteraction = (state: Conversation, event: SessionEvent): Conversation => {
  switch (event.type) {
    case 'safety/approval/requested':
      return notice(
        { ...state, approval: event.data },
        'warn',
        'approval required: ' + event.data.tool + ' (' + event.data.reason + ')',
      )
    case 'safety/approval/answered':
      return state.approval?.callId === event.data.callId
        ? { ...state, approval: undefined }
        : state
    case 'interaction/ask/requested':
      // The question stays where it was asked: the card below is only the way to answer it now.
      return {
        ...state,
        ask: event.data,
        blocks: [...state.blocks, askBlock(event.data)],
      }
    case 'interaction/ask/answered':
      return settleAsk(state, event.data)
    case 'session/cwd/changed':
      return notice(state, 'info', 'cwd: ' + event.data.cwd)
    default:
      return state
  }
}

type CommandEvent = Extract<SessionEvent, { type: 'command/run' | 'command/done' }>

/** A command is the human talking to the session: what was typed, then what came back. */
const applyCommand = (state: Conversation, event: CommandEvent): Conversation =>
  event.type === 'command/run'
    ? notice(
        state,
        'info',
        '/' + event.data.name + (event.data.input === '' ? '' : ' ' + event.data.input),
      )
    : notice(state, event.data.ok ? 'info' : 'error', event.data.text)

const applySession = (state: Conversation, raw: UiSessionEvent): Conversation => {
  if (raw.seq <= state.lastSeq) return state
  const event = sessionEventOf(raw)
  const opened = { ...state, lastSeq: raw.seq }
  // One family per handler; an event no family claims goes to the generic view.
  if (STEP_TYPES.has(event.type)) return applyTurn(opened, event as StepEvent)
  if (MESSAGE_TYPES.has(event.type)) return applyMessage(opened, event as MessageEvent)
  if (TOOL_TYPES.has(event.type)) return applyTool(opened, event as ToolEvent)
  if (COMMAND_TYPES.has(event.type)) return applyCommand(opened, event as CommandEvent)
  return applyInteraction(opened, event)
}

const applyStream = (state: Conversation, chunk: UiStreamChunk): Conversation =>
  chunk.chunk.type === 'text-delta' && chunk.chunk.text !== ''
    ? { ...state, live: state.live + chunk.chunk.text }
    : state

/** Folds one UI event into the conversation. Pure: the same input gives the same state. */
export const applyEvent = (state: Conversation, event: UiEvent): Conversation =>
  event.kind === 'stream' ? applyStream(state, event.chunk) : applySession(state, event.event)
