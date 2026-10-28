import { randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * One other browser the owner let into this run. The token is the whole of its
 * credential: whoever opens the link can see the sessions and type at them,
 * exactly as the owner can, until the owner cuts the invitation.
 */
export interface Participant {
  readonly id: string
  readonly label: string
  readonly token: string
  /** When the owner issued it, in ms; the page shows it so a stale invite is visible. */
  readonly joinedAt: number
}

/**
 * The invitations this run has live. It keeps them in memory only: a restart
 * ends every invitation, so a link copied yesterday cannot reopen the run.
 */
export interface ParticipantRegistry {
  /** Issues one invitation; a blank label reads as "guest". */
  readonly issue: (label: string) => Participant
  /** The participant a token names, while the owner has not cut it. */
  readonly find: (token: string | undefined) => Participant | undefined
  /** Every live invitation, oldest first. */
  readonly list: () => ReadonlyArray<Participant>
  /** Cuts one invitation; false when no live one had that id. */
  readonly revoke: (id: string) => boolean
}

/** A blank label still names a row, so the owner sees one row per invitation. */
const labelOf = (label: string): string => {
  const trimmed = label.trim()
  return trimmed === '' ? 'guest' : trimmed
}

/** Compares two tokens without letting the comparison spell out how far it matched. */
const sameToken = (given: string, expected: string): boolean => {
  const offered = Buffer.from(given)
  const wanted = Buffer.from(expected)
  return offered.length === wanted.length && timingSafeEqual(offered, wanted)
}

/**
 * Issues, finds, and cuts invitations. A token is 32 random bytes and never
 * leaves the run except in the link the owner hands over, so a lookup scans the
 * live rows rather than trusting a hash the caller could time.
 */
export const makeParticipantRegistry = (now: () => number): ParticipantRegistry => {
  const live: Array<Participant> = []
  return {
    issue: (label) => {
      const participant: Participant = {
        id: randomBytes(8).toString('hex'),
        label: labelOf(label),
        token: randomBytes(32).toString('hex'),
        joinedAt: now(),
      }
      live.push(participant)
      return participant
    },
    find: (token) => {
      if (token === undefined) return undefined
      return live.find((participant) => sameToken(token, participant.token))
    },
    list: () => [...live],
    revoke: (id) => {
      const index = live.findIndex((participant) => participant.id === id)
      if (index < 0) return false
      live.splice(index, 1)
      return true
    },
  }
}
