import type { IncomingMessage, ServerResponse } from 'node:http'
import { ownerAuthorized, refusedBy, type RequestGate } from './auth.ts'
import type { Participant, ParticipantRegistry } from './participants.ts'

/** Where the owner's page asks for invitations, and cuts one by its id. */
export const SHARE_PATH = '/share'

/** One invitation as the owner's page lists it; the url is the one to hand over. */
export interface SharedParticipant {
  readonly id: string
  readonly label: string
  readonly joinedAt: number
  readonly url: string
}

const refuse = (response: ServerResponse, status: number, message: string): void => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify({ error: message }))
}

const answer = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(body))
}

const isSharePath = (path: string): boolean =>
  path === SHARE_PATH || path.startsWith(SHARE_PATH + '/')

/** The id a cut names, or undefined for the list and issue routes. */
const invitationIdOf = (path: string): string | undefined =>
  path.startsWith(SHARE_PATH + '/')
    ? decodeURIComponent(path.slice(SHARE_PATH.length + 1))
    : undefined

const labelOf = (request: IncomingMessage): string =>
  new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('label') ?? ''

/**
 * The link to hand over. It names the host the owner is already using, so a page
 * opened on loopback hands over a loopback link and one opened on the tailnet
 * hands over the address the colleague can reach.
 */
const joinUrlOf = (request: IncomingMessage, gate: RequestGate, token: string): string => {
  const host = request.headers.host ?? ''
  const secure =
    gate.publicOrigin !== undefined && host.toLowerCase() === gate.publicOrigin.host.toLowerCase()
  return (secure ? 'https' : 'http') + '://' + host + '/?join=' + token
}

const sharedOf = (
  request: IncomingMessage,
  gate: RequestGate,
  participant: Participant,
): SharedParticipant => ({
  id: participant.id,
  label: participant.label,
  joinedAt: participant.joinedAt,
  url: joinUrlOf(request, gate, participant.token),
})

/** Lists the live invitations with a link for each. */
const answerList = (
  request: IncomingMessage,
  response: ServerResponse,
  gate: RequestGate,
  participants: ParticipantRegistry,
): void => {
  answer(response, 200, {
    items: participants.list().map((participant) => sharedOf(request, gate, participant)),
  })
}

/** Issues one invitation for the label the owner typed; a blank one reads as guest. */
const answerIssue = (
  request: IncomingMessage,
  response: ServerResponse,
  gate: RequestGate,
  participants: ParticipantRegistry,
): void => {
  answer(response, 201, sharedOf(request, gate, participants.issue(labelOf(request))))
}

/** Cuts one invitation, and ends the sockets that joined through it. */
const answerRevoke = (
  response: ServerResponse,
  id: string,
  participants: ParticipantRegistry,
  onRevoked: (id: string) => void,
): void => {
  if (id === '' || !participants.revoke(id)) {
    refuse(response, 404, 'no live invitation has that id')
    return
  }
  onRevoked(id)
  answer(response, 200, { revoked: id })
}

/**
 * True when the request may not share: not from the page's origin, not carrying
 * a credential at all, or carrying a participant's rather than the run's own.
 */
const ownerRefused = (
  request: IncomingMessage,
  response: ServerResponse,
  gate: RequestGate,
): boolean => {
  const refusal = refusedBy(request, gate)
  if (refusal !== undefined) {
    refuse(response, refusal.status, refusal.message)
    return true
  }
  if (ownerAuthorized(request.url ?? '', request.headers.cookie, gate)) return false
  refuse(response, 403, 'only the owner may share this run')
  return true
}

/** Answers the one method the share route allows: list, issue, or cut. */
const answerMethod = (
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  participants: ParticipantRegistry,
  gate: RequestGate,
  onRevoked: (id: string) => void,
): void => {
  const id = request.method === 'DELETE' ? invitationIdOf(path) : undefined
  if (request.method === 'GET' && path === SHARE_PATH) {
    answerList(request, response, gate, participants)
    return
  }
  if (request.method === 'POST' && path === SHARE_PATH) {
    answerIssue(request, response, gate, participants)
    return
  }
  if (id !== undefined) {
    answerRevoke(response, id, participants, onRevoked)
    return
  }
  refuse(response, 405, 'method not allowed')
}

/**
 * Answers the owner's share requests: list, issue, cut. It refuses a participant
 * before reading a method, so an invitation can be used but never passed on.
 * Returns false for a path that is not the share route.
 */
export const answerShare = async (
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  participants: ParticipantRegistry,
  gate: RequestGate,
  onRevoked: (id: string) => void,
): Promise<boolean> => {
  if (!isSharePath(path)) return false
  if (ownerRefused(request, response, gate)) return true
  answerMethod(request, response, path, participants, gate, onRevoked)
  return true
}
