import type { LlmTransport } from '@jozo-harness/llm'
import type { SessionEvent } from '@jozo-harness/session'
import { Effect, Exit, Scope } from 'effect'
import { browserRuntime, type BrowserRuntimeShape } from './index.ts'
import type { WorkerOutgoing } from './worker-protocol.ts'

/** What the worker host needs; the page passes everything a worker cannot fetch. */
export interface BrowserWorkerHostOptions {
  /** `provider/model`, as an agent route names it. */
  readonly route: string
  /** The Messages endpoint the page's transport posts to. */
  readonly baseUrl: string
  /** Called per attempt, so the page can refresh a key it holds. */
  readonly apiKey: () => string | undefined
  /** The one way the worker reaches the model: fetch in a page, a stub in a test. */
  readonly transport: LlmTransport
  /** Where the host writes its messages; the worker entry passes `postMessage`. */
  readonly post: (message: WorkerOutgoing) => void
  /** The workspace root the tools resolve against; defaults to `/workspace`. */
  readonly cwd?: string
  /** Reads the clock for the session log; defaults to `Date.now`. */
  readonly now?: () => number
}

/** One worker's runtime, kept across turns and dropped when the worker closes. */
export interface BrowserWorkerHost {
  /** Runs one turn, emitting its events before `done` or `error`. Turns queue. */
  readonly prompt: (text: string) => Promise<void>
  /** Ends the workspace and the log with the worker. */
  readonly close: () => Promise<void>
}

/** The assistant's last message, which is the answer a page shows when the turn ends. */
const answerOf = (events: ReadonlyArray<SessionEvent>): string => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'assistant/message') continue
    return event.data.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
  }
  return ''
}

/** Why the last turn ended in an error, when it did. */
const failureOf = (events: ReadonlyArray<SessionEvent>): string | undefined => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'turn/end') continue
    const reason = event.data.reason
    return reason.kind === 'error' ? reason.failure.message : undefined
  }
  return undefined
}

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

/**
 * Holds one browser runtime for the life of a worker. The workspace and the log
 * live in this closure, so terminating the worker is what erases them; the page
 * cannot keep them by accident.
 */
export const createBrowserWorkerHost = (options: BrowserWorkerHostOptions): BrowserWorkerHost => {
  const scope = Scope.makeUnsafe()
  let runtime: BrowserRuntimeShape | undefined
  let closed = false
  // The runtime is shared, so turns must not overlap: a page that sends two
  // prompts gets two answers in order rather than a log with interleaved turns.
  let queue: Promise<void> = Promise.resolve()

  const build = async (): Promise<BrowserRuntimeShape> => {
    if (runtime !== undefined) return runtime
    if (closed) throw new Error('the browser worker is closed')
    try {
      const built = await Effect.runPromise(
        browserRuntime({
          route: options.route,
          baseUrl: options.baseUrl,
          apiKey: options.apiKey,
          transport: options.transport,
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options.now === undefined ? {} : { now: options.now }),
          onEvent: (event) => options.post({ kind: 'event', event }),
        }).pipe(Effect.provideService(Scope.Scope, scope)),
      )
      runtime = built
      return built
    } catch (cause) {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      closed = true
      throw cause
    }
  }

  const run = async (text: string): Promise<void> => {
    try {
      const active = await build()
      await Effect.runPromise(active.run(text))
      const events = active.session.events()
      const failure = failureOf(events)
      if (failure === undefined) options.post({ kind: 'done', text: answerOf(events) })
      else options.post({ kind: 'error', message: failure })
    } catch (cause) {
      options.post({ kind: 'error', message: messageOf(cause) })
    }
  }

  return {
    prompt: (text: string): Promise<void> => {
      const turn = queue.then(() => run(text))
      queue = turn.catch(() => undefined)
      return turn
    },
    close: async (): Promise<void> => {
      if (closed) return
      closed = true
      await queue.catch(() => undefined)
      if (runtime !== undefined) {
        await Effect.runPromise(runtime.agents.disposeAll())
      }
      await Effect.runPromise(Scope.close(scope, Exit.void))
    },
  }
}
