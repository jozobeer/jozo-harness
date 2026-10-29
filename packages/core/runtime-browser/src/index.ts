import {
  Agents,
  agentsLayer,
  type Agent,
  type AgentError,
  type AgentsShape,
  type AgentRunner,
} from '@jozo-harness/agent'
import { AgentLoop, agentLoopEffect, type AgentLoopConfig } from '@jozo-harness/agent-loop'
import type { FileSystemShape } from '@jozo-harness/filesystem'
import { makeMemoryFileSystem } from '@jozo-harness/filesystem/memory'
import { Hooks, makeHooks, type HookRegistry } from '@jozo-harness/kernel'
import { Llm, type LlmTransport } from '@jozo-harness/llm'
import { deepSeekMessagesAdapter } from '@jozo-harness/llm-deepseek'
import {
  memoryPersistence,
  sessionsLayer,
  type SessionEvent,
  type SessionId,
  type SessionPersistence,
  type Session,
  type SessionError,
} from '@jozo-harness/session'
import { SystemPrompt, makeSystemPrompt, type PromptError } from '@jozo-harness/system-prompt'
import { Tools, makeTools, type ToolError, type ToolRegistry } from '@jozo-harness/tools'
import { browserTools } from '@jozo-harness/tools-tier0/browser'
import { Effect, Layer, type Scope } from 'effect'

/** What the browser assembly needs from its host. Everything else it builds itself. */
export interface BrowserRuntimeOptions {
  /** The workspace root the tools resolve against; defaults to `/workspace`. */
  readonly cwd?: string
  /** `provider/model`, as an agent route names it. */
  readonly route: string
  /** The Messages endpoint the transport posts to. */
  readonly baseUrl: string
  /** The key each request carries; called per attempt, so a host may refresh it. */
  readonly apiKey: () => string | undefined
  /** The one way this runtime reaches the model: fetch in a page, a stub in a test. */
  readonly transport: LlmTransport
  /** The workspace to write into; defaults to a fresh memory store. */
  readonly fileSystem?: FileSystemShape
  /** The log store; defaults to a memory log that dies with the page. */
  readonly persistence?: SessionPersistence
  /** Reads the clock for the session registry; defaults to `Date.now`. */
  readonly now?: () => number
  /** Turn tuning. Defaults to naming off, since a page has no spare model call. */
  readonly config?: AgentLoopConfig
  /** A prompt to use instead of the runtime's own; the caller then owns its sections. */
  readonly systemPrompt?: ReturnType<typeof makeSystemPrompt>
  /** Called for every event the session appends, in seq order. */
  readonly onEvent?: (event: SessionEvent) => void
}

/** The assembled browser runtime. Every tool registration lives until the caller's scope closes. */
export interface BrowserRuntimeShape {
  readonly fileSystem: FileSystemShape
  readonly persistence: SessionPersistence
  readonly tools: ToolRegistry
  readonly agents: AgentsShape
  readonly session: Session
  readonly agent: Agent
  /** Queues one human turn and waits for the runner to become idle again. */
  readonly run: (text: string) => Effect.Effect<void, SessionError>
}

const SYSTEM_PROMPT = [
  'You are jzh, running entirely inside the browser page.',
  'The workspace is an in-memory file system: files you write live until the page closes.',
  'Use the read, write, edit, glob, and grep tools to work in it.',
  'There is no shell, no git, and no process: do not look for bash or run_code.',
].join('\n')

/**
 * Publishes each event the session appends. session/event is an emit-style hook,
 * so the side effect happens in the listener rather than in an effect the
 * dispatcher would run.
 */
const publishEvents = (
  hooks: HookRegistry,
  onEvent: ((event: SessionEvent) => void) | undefined,
): Effect.Effect<void, never, Scope.Scope> =>
  onEvent === undefined
    ? Effect.void
    : hooks.on('session/event', (event: SessionEvent) => {
        onEvent(event)
      })

/** The transport's capabilities on the Messages route: no tool choice, no images. */
const capabilities = {
  toolChoice: false,
  reasoningEffort: null,
  images: 'none',
  promptCacheControl: false,
} as const

