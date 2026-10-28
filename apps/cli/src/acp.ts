import { Deferred, Effect, Stream } from 'effect'
import type { Scope } from 'effect'
import type { UiHost } from '@jozo-harness/ui-host'
import {
  DEFAULT_PERMISSION_TIMEOUT_MS,
  type AcpSessionHost,
  type AcpSessionPort,
  type PermissionOption,
  type RequestPermissionParams,
  type SessionPromptResult,
} from '@jozo-harness/acp'

/** One core an editor drives: the session id the log names and the UI face that runs it. */
export interface AcpSessionSourceSession {
  readonly id: string
  readonly host: UiHost
}

/** Builds a session in cwd; the caller's scope owns everything it starts. */
export interface AcpSessionSource {
  readonly open: (cwd: string) => Effect.Effect<AcpSessionSourceSession, Error, Scope.Scope>
}

export interface AcpSessionPortOptions {
  /** How long an editor may sit on a permission card before it counts as refused. */
  readonly permissionTimeoutMs?: number
}

/**
 * The two choices every permission card offers. ACP names the kind so an editor
 * can draw "allow" and "refuse" without reading English.
 */
export const PERMISSION_OPTIONS: ReadonlyArray<PermissionOption> = [
  { optionId: 'allow-once', name: 'Allow this call', kind: 'allow_once' },
  { optionId: 'reject-once', name: 'Refuse this call', kind: 'reject_once' },
]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** True only for the allow choice; a cancelled or malformed answer refuses. */
export const approvedOf = (value: unknown): boolean => {
  if (!isRecord(value)) return false
  const outcome = value['outcome']
  if (!isRecord(outcome) || outcome['outcome'] !== 'selected') return false
  const optionId = outcome['optionId']
  return typeof optionId === 'string' && optionId === 'allow-once'
}

/** The text a settled assistant message carries, or undefined for a tool-only turn. */
const textOf = (data: unknown): string | undefined => {
  if (!isRecord(data)) return undefined
  const content = data['content']
  if (!Array.isArray(content)) return undefined
  const parts: Array<string> = []
  for (const block of content) {
    if (!isRecord(block) || block['type'] !== 'text') continue
    const text = block['text']
    if (typeof text === 'string') parts.push(text)
  }
  return parts.length === 0 ? undefined : parts.join('')
}

/**
 * Turns the UI host of one core into the ACP session an editor drives. The
 * host already owns the wait for an approval; this adapter carries that wait to
 * the editor as a permission request and settles it with the answer or a refusal
 * when the editor stays silent.
 */
export const acpSessionPortOf = (
  source: AcpSessionSource,
  options: AcpSessionPortOptions = {},
): AcpSessionPort => ({
  open: (cwd, client) =>
    Effect.gen(function* () {
      const session = yield* source.open(cwd)
      const permissionTimeoutMs = options.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS
      let turn: Deferred.Deferred<SessionPromptResult> | undefined
      let turnStarted = false
      let cancelled = false

      const settle = (result: SessionPromptResult): Effect.Effect<void> =>
        Effect.gen(function* () {
          const waiting = turn
          if (waiting === undefined) return
          turn = undefined
          turnStarted = false
          yield* Deferred.succeed(waiting, result)
        })

      /** One permission card: the loop waits on the host map while the editor decides. */
      const askPermission = (callId: string, tool: string, reason: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          const params: RequestPermissionParams = {
            sessionId: session.id,
            toolCall: { toolCallId: callId, title: reason === '' ? tool : reason, kind: tool },
            options: PERMISSION_OPTIONS,
          }
          const answer = yield* client
            .request('session/request_permission', params, { timeoutMs: permissionTimeoutMs })
            .pipe(
              // A silent editor is a refusal: the call never reaches the tool.
              Effect.catchTag('AcpTimeout', () => Effect.succeed<unknown>(undefined)),
              Effect.catchTag('AcpRequestFailed', () => Effect.succeed<unknown>(undefined)),
            )
          yield* session.host.approve(callId, approvedOf(answer))
        })

      const onEvent = (event: {
        readonly kind: 'session' | 'stream'
        readonly event?: unknown
      }): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (event.kind !== 'session' || !isRecord(event.event)) return
          const sessionEvent = event.event
          const type = sessionEvent['type']
          if (type === 'turn/start') {
            if (turn !== undefined) turnStarted = true
            return
          }
          if (type === 'turn/end') {
            if (turn === undefined || !turnStarted) return
            yield* settle({ stopReason: cancelled ? 'cancelled' : 'end-turn' })
            return
          }
          if (type === 'assistant/message') {
            if (turn === undefined || !turnStarted) return
            const text = textOf(sessionEvent['data'])
            if (text === undefined) return
            yield* client.notify('session/update', {
              sessionId: session.id,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text },
              },
            })
            return
          }
          if (type === 'safety/approval/requested' && isRecord(sessionEvent['data'])) {
            const data = sessionEvent['data']
            const callId = data['callId']
            const tool = data['tool']
            const reason = data['reason']
            if (typeof callId !== 'string' || typeof tool !== 'string') return
            yield* askPermission(callId, tool, typeof reason === 'string' ? reason : '')
          }
        })

      yield* Stream.runForEach(session.host.events, (event) =>
        onEvent(event as { readonly kind: 'session' | 'stream'; readonly event?: unknown }),
      ).pipe(Effect.forkScoped)

      const host: AcpSessionHost = {
        id: session.id,
        prompt: (text) =>
          Effect.gen(function* () {
            const waiting = yield* Deferred.make<SessionPromptResult>()
            turn = waiting
            turnStarted = false
            cancelled = false
            yield* session.host.submit(text)
            return yield* Deferred.await(waiting)
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                turn = undefined
                turnStarted = false
              }),
            ),
          ),
        cancel: () =>
          Effect.sync(() => {
            cancelled = true
          }).pipe(Effect.flatMap(() => session.host.cancel())),
        close: () => session.host.cancel(),
      }
      return host
    }),
})
