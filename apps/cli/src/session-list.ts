import type { PluginRow } from '@jozo-harness/kernel'
import { deriveMessages, type SessionEvent, type SessionSummary } from '@jozo-harness/session'
import { expandHome, type SearchHit } from '@jozo-harness/session-jsonl'

/** Where the session logs live: the profile's row, or the place jozo-harness keeps them. */
export const sessionRootOf = (rows: ReadonlyArray<PluginRow>): string => {
  const row = rows.find(
    (candidate) => candidate.name === '@jozo-harness/session-jsonl' && candidate.disabled !== true,
  )
  const config = row?.config
  const root =
    typeof config === 'object' && config !== null
      ? (config as { readonly root?: unknown }).root
      : undefined
  return expandHome(typeof root === 'string' && root !== '' ? root : '~/.jzh/sessions')
}

const when = (time: number): string => new Date(time).toISOString().replace('T', ' ').slice(0, 19)

/** One line per session, most recently changed first: the id it resumes by, when it last changed, where it ran, its name. */
export const renderSessionList = (summaries: ReadonlyArray<SessionSummary>): string => {
  const ordered = [...summaries].sort((left, right) => right.updatedAt - left.updatedAt)
  if (ordered.length === 0) return 'no sessions yet\n'
  return ordered.map(lineOf).join('\n') + '\n'
}

const lineOf = (summary: SessionSummary): string => {
  const head = summary.id + '  ' + when(summary.updatedAt) + '  ' + summary.cwd
  return summary.title === '' ? head : head + '  ' + summary.title
}

/** One line per hit, with the matching text under it. A search lists sessions, not conversations. */
export const renderSearchHits = (hits: ReadonlyArray<SearchHit>): string => {
  if (hits.length === 0) return 'no matches\n'
  return (
    hits
      .map((hit) => hit.sessionId + '  ' + hit.type + ':' + String(hit.seq) + '  ' + hit.text)
      .join('\n') + '\n'
  )
}

const textOf = (
  content: ReadonlyArray<{ readonly type: string; readonly text?: string }>,
): string =>
  content
    .flatMap((block) => (block.type === 'text' && block.text !== undefined ? [block.text] : []))
    .join('\n')

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

/** The header line a browse starts with. */
export const renderSessionHead = (summary: SessionSummary): string =>
  'session ' + summary.id + '\nstarted ' + when(summary.createdAt) + '\ncwd ' + summary.cwd + '\n\n'