/**
 * Builds the browser turn: a memory workspace, the tools that can honour it, one
 * model transport, and a memory session log, all wired through the same Services
 * the Node runtime uses. Nothing here reaches a disk or starts a process; the
 * pieces that still would (spill files, worker packaging) are listed in the design
 * note and stay out of this assembly.
 */
export const browserRuntime = (
  options: BrowserRuntimeOptions,
): Effect.Effect<BrowserRuntimeShape, AgentError | ToolError | PromptError, Scope.Scope> =>
  Effect.gen(function* () {
    const cwd = options.cwd ?? '/workspace'
    const hooks = makeHooks()
    // The listener lives in the caller's scope, so a closed runtime stops
    // publishing before its services are torn down.
    yield* publishEvents(hooks, options.onEvent)
    const tools = makeTools(hooks)
    const prompt = options.systemPrompt ?? makeSystemPrompt()
    if (options.systemPrompt === undefined) {
      yield* prompt.section({ name: 'browser-runtime', order: 0, text: SYSTEM_PROMPT })
    }
    const fileSystem = options.fileSystem ?? makeMemoryFileSystem()
    const persistence = options.persistence ?? memoryPersistence()
    const llm = deepSeekMessagesAdapter({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      transport: options.transport,
      capabilities,
    })
    const services = Layer.mergeAll(
      Layer.succeed(Hooks, hooks),
      Layer.succeed(Tools, tools),
      Layer.succeed(SystemPrompt, prompt),
      Layer.succeed(Llm, llm),
    )
    const runner: AgentRunner = yield* AgentLoop.pipe(
      Effect.provide(
        Layer.provide(
          Layer.effect(AgentLoop, agentLoopEffect(options.config ?? { title: { enabled: false } })),
          services,
        ),
      ),
    )
    const app = Layer.provideMerge(
      Layer.provide(
        agentsLayer(runner),
        sessionsLayer(persistence, { now: options.now ?? Date.now }),
      ),
      Layer.succeed(Hooks, hooks),
    )
    return yield* Effect.provide(
      Effect.gen(function* () {
        yield* Effect.forEach(browserTools(fileSystem), (tool) => tools.register(tool), {
          discard: true,
        })
        const agents = yield* Agents
        const agent = yield* agents.create({
          cwd,
          options: {
            route: options.route,
            spillDir: '/spill',
            attachmentDir: '/attachments',
            maxSpillTokens: Number.MAX_SAFE_INTEGER,
          },
        })
        return {
          fileSystem,
          persistence,
          tools,
          agents,
          session: agent.session,
          agent,
          run: (text: string) =>
            agent.followup({ text, source: 'user' }).pipe(Effect.flatMap(() => agent.whenIdle)),
        }
      }),
      app,
    )
  })

/** What one browser turn leaves behind, readable after its scope has closed. */
export interface BrowserTurnResult {
  readonly sessionId: SessionId
  readonly events: ReadonlyArray<SessionEvent>
  readonly fileSystem: FileSystemShape
  readonly persistence: SessionPersistence
  /** The model-facing tools this turn offered; bash and run_code are absent. */
  readonly tools: ReadonlyArray<string>
}

/**
 * Runs exactly one turn and closes the runtime. The log is read back through the
 * same persistence store, so a caller can prove the turn landed where it will be
 * read from next time.
 */
export const runBrowserTurn = (
  options: BrowserRuntimeOptions,
  text: string,
): Effect.Effect<BrowserTurnResult, AgentError | ToolError | PromptError | SessionError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const runtime = yield* browserRuntime(options)
      return yield* Effect.gen(function* () {
        yield* runtime.run(text)
        return {
          sessionId: runtime.session.id,
          events: runtime.session.events(),
          fileSystem: runtime.fileSystem,
          persistence: runtime.persistence,
          tools: runtime.tools.schemas().map((schema) => schema.name),
        }
      }).pipe(Effect.ensuring(runtime.agents.disposeAll()))
    }),
  )
