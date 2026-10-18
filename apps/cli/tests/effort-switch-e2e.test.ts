import { agentPlugin } from '@jozo-harness/agent'
import { agentLoopPlugin } from '@jozo-harness/agent-loop'
import { kernelPlugin, type Plugin } from '@jozo-harness/kernel'
import { Llm, type LlmAdapter, type StreamChunk } from '@jozo-harness/llm'
import { safetyPlugin } from '@jozo-harness/safety'
import { sessionPlugin, type SessionId } from '@jozo-harness/session'
import { sessionJsonlPlugin } from '@jozo-harness/session-jsonl'
import { systemPromptPlugin } from '@jozo-harness/system-prompt'
import { toolsPlugin } from '@jozo-harness/tools'
import { tier0Plugin } from '@jozo-harness/tools-tier0'
import { Deferred, Effect, Layer, Schema, Stream, type Scope } from 'effect'
import { RpcClient, RpcSerialization } from 'effect/rpc'
import { Socket } from 'effect/socket'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'
import { UiRpcs, withoutServices } from '@jozo-harness/web'
import { runCommand } from '../src/index.ts'

/**
 * The effort a page switches a running session to. A session is opened and
 * switched through the browser UI's own RPC, and what the provider receives is
 * read from the adapter, so the whole path is the one a page drives.
 */

const textTurn = (text: string): ReadonlyArray<StreamChunk> => [
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', kind: 'stop' },
]

/** Records the params of every request, as the provider received them. */
const spy = (sent: Array<Readonly<Record<string, unknown>>>): Plugin<{}, Llm, never> => ({
  name: 'stub-llm',
  config: Schema.Struct({}),
  provides: [Llm],
  requires: [],
  layer: () =>
    Layer.succeed(Llm, {
      name: 'stub',
      capabilities: {
        toolChoice: false,
        // The words this endpoint takes, which a page offers as the choices.
        reasoningEffort: ['low', 'high'],
        images: 'none',
        promptCacheControl: false,
      },
      stream: (request) => {
        sent.push(request.params as Readonly<Record<string, unknown>>)
        return Stream.fromIterable(textTurn('ok'))
      },
    } satisfies LlmAdapter),
})

const profile = (root: string): string =>
  [
    'name: test',
    'plugins:',
    '  - id: kernel',
    "    name: '@jozo-harness/kernel'",
    '  - id: sessions',
    "    name: '@jozo-harness/session'",
    '  - id: session-jsonl',
    "    name: '@jozo-harness/session-jsonl'",
    '    config:',
    '      root: ' + root,
    '  - id: tools',
    "    name: '@jozo-harness/tools'",
    '  - id: system-prompt',
    "    name: '@jozo-harness/system-prompt'",
    '  - id: safety',
    "    name: '@jozo-harness/safety'",
    '    config:',
    '      preset: workspace-write',
    '      sandbox: none',
    '  - id: tier0',
    "    name: '@jozo-harness/tools-tier0'",
    '  - id: llm',
    '    name: stub-llm',
    '  - id: agent',
    "    name: '@jozo-harness/agent'",
    '  - id: agent-loop',
    "    name: '@jozo-harness/agent-loop'",
  ].join('\n')

const plugins: ReadonlyArray<Plugin<any, any, any>> = [
  kernelPlugin,
  sessionJsonlPlugin,
  sessionPlugin,
  toolsPlugin,
  systemPromptPlugin,
  safetyPlugin,
  tier0Plugin,
  agentPlugin,
  agentLoopPlugin,
]

/** A directory the server will serve; only its index.html is ever read. */
const staticRootOf = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'jozo-harness-effort-page-'))
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'index.html'), '<title>jozo-harness</title>')
  return root
}

/** The client layers every page's socket needs, as the tests that drive one use them. */
const clientLayers =
  (wsUrl: string) =>
  <A, E>(self: Effect.Effect<A, E, unknown>): Effect.Effect<A, E> =>
    self.pipe(
      Effect.provide(RpcClient.layerProtocolSocket()),
      Effect.provide(Socket.layerWebSocket(wsUrl)),
      Effect.provide(Socket.layerWebSocketConstructorGlobal),
      Effect.provide(RpcSerialization.layerJson),
    ) as Effect.Effect<A, E>

interface Place {
  readonly root: string
  readonly workspace: string
  readonly staticRoot: string
  /** The effort the run resolved, which the sessions it opens start from. */
  readonly effort?: string
  /** The session this run serves instead of opening a fresh one. */
  readonly resume?: SessionId
}

/**
 * Runs the command with the browser UI for as long as the body takes, and hands
 * the body the socket a page would use. The caller reads what the provider was
 * sent from the array its own spy filled.
 */
