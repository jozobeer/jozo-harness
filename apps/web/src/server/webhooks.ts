import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Schema } from 'effect'

/**
 * One route an external event may start a session on. The path lives under
 * `/hooks/` so the page's own routes never share it, and the secret signs the
 * raw body: a delivery without that signature starts nothing.
 */
export const WebhookRuleSchema = Schema.Struct({
  path: Schema.String.check(Schema.isPattern(/^\/hooks\/[A-Za-z0-9][A-Za-z0-9._-]*$/)),
  /** The workspace the session starts in; it must be one the run may open. */
  cwd: Schema.NonEmptyString,
  /** The instruction the first user message carries ahead of the event summary. */
  prompt: Schema.String,
  /** The shared secret the sender signs the raw body with, as GitHub does. */
  secret: Schema.NonEmptyString,
})

export type WebhookRule = typeof WebhookRuleSchema.Type

/** What one accepted delivery left: the session, or why it could not start. */
export type WebhookStart =
  | { readonly kind: 'started'; readonly sessionId: string }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'timed-out' }

/** The rules this run reads and the one way a delivery turns into a session. */
export interface WebhookGate {
  readonly rules: ReadonlyArray<WebhookRule>
  /** Opens a session in the rule's workspace and submits one turn; never rejects. */
  readonly start: (rule: WebhookRule, prompt: string) => Promise<WebhookStart>
}

/** A larger event is refused before it is parsed; GitHub deliveries stay well below this. */
const BODY_LIMIT = 1024 * 1024

/** A sender that opens a body and then stalls is cut off; GitHub retries a failed delivery. */
const READ_TIMEOUT_MS = 10_000

/** How long a delivery waits for the session to open and take its first turn. */
const START_TIMEOUT_MS = 30_000

/** The prefix GitHub puts on its HMAC-SHA256 header. */
const SIGNATURE_PREFIX = 'sha256='

const refuse = (response: ServerResponse, status: number, body: string): void => {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  response.end(body)
}

const accept = (response: ServerResponse, sessionId: string): void => {
  response.writeHead(202, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify({ sessionId }))
}

type BodyRead =
  | { readonly kind: 'body'; readonly bytes: Buffer }
  | { readonly kind: 'too-large' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'timed-out' }

/** Reads one body as raw bytes, refusing one that fails, stalls, or grows past the cap. */
const readBody = (request: IncomingMessage): Promise<BodyRead> =>
  new Promise((resolve) => {
    const chunks: Array<Buffer> = []
    let bytes = 0
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = (body: BodyRead): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(body)
    }
    timer = setTimeout(() => {
      settle({ kind: 'timed-out' })
      request.destroy()
    }, READ_TIMEOUT_MS)
    let over = false
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > BODY_LIMIT) {
        // The rest is read and dropped, so the refusal still reaches a sender
        // that is mid-write; nothing past the cap is kept.
        over = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () =>
      settle(over ? { kind: 'too-large' } : { kind: 'body', bytes: Buffer.concat(chunks) }),
    )
    request.on('error', () => settle({ kind: 'failed' }))
  })

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** One non-empty string field of a delivery, when it carries one. */
const textOf = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

const nestedText = (record: Readonly<Record<string, unknown>>, key: string): string | undefined => {
  const value = record[key]
  return isRecord(value) ? textOf(value['full_name'] ?? value['login']) : undefined
}

/**
 * What the session reads first about the delivery: the event, its action, the
 * repository, and who sent it. The body itself stays out, because a model turn
 * should see the event as a sentence rather than an untrusted document.
 */
const summaryOf = (event: string, payload: Readonly<Record<string, unknown>>): string => {
  const parts = ['GitHub event ' + JSON.stringify(event)]
  const action = textOf(payload['action'])
  if (action !== undefined) parts.push('action ' + action)
  const repository = nestedText(payload, 'repository')
  if (repository !== undefined) parts.push('repository ' + repository)
  const sender = nestedText(payload, 'sender')
  if (sender !== undefined) parts.push('sent by ' + sender)
  return parts.join(', ')
}

/** Compares the signature against the raw body in constant time; a stray header is no match. */
const signatureMatches = (secret: string, body: Buffer, header: string | undefined): boolean => {
  if (header === undefined || !header.startsWith(SIGNATURE_PREFIX)) return false
  const given = Buffer.from(header.slice(SIGNATURE_PREFIX.length), 'hex')
  // Buffer.from stops at the first non-hex character, so the length is what says
  // whether the header was a full digest at all.
  if (given.length !== 32) return false
  const expected = createHmac('sha256', secret).update(body).digest()
  return timingSafeEqual(given, expected)
}

/** Waits for the session to take its turn, but not forever: a stuck build must not hold the reply. */
const startWithTimeout = async (
  gate: WebhookGate,
  rule: WebhookRule,
  prompt: string,
): Promise<WebhookStart> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<WebhookStart>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timed-out' }), START_TIMEOUT_MS)
    timer.unref()
  })
  try {
    return await Promise.race([gate.start(rule, prompt), timedOut])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** The first user message: the rule's instruction, then what arrived. */
const messageOf = (rule: WebhookRule, summary: string): string => {
  const prompt = rule.prompt.trim()
  return prompt === '' ? summary : prompt + '\n\n' + summary
}

/**
 * Answers a delivery to a configured rule. This route sits outside the page's
 * cookie and origin gate: the sender is a service, not a browser, so the body
 * has to prove itself with the shared secret instead. A path no rule names, a
 * body past the cap or not a JSON object, and a signature that does not match
 * are all refused before a session exists.
 */
export const answerWebhook = async (
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  gate: WebhookGate,
): Promise<boolean> => {
  if (!path.startsWith('/hooks/')) return false
  const rule = gate.rules.find((candidate) => candidate.path === path)
  if (rule === undefined) {
    refuse(response, 404, 'no webhook rule answers this path')
    return true
  }
  if (request.method !== 'POST') {
    refuse(response, 405, 'method not allowed')
    return true
  }
  const body = await readBody(request)
  if (body.kind === 'too-large') {
    // The cap and a body that is not JSON are both the sender's fault, so both
    // answer 400; only the signature is a refusal about identity.
    refuse(response, 400, 'the event is too large')
    return true
  }
  if (body.kind === 'timed-out') {
    refuse(response, 408, 'the event did not arrive in time')
    return true
  }
  if (body.kind === 'failed') {
    refuse(response, 400, 'the event could not be read')
    return true
  }
  const signature = request.headers['x-hub-signature-256']
  if (
    !signatureMatches(
      rule.secret,
      body.bytes,
      typeof signature === 'string' ? signature : undefined,
    )
  ) {
    refuse(response, 401, 'the signature does not match')
    return true
  }
  let payload: unknown
  try {
    payload = JSON.parse(body.bytes.toString('utf8'))
  } catch {
    refuse(response, 400, 'the event is not JSON')
    return true
  }
  if (!isRecord(payload)) {
    refuse(response, 400, 'the event is not a GitHub payload')
    return true
  }
  const event = request.headers['x-github-event']
  const started = await startWithTimeout(
    gate,
    rule,
    messageOf(rule, summaryOf(typeof event === 'string' ? event : 'unknown', payload)),
  )
  if (started.kind === 'timed-out') {
    refuse(response, 504, 'the session did not start in time')
    return true
  }
  if (started.kind === 'unavailable') {
    refuse(response, 502, 'the session could not start')
    return true
  }
  accept(response, started.sessionId)
  return true
}
