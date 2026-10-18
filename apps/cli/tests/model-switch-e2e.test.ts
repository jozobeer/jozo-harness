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
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'
import { UiRpcs, withoutServices } from '@jozo-harness/web'
import { runCommand } from '../src/index.ts'

/**
 * The model a page switches a running session to. A session is opened and
 * switched through the browser UI's own RPC, and what the provider receives is
 * read from the adapter, so the whole path is the one a page drives.
 */

const textTurn = (text: string): ReadonlyArray<StreamChunk> => [
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', kind: 'stop' },
]

/** Records the route of every request, as the provider received it. */
const spy = (sent: Array<string>): Plugin<{}, Llm, never> => ({
  name: 'stub-llm',
  config: Schema.Struct({}),
  provides: [Llm],
  requires: [],
  layer: () =>
    Layer.succeed(Llm, {
      name: 'stub',
      capabilities: {
        toolChoice: false,
        reasoningEffort: null,
        images: 'none',
        promptCacheControl: false,
      },
      stream: (request) => {
        sent.push(request.provider + '/' + request.model)
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
  const root = await mkdtemp(join(tmpdir(), 'jozo-harness-model-page-'))
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
  sent: Array<string>,
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

/**
 * One session switched the way a page does it: the command switches the session
 * on screen, and the choice decides the sessions this run opens from then on.
 */
const switched = (place: Place, sent: Array<string>) =>
  served(place, sent, (wsUrl) =>
    withoutServices(
      Effect.gen(function* () {
        const client = yield* RpcClient.make(UiRpcs)
        // A page asks for its first session; the server holds none until it does.
        const opened = yield* client.open({})
        const initial = opened.id
        // A session that was already open when the pick happened.
        const beside = yield* client.open({})
        const before = yield* client.state({ sessionId: initial })
        const accepted = yield* client.command({
          sessionId: initial,
          command: { kind: 'model', model: 'stub/other' },
        })
        expect(accepted).toBe(true)
        // The other half of a pick: the sessions opened from now on start there too.
        yield* client.setModel({ model: 'stub/other', remember: false })
        const after = yield* client.state({ sessionId: initial })
        yield* client.command({ sessionId: initial, command: { kind: 'submit', text: 'go' } })
        yield* Effect.sleep('500 millis')
        // A session opened after the pick starts from it; the one from before keeps its own.
        const later = yield* client.open({})
        const laterState = yield* client.state({ sessionId: later.id })
        const besideState = yield* client.state({ sessionId: beside.id })
        const settings = yield* client.settings()
        return {
          initial,
          before: before.model,
          after: after.model,
          later: laterState.model,
          beside: besideState.model,
          offered: settings.model,
        }
      }).pipe(clientLayers(wsUrl)),
    ),
  )

/** A page that picks a model before it has opened anything, and then starts its first session. */
const pickedFirst = (place: Place, sent: Array<string>, remember: boolean) =>
  served(place, sent, (wsUrl) =>
    withoutServices(
      Effect.gen(function* () {
        const client = yield* RpcClient.make(UiRpcs)
        // Nothing is open, so the pick is a choice for the run rather than for a session.
        const accepted = yield* client.setModel({ model: 'stub/other', remember })
        const settings = yield* client.settings()
        const opened = yield* client.open({})
        const state = yield* client.state({ sessionId: opened.id })
        yield* client.command({ sessionId: opened.id, command: { kind: 'submit', text: 'go' } })
        yield* Effect.sleep('500 millis')
        return { accepted, offered: settings.model, opened: state.model }
      }).pipe(clientLayers(wsUrl)),
    ),
  )

/** A place with the three directories a run of the command needs, cleaned up after. */
const withPlace = async <A>(body: (place: Place) => Promise<A>): Promise<A> => {
  const root = await mkdtemp(join(tmpdir(), 'jozo-harness-model-switch-'))
  const workspace = await mkdtemp(join(tmpdir(), 'jozo-harness-model-switch-ws-'))
  const staticRoot = await staticRootOf()
  try {
    return await body({ root, workspace, staticRoot })
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
    await rm(staticRoot, { recursive: true, force: true })
  }
}

/** The settings file a run with this home writes, the same place `jzh config` writes. */
const configFileIn = (home: string): string => join(home, 'jzh', 'config.yaml')

/**
 * Runs the body with the settings home moved into the test's tree, so a run that
 * writes the settings file writes there and never into the machine's own config.
 */
const withConfigHome = async <A>(body: (home: string) => Promise<A>): Promise<A> => {
  const home = await mkdtemp(join(tmpdir(), 'jozo-harness-model-home-'))
  const before = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = home
  try {
    return await body(home)
  } finally {
    if (before === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = before
    await rm(home, { recursive: true, force: true })
  }
}

describe('the model a page switches a session to', () => {
  test('the switch reaches the next request, stays with the session, and decides the ones opened after it', async () => {
    const sent: Array<string> = []
    const seen = await withPlace((place) => Effect.runPromise(switched(place, sent)))

    // The session started from the run's own route, and the switch replaced it.
    expect(seen.before).toBe('stub/model')
    expect(seen.after).toBe('stub/other')
    // The request that followed the switch is the one the provider saw.
    expect(sent).toEqual(['stub/other'])
    // A session opened after the pick starts from it; the session that was already
    // open is not the one that was switched, and keeps the route it was built with.
    expect(seen.later).toBe('stub/other')
    expect(seen.beside).toBe('stub/model')
    // What the settings sheet offers, which is the choice of the sessions to come.
    expect(seen.offered).toBe('stub/other')
  }, 30_000)

  test('a pick before any session is open decides what the next session starts from', async () => {
    const sent: Array<string> = []
    const seen = await withConfigHome(async (home) => {
      const picked = await withPlace((place) => Effect.runPromise(pickedFirst(place, sent, false)))
      // Nothing asked to keep the pick, so no file was written for the runs after this one.
      const kept = await readFile(configFileIn(home), 'utf8').catch(() => '')
      return { picked, kept }
    })

    expect(seen.picked.accepted).toBe(true)
    // The page reads the choice back, and the session it opens next was built with it.
    expect(seen.picked.offered).toBe('stub/other')
    expect(seen.picked.opened).toBe('stub/other')
    expect(sent).toEqual(['stub/other'])
    expect(seen.kept).toBe('')
  }, 30_000)

  test('a pick the page asks to keep is written down for the runs after it', async () => {
    const seen = await withConfigHome(async (home) => {
      const picked = await withPlace((place) => Effect.runPromise(pickedFirst(place, [], true)))
      const kept = await readFile(configFileIn(home), 'utf8').catch(() => '')
      return { picked, kept }
    })

    expect(seen.picked.opened).toBe('stub/other')
    // The writer is the one `jzh config set model` uses, so the file reads the same either way.
    expect(seen.kept).toContain('stub/other')
  }, 30_000)

  test('a run that resumes the session does not carry the switch over', async () => {
    const first: Array<string> = []
    const seen = await withPlace(async (place) => {
      const before = await Effect.runPromise(switched(place, first))
      // The switch is not written to the log, so this run's own route is what a
      // resumed session comes back on.
      const resumed: Array<string> = []
      const after = await Effect.runPromise(
        served({ ...place, resume: before.initial }, resumed, (wsUrl) =>
          withoutServices(
            Effect.gen(function* () {
              const client = yield* RpcClient.make(UiRpcs)
              const state = yield* client.state({ sessionId: before.initial })
              yield* client.command({
                sessionId: before.initial,
                command: { kind: 'submit', text: 'go' },
              })
              yield* Effect.sleep('500 millis')
              // The page a resumed run serves starts on the session it named.
              const listed = yield* client.sessions()
              return { model: state.model, initial: listed.initial }
            }).pipe(clientLayers(wsUrl)),
          ),
        ),
      )
      return { left: before.after, resumed: after, sent: resumed, initial: before.initial }
    })

    expect(seen.left).toBe('stub/other')
    expect(seen.resumed.model).toBe('stub/model')
    expect(seen.sent).toEqual(['stub/model'])
    // Resuming names a session, so that one is what the page opens.
    expect(seen.resumed.initial).toBe(seen.initial)
  }, 30_000)
})