const served = <A, E>(
  place: Place,
  sent: Array<Readonly<Record<string, unknown>>>,
  body: (wsUrl: string) => Effect.Effect<A, E, Scope.Scope>,
): Effect.Effect<A, E> =>
  Effect.scoped(
    Effect.gen(function* () {
      const ready = yield* Deferred.make<string>()
      const stop = yield* Deferred.make<void>()
      yield* Effect.forkScoped(
        runCommand({
          profiles: [profile(place.root)],
          plugins: [...plugins, spy(sent)],
          cwd: place.workspace,
          route: 'stub/model',
          ...(place.effort === undefined ? {} : { effort: place.effort }),
          ...(place.resume === undefined ? {} : { resume: place.resume }),
          web: { port: 0, staticRoot: place.staticRoot },
          stdout: () => undefined,
          stderr: (text) => {
            const match = /http:\/\/127\.0\.0\.1:\d+\/\S*/.exec(text)
            if (match !== null) void Effect.runSync(Deferred.succeed(ready, match[0]))
          },
          interrupt: Deferred.await(stop),
        }),
      )
      const page = new URL(yield* Deferred.await(ready))
      const result = yield* body(
        'ws://' + page.host + '/ui?token=' + (page.searchParams.get('token') ?? ''),
      )
      yield* Deferred.succeed(stop, undefined)
      return result
    }),
  )

/** One session switched, read back, and asked for one turn through the page's RPC. */
const switched = (place: Place, sent: Array<Readonly<Record<string, unknown>>>) =>
  served(place, sent, (wsUrl) =>
    withoutServices(
      Effect.gen(function* () {
        const client = yield* RpcClient.make(UiRpcs)
        // A page asks for its first session; the server holds none until it does.
        const opened = yield* client.open({})
        const initial = opened.id
        const before = yield* client.state({ sessionId: initial })
        const accepted = yield* client.command({
          sessionId: initial,
          command: { kind: 'effort', effort: 'high' },
        })
        expect(accepted).toBe(true)
        const after = yield* client.state({ sessionId: initial })
        yield* client.command({ sessionId: initial, command: { kind: 'submit', text: 'go' } })
        yield* Effect.sleep('500 millis')
        // The empty effort gives the choice back to the provider.
        yield* client.command({ sessionId: initial, command: { kind: 'effort', effort: '' } })
        const cleared = yield* client.state({ sessionId: initial })
        yield* client.command({ sessionId: initial, command: { kind: 'submit', text: 'go again' } })
        yield* Effect.sleep('500 millis')
        // A second session of the same run starts from what the run resolved.
        const other = yield* client.open({})
        const otherState = yield* client.state({ sessionId: other.id })
        // Left switched, so a run that resumes this session has something to carry.
        yield* client.command({ sessionId: initial, command: { kind: 'effort', effort: 'high' } })
        return {
          initial,
          before: before.effort,
          after: after.effort,
          cleared: cleared.effort,
          other: otherState.effort,
          // What the endpoint takes, which a page offers as the choices.
          choices: before.efforts,
        }
      }).pipe(clientLayers(wsUrl)),
    ),
  )

/** A place with the three directories a run of the command needs, cleaned up after. */
const withPlace = async <A>(body: (place: Place) => Promise<A>): Promise<A> => {
  const root = await mkdtemp(join(tmpdir(), 'jozo-harness-effort-switch-'))
  const workspace = await mkdtemp(join(tmpdir(), 'jozo-harness-effort-switch-ws-'))
  const staticRoot = await staticRootOf()
  try {
    return await body({ root, workspace, staticRoot, effort: 'low' })
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
    await rm(staticRoot, { recursive: true, force: true })
  }
}

describe('the effort a page switches a session to', () => {
  test('the state reports the switch, the next request carries it, and it stays with that session', async () => {
    const sent: Array<Readonly<Record<string, unknown>>> = []
    const seen = await withPlace((place) => Effect.runPromise(switched(place, sent)))

    // The session started from the run's own effort, and the switch replaced it.
    expect(seen.before).toBe('low')
    expect(seen.after).toBe('high')
    expect(seen.cleared).toBe('')
    // The first request after the switch asks for it; the one after the switch
    // back asks for nothing, which is how a provider chooses again.
    expect(sent[0]).toEqual({ reasoning_effort: 'high' })
    expect(sent[1]).toEqual({})
    // Another session of the same run is not the one that was switched.
    expect(seen.other).toBe('low')
    // The adapter's words for this endpoint reach the page as the choices.
    expect(seen.choices).toEqual(['low', 'high'])
  }, 30_000)

  test('a run that resumes the session does not carry the switch over', async () => {
    const first: Array<Readonly<Record<string, unknown>>> = []
    const seen = await withPlace(async (place) => {
      const before = await Effect.runPromise(switched(place, first))
      // The id the first run worked in, which the second one resumes.
      // A second run of the command, over the session the first one left switched.
      const resumed = await Effect.runPromise(
        served({ ...place, resume: before.initial }, [], (wsUrl) =>
          withoutServices(
            Effect.gen(function* () {
              const client = yield* RpcClient.make(UiRpcs)
              const state = yield* client.state({ sessionId: before.initial })
              // The page a resumed run serves starts on the session it named.
              const listed = yield* client.sessions()
              return { effort: state.effort, initial: listed.initial }
            }).pipe(clientLayers(wsUrl)),
          ),
        ),
      )
      return { left: before.after, resumed, initial: before.initial }
    })

    // The switch is not written to the log: a later run resolves the effort
    // again, so the session comes back at what that run asks for, not at the
    // effort the session was left asking for.
    expect(seen.left).toBe('high')
    expect(seen.resumed.effort).toBe('low')
    // Resuming names a session, so that one is what the page opens.
    expect(seen.resumed.initial).toBe(seen.initial)
  }, 30_000)
})
