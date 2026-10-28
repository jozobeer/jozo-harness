import type { ContentBlock } from '@jozo-harness/llm'
import { deriveMessages } from './derive.ts'
import type { SessionEvent } from './events.ts'

/** What one message contributes as prose: every text block, joined as paragraphs. */
const textOf = (content: ReadonlyArray<ContentBlock>): string =>
  content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')

/** The tool calls one assistant message asked for, in the order it asked. */
const callsOf = (
  content: ReadonlyArray<ContentBlock>,
): ReadonlyArray<{ readonly name: string; readonly arguments: string }> =>
  content.flatMap((block) =>
    block.type === 'tool-call' ? [{ name: block.name, arguments: block.arguments }] : [],
  )

/**
 * A session as it is read back: the messages the log folds to, one per paragraph.
 * Tool messages name the call they answer, so a transcript shows what was done.
 */
export const renderTranscript = (events: ReadonlyArray<SessionEvent>): string => {
  const lines = deriveMessages(events).flatMap((message) => {
    const text = textOf(message.content)
    if (text.trim() === '') return []
    if (message.role === 'tool') return ['[tool result] ' + text]
    if (message.role === 'assistant') return ['[assistant] ' + text]
    if (message.role === 'user') return ['[user] ' + text]
    return ['[' + message.role + '] ' + text]
  })
  return lines.length === 0 ? '(nothing was said yet)\n' : lines.join('\n\n') + '\n'
}

/** One fence long enough that the text it wraps cannot end it early. */
const fenceFor = (text: string): string => {
  let fence = '```'
  while (text.includes(fence)) fence += '`'
  return fence
}

/** A block a reader can copy without guessing where it ends. */
const fenced = (language: string, text: string): string => {
  const fence = fenceFor(text)
  return fence + language + '\n' + text + '\n' + fence
}

/** The heading a role reads as in Markdown; tool output is never the human's words. */
const headingOf = (role: string): string => {
  if (role === 'user') return '## User'
  if (role === 'assistant') return '## Assistant'
  if (role === 'system') return '## System'
  return '## ' + role
}

/**
 * The same fold as `renderTranscript`, written as Markdown: the human's words and
 * the assistant's prose stand as sections, and every tool call and result sits in
 * a fence under its own heading, so a reader can tell who said what.
 */
export const renderTranscriptMarkdown = (events: ReadonlyArray<SessionEvent>): string => {
  const sections = deriveMessages(events).flatMap((message) => {
    const text = textOf(message.content).trim()
    const calls = callsOf(message.content)
    if (text === '' && calls.length === 0) return []
    if (message.role === 'tool') {
      return [
        ['## Tool result', text === '' ? '' : fenced('text', text)]
          .filter((part) => part !== '')
          .join('\n\n'),
      ]
    }
    const parts = [headingOf(message.role)]
    if (text !== '') parts.push(text)
    for (const call of calls) {
      parts.push('### Tool call `' + call.name + '`', fenced('json', call.arguments))
    }
    return [parts.join('\n\n')]
  })
  return sections.length === 0 ? '(nothing was said yet)\n' : sections.join('\n\n') + '\n'
}
