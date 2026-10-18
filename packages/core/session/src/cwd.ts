import type { SessionEvent, SessionHeader } from './events.ts'

/** The working directory in force: the newest change, or the header's. */
export const cwdOf = (events: ReadonlyArray<SessionEvent>, header: SessionHeader): string => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'session/cwd/changed') return event.data.cwd
  }
  return header.cwd
}

/**
 * The workspace root in force: the root the newest change named, or the header's
 * cwd. A worktree moves both at once, so relative paths start in the new tree
 * rather than in the checkout the session started from.
 */
export const rootOf = (events: ReadonlyArray<SessionEvent>, header: SessionHeader): string => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'session/cwd/changed') continue
    if (event.data.root !== undefined) return event.data.root
  }
  return header.cwd
}
