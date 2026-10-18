/**
 * The composer's drafts, by the session each was typed in. A line belongs to the
 * conversation it was written for: moving to another session must not carry it
 * along, and moving back must bring it back.
 */

/** Where one session's draft waits in the browser's storage. */
export const draftKey = (sessionId: string): string => 'jzh:draft:' + sessionId

/** What a move to `to` shows, and the drafts left for the moves after it. */
export const draftOnMove = (
  drafts: ReadonlyMap<string, string>,
  from: string,
  to: string,
  stored: string,
): { readonly drafts: ReadonlyMap<string, string>; readonly text: string } => {
  const own = drafts.has(to) ? (drafts.get(to) ?? '') : stored
  // A line typed before there is a session is the first session's to receive.
  const carried = from === '' && to !== '' && own === '' ? (drafts.get('') ?? '') : ''
  if (carried === '') return { drafts, text: own }
  const next = new Map(drafts)
  next.delete('')
  next.set(to, carried)
  return { drafts: next, text: carried }
}

/** Remembers one session's line; an emptied line leaves nothing to keep. */
export const drafted = (
  drafts: ReadonlyMap<string, string>,
  sessionId: string,
  text: string,
): ReadonlyMap<string, string> => {
  const next = new Map(drafts)
  if (text === '') next.delete(sessionId)
  else next.set(sessionId, text)
  return next
}
