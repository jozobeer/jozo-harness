import type { Conversation, ConversationBlock } from '@jozo-harness/ui-view'
import type { WebState } from '../src/ui/state.ts'
import { toolsOf, type TraceTool, type TraceTurn } from '../src/ui/trace.ts'

/** How long ago a session started, the way a rail usually says it. */
export const whenOf = (at: number, now: number): string => {
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return String(minutes) + 'm'
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return String(hours) + 'h'
  if (hours < 48) return 'yesterday'
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** How long something has been running, short enough for the Run pane. */
export const elapsedOf = (at: number, now: number): string => {
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  if (seconds < 60) return String(seconds) + 's'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return String(minutes) + 'm'
  return String(Math.floor(minutes / 60)) + 'h'
}

/** A span of time the way the page says it: 0.3s, 38s, 4m 12s, 1h 03m. */
export const spanOf = (ms: number): string => {
  if (ms < 10_000) return (Math.max(0, ms) / 1000).toFixed(1) + 's'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return String(seconds) + 's'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return String(minutes) + 'm ' + String(seconds % 60).padStart(2, '0') + 's'
  return String(Math.floor(minutes / 60)) + 'h ' + String(minutes % 60).padStart(2, '0') + 'm'
}

export const basenameOf = (path: string): string => {
  const parts = path.split('/')
  return parts[parts.length - 1] ?? path
}

/** The child session one `subagent` result names, as the pipeline writes it. */
const CHILD_MARKER = /\[child session: ([^\]\s]+)\]/g

/** The child sessions a conversation started, oldest first, each named once. */
export const childSessionsOf = (
  blocks: ReadonlyArray<ConversationBlock>,
): ReadonlyArray<string> => [
  ...new Set(
    blocks.flatMap((block) =>
      block.kind === 'tool' && block.name === 'subagent'
        ? [...block.output.matchAll(CHILD_MARKER)].flatMap((match) =>
            match[1] === undefined ? [] : [match[1]],
          )
        : [],
    ),
  ),
]

/** The one line an artifact result writes; text around it means the call published no page. */
const PAGE_LINE = /^page: (\/artifact\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)$/

/** The pages a finished call published, in the order its result names them. */
export const pagesIn = (tool: TraceTool): ReadonlyArray<string> => {
  if (tool.endedAt === undefined) return []
  const output = tool.output.trim()
  const whole = PAGE_LINE.exec(output)
  if (whole?.[1] !== undefined) return [whole[1]]
  // A program publishes pages through nested calls, so their lines sit among
  // the program's output; only run_code reads pages from a longer result.
  if (tool.name !== 'run_code') return []
  return output
    .split('\n')
    .map((line) => PAGE_LINE.exec(line.trim())?.[1])
    .filter((page): page is string => page !== undefined)
}

/** The pages a session's finished calls published, newest first, each once. */
export const pagesOf = (turns: ReadonlyArray<TraceTurn>): ReadonlyArray<string> => {
  const pages = new Set<string>()
  for (const turn of [...turns].reverse()) {
    for (const tool of [...toolsOf(turn)].reverse()) {
      for (const page of pagesIn(tool)) pages.add(page)
    }
  }
  return [...pages]
}

/** What the status strip says the page is doing. */
export const hintOf = (state: WebState): string => {
  if (state.problem !== '') return state.problem
  if (!state.connected) return 'reconnecting…'
  const conversation: Conversation = state.conversation
  if (conversation.approval !== undefined) return 'waiting for your approval'
  if (conversation.ask !== undefined) return 'answer the question and press Enter'
  return conversation.running ? 'working…' : 'ready'
}
