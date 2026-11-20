import {
  cwdOf,
  titleOf,
  type SessionEvent,
  type SessionHeader,
  type SessionSummary,
} from '@jozo-harness/session'

/** The log a page's summary is read from. Events are read again on each access. */
export interface PageSession {
  readonly id: string
  readonly header: SessionHeader
  events(): ReadonlyArray<SessionEvent>
}

/**
 * The summary the web page reads. The directory, the title, and the last write
 * are taken from the log at the moment something asks: file reads, Open in App,
 * and @ references all use that directory, and a copy taken when the session
 * opened would leave them on the checkout a later working_directory left.
 */
export const pageSummary = (session: PageSession): SessionSummary => ({
  id: session.id,
  get cwd() {
    return cwdOf(session.events(), session.header)
  },
  createdAt: session.header.createdAt,
  get updatedAt() {
    const events = session.events()
    const last = events.at(-1)
    return last === undefined ? session.header.createdAt : last.time
  },
  get title() {
    return titleOf(session.events())
  },
})
