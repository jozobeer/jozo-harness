import type { PluginRow } from '@jozo-harness/kernel'
import type { SessionSummary } from '@jozo-harness/session'

export { renderTranscript } from '@jozo-harness/session'
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

/** What the list leaves out: empty logs stay out of the way unless asked for. */
export interface SessionListOptions {
  readonly showEmpty?: boolean
}

/**
 * One line per session, most recently changed first: the id it resumes by, when
 * it last changed, where it ran, its name. A session nobody said anything in is
 * hidden unless `showEmpty` asks for it, and the list says how many it hid.
 */
export const renderSessionList = (
  summaries: ReadonlyArray<SessionSummary>,
  options?: SessionListOptions,
): string => {
  const showEmpty = options?.showEmpty === true
  const listed = showEmpty ? summaries : summaries.filter((summary) => summary.empty !== true)
  const hidden = summaries.length - listed.length
  const ordered = [...listed].sort((left, right) => right.updatedAt - left.updatedAt)
  const body = ordered.length === 0 ? 'no sessions yet\n' : ordered.map(lineOf).join('\n') + '\n'
  if (hidden === 0) return body
  const noun = hidden === 1 ? 'session' : 'sessions'
  return body + String(hidden) + ' empty ' + noun + ' hidden; --all shows them\n'
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

/** The header line a browse starts with. */
export const renderSessionHead = (summary: SessionSummary): string =>
  'session ' + summary.id + '\nstarted ' + when(summary.createdAt) + '\ncwd ' + summary.cwd + '\n\n'
