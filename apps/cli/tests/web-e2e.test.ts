import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { agentPlugin } from '@jozo-harness/agent'
import { agentLoopPlugin } from '@jozo-harness/agent-loop'
import { kernelPlugin, type Plugin } from '@jozo-harness/kernel'
import { Llm, type LlmAdapter, type StreamChunk } from '@jozo-harness/llm'
import { sessionPlugin, type AssistantMessageData } from '@jozo-harness/session'
import { jsonlSessions, sessionJsonlPlugin } from '@jozo-harness/session-jsonl'
import { systemPromptPlugin } from '@jozo-harness/system-prompt'
import { toolsPlugin } from '@jozo-harness/tools'
import { Deferred, Effect, Layer, Schema, Stream, type Scope } from 'effect'
import { RpcClient, RpcSerialization } from 'effect/rpc'
import { Socket } from 'effect/socket'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from '@jozo-harness/process'
import { runCommand } from '../src/index.ts'
import { UiRpcs, withoutServices } from '@jozo-harness/web'

const textTurn = (text: string): ReadonlyArray<StreamChunk> => [
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', kind: 'stop' },
]

/** Every request the stub was sent, by the route it named. */
const calls: Array<{ readonly provider: string; readonly model: string }> = []

const stubLlm: Plugin<{}, Llm, never> = {
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
        calls.push({ provider: request.provider, model: request.model })
        return Stream.fromIterable(textTurn('hello from jozo-harness'))
      },
    } satisfies LlmAdapter),
}

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
  stubLlm,
  agentPlugin,
  agentLoopPlugin,
]

const textOf = (data: AssistantMessageData): string =>
  data.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')

/** The client layers every page's socket needs, as a test that drives one uses them. */
const clientLayers =
  (wsUrl: string) =>
  <A, E>(self: Effect.Effect<A, E, unknown>): Effect.Effect<A, E> =>
    self.pipe(
      Effect.provide(RpcClient.layerProtocolSocket()),
      Effect.provide(Socket.layerWebSocket(wsUrl)),
      Effect.provide(Socket.layerWebSocketConstructorGlobal),
      Effect.provide(RpcSerialization.layerJson),
    ) as Effect.Effect<A, E>

describe('the browser UI through the command', () => {
  /**
   * The build this test serves lives in a directory of its own. The app's `dist` is one
   * path shared by every process on the host, and a build deletes it before writing: two
   * suites at once would take each other's files away mid-serve.
   */
  let staticRoot = ''

  beforeAll(async () => {
    staticRoot = await mkdtemp(join(tmpdir(), 'jozo-harness-web-dist-'))
    const build = spawn(
      ['pnpm', 'exec', 'vp', '-C', 'apps/web/client-solid', 'build', '--outDir', staticRoot],
      {
        cwd: join(import.meta.dirname, '../../..'),
        stdout: 'ignore',
        stderr: 'inherit',
      },
    )
    expect(await build.exited).toBe(0)
  }, 60_000)

  afterAll(async () => {
    await rm(staticRoot, { recursive: true, force: true })
  })

  /**
   * Runs the command with the browser UI for as long as the body takes, and
   * hands it the socket a page would use. A resumed run starts on that session.
   */
  const withPage = <A, E>(
    place: { readonly root: string; readonly workspace: string; readonly resume?: string },
    body: (wsUrl: string) => Effect.Effect<A, E, Scope.Scope>,
  ): Effect.Effect<A, E> =>
    Effect.scoped(
      Effect.gen(function* () {
        const ready = yield* Deferred.make<string>()
        const stop = yield* Deferred.make<void>()
        yield* Effect.forkScoped(
          runCommand({
            profiles: [profile(place.root)],
            plugins,
            cwd: place.workspace,
            route: 'stub/model',
            ...(place.resume === undefined ? {} : { resume: place.resume }),
            web: { port: 0, staticRoot },
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

  test('a model a page picks is what the session it opens next starts from', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-model-'))
    const workspace = await mkdtemp(join(tmpdir(), 'jozo-harness-web-model-ws-'))
    // The settings file the pick is written to, so the real home stays out of it.
    const configHome = await mkdtemp(join(tmpdir(), 'jozo-harness-web-model-config-'))
    const ready = Effect.runSync(Deferred.make<string>())
    const stop = Effect.runSync(Deferred.make<void>())
    const previous = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = configHome
    const before = calls.length

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.forkScoped(
            runCommand({
              profiles: [profile(root)],
              plugins,
              cwd: workspace,
              route: 'stub/model',
              web: { port: 0, staticRoot },
              stdout: () => undefined,
              stderr: (text) => {
                const match = /http:\/\/127\.0\.0\.1:\d+\/\S*/.exec(text)
                if (match !== null) void Effect.runSync(Deferred.succeed(ready, match[0]))
              },
              interrupt: Deferred.await(stop),
            }),
          )
          const page = new URL(yield* Deferred.await(ready))
          const wsUrl = 'ws://' + page.host + '/ui?token=' + (page.searchParams.get('token') ?? '')

          const used = Effect.gen(function* () {
            const client = yield* RpcClient.make(UiRpcs)
            const held = yield* client.settings()
            // The session that is already open keeps the model it was built with.
            const opened = yield* client.open({})
            const written = yield* client.setModel({ model: 'stub/other', remember: true })
            const chosen = yield* client.settings()
            yield* client.command({
              sessionId: opened.id,
              command: { kind: 'submit', text: 'ping' },
            })
            yield* Effect.sleep('500 millis')
            // The session opened after the pick is the one that asks for it.
            const next = yield* client.open({})
            yield* client.command({ sessionId: next.id, command: { kind: 'submit', text: 'ping' } })
            yield* Effect.sleep('500 millis')
            return { held: held.model, written, chosen: chosen.model }
          })

          const result = yield* withoutServices(used).pipe(
            Effect.provide(RpcClient.layerProtocolSocket()),
            Effect.provide(Socket.layerWebSocket(wsUrl)),
            Effect.provide(Socket.layerWebSocketConstructorGlobal),
            Effect.provide(RpcSerialization.layerJson),
          )
          yield* Deferred.succeed(stop, undefined)
          return result
        }),
      ),
    )

    const settings = await readFile(join(configHome, 'jzh', 'config.yaml'), 'utf8')
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
    await rm(configHome, { recursive: true, force: true })

    // The page reads what a session opened now would ask, and picks for the next one.
    expect(observed.held).toBe('stub/model')
    expect(observed.written).toBe(true)
    expect(observed.chosen).toBe('stub/other')
    // Written, so a later run reads it there...
    expect(settings).toContain('model: stub/other')
    // ...the session that was already open kept the model it began with...
    // ...and the one the page opened afterwards asked the provider for the pick.
    expect(calls.slice(before)).toEqual([
      { provider: 'stub', model: 'model' },
      { provider: 'stub', model: 'other' },
    ])
  }, 30_000)

  test('a page deletes the session a resumed run opened, log and all', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-delete-'))
    const workspace = await mkdtemp(join(tmpdir(), 'jozo-harness-web-delete-ws-'))

    // A first run leaves one session behind, the way a resume finds one.
    const started = await Effect.runPromise(
      withPage({ root, workspace }, (wsUrl) =>
        withoutServices(
          Effect.gen(function* () {
            const client = yield* RpcClient.make(UiRpcs)
            const opened = yield* client.open({})
            yield* client.command({
              sessionId: opened.id,
              command: { kind: 'submit', text: 'ping' },
            })
            // The turn finishes before the page deletes the session: a working
            // session is the one moment the delete refuses.
            yield* Effect.sleep('700 millis')
            return opened.id
          }).pipe(clientLayers(wsUrl)),
        ),
      ),
    )

    const seen = await Effect.runPromise(
      withPage({ root, workspace, resume: started }, (wsUrl) =>
        withoutServices(
          Effect.gen(function* () {
            const client = yield* RpcClient.make(UiRpcs)
            const before = yield* client.sessions()
            const opened = yield* client.open({ sessionId: started })
            const deleted = yield* client.sessionAction({
              sessionId: opened.id,
              action: { kind: 'delete' },
            })
            const after = yield* client.sessions()
            return { before, opened, deleted, after }
          }).pipe(clientLayers(wsUrl)),
        ),
      ),
    )
    const left = await Effect.runPromise(jsonlSessions({ root }).list())

    // The resumed session is open from the start, and the page deletes it anyway.
    expect(seen.before.initial).toBe(started)
    expect(seen.before.opened).toEqual([started])
    expect(seen.opened.id).toBe(started)
    expect(seen.deleted).toBe(true)
    // Neither the page nor the store holds the id once the log is gone.
    expect(seen.after.initial).toBe('')
    expect(seen.after.opened).toEqual([])
    expect(left.map((session) => session.id)).not.toContain(started)
    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }, 30_000)

  test('a browser client drives a real turn and the static app is served', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-'))
    const workspace = await mkdtemp(join(tmpdir(), 'jozo-harness-web-ws-'))
    const ready = Effect.runSync(Deferred.make<string>())
    const stop = Effect.runSync(Deferred.make<void>())

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.forkScoped(
            runCommand({
              profiles: [profile(root)],
              plugins,
              cwd: workspace,
              route: 'stub/model',
              web: { port: 0, staticRoot },
              stdout: () => undefined,
              stderr: (text) => {
                const match = /http:\/\/127\.0\.0\.1:\d+\/\S*/.exec(text)
                if (match !== null) void Effect.runSync(Deferred.succeed(ready, match[0]))
              },
              interrupt: Deferred.await(stop),
            }),
          )
          const page = new URL(yield* Deferred.await(ready))
          const wsUrl = 'ws://' + page.host + '/ui?token=' + (page.searchParams.get('token') ?? '')

          const origin = page.origin
          const used = Effect.gen(function* () {
            const client = yield* RpcClient.make(UiRpcs)
            const seen = yield* Deferred.make<string>()
            // A server that just started holds no session: the page asks for one.
            const listed = yield* client.sessions()
            const opened = yield* client.open({})
            yield* Effect.forkScoped(
              client.events({ sessionId: opened.id }).pipe(
                Stream.runForEach((event) =>
                  Effect.gen(function* () {
                    if (event.kind !== 'session' || event.event.type !== 'assistant/message') return
                    yield* Deferred.succeed(seen, textOf(event.event.data as AssistantMessageData))
                  }),
                ),
              ),
            )
            const accepted = yield* client.command({
              sessionId: opened.id,
              command: { kind: 'submit', text: 'ping' },
            })
            const answer = yield* Deferred.await(seen)
            const served = yield* Effect.promise(() => fetch(origin + '/'))
            const home = yield* Effect.promise(() => served.text())
            return {
              held: listed.initial,
              accepted,
              answer,
              status: served.status,
              home,
            }
          })

          const result = yield* withoutServices(used).pipe(
            Effect.provide(RpcClient.layerProtocolSocket()),
            Effect.provide(Socket.layerWebSocket(wsUrl)),
            Effect.provide(Socket.layerWebSocketConstructorGlobal),
            Effect.provide(RpcSerialization.layerJson),
          )
          yield* Deferred.succeed(stop, undefined)
          return result
        }),
      ),
    )

    const sessions = await Effect.runPromise(jsonlSessions({ root }).list())
    const opened = await Effect.runPromise(jsonlSessions({ root }).open(sessions[0]?.id ?? ''))

    expect(observed.held).toBe('')
    expect(observed.accepted).toBe(true)
    expect(observed.answer).toContain('hello from jozo-harness')
    expect(observed.status).toBe(200)
    expect(observed.home).toContain('<title>jozo-harness</title>')
    expect(
      opened.events.flatMap((event) =>
        event.type === 'user/message' && event.data.source === 'user' ? [event.data.text] : [],
      ),
    ).toEqual(['ping'])
    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }, 20_000)

  test('a page opens a session in the workspace it names, and the prompt reads there', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-cwd-'))
    const serverWorkspace = await mkdtemp(join(tmpdir(), 'jozo-harness-web-server-ws-'))
    const otherWorkspace = await mkdtemp(join(tmpdir(), 'jozo-harness-web-other-ws-'))
    const home = await mkdtemp(join(tmpdir(), 'jozo-harness-web-home-'))
    await writeFile(join(otherWorkspace, 'AGENTS.md'), 'the other workspace speaks\n')
    await mkdir(join(serverWorkspace, 'nested'))
    const ready = Effect.runSync(Deferred.make<string>())
    const stop = Effect.runSync(Deferred.make<void>())

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.forkScoped(
            runCommand({
              profiles: [profile(root)],
              plugins,
              cwd: serverWorkspace,
              jzhHome: home,
              route: 'stub/model',
              web: { port: 0, staticRoot },
              stdout: () => undefined,
              stderr: (text) => {
                const match = /http:\/\/127\.0\.0\.1:\d+\/\S*/.exec(text)
                if (match !== null) void Effect.runSync(Deferred.succeed(ready, match[0]))
              },
              interrupt: Deferred.await(stop),
            }),
          )
          const page = new URL(yield* Deferred.await(ready))
          const wsUrl = 'ws://' + page.host + '/ui?token=' + (page.searchParams.get('token') ?? '')

          const used = Effect.gen(function* () {
            const client = yield* RpcClient.make(UiRpcs)
            const made = yield* client.open({ cwd: otherWorkspace })
            const offered = yield* client.workspaces()
            // A resume keeps the workspace the session header recorded.
            const resumed = yield* client.open({ sessionId: made.id, cwd: serverWorkspace })
            const added = yield* client.addWorkspace({ cwd: otherWorkspace })
            const fileRefused = yield* client
              .addWorkspace({ cwd: join(otherWorkspace, 'AGENTS.md') })
              .pipe(Effect.catch((message) => Effect.succeed(message)))
            const relativeRefused = yield* client
              .addWorkspace({ cwd: 'relative/path' })
              .pipe(Effect.catch((message) => Effect.succeed(message)))
            const browsed = yield* client.browseDirectories({ path: serverWorkspace })
            // The dialog opening with no path starts at the run's own folder.
            const started = yield* client.browseDirectories({ path: '' })
            const browseRefused = yield* client
              .browseDirectories({ path: join(serverWorkspace, 'missing') })
              .pipe(Effect.catch((message) => Effect.succeed(message)))
            const seen = yield* Deferred.make<string>()
            yield* Effect.forkScoped(
              client.events({ sessionId: made.id }).pipe(
                Stream.runForEach((event) =>
                  Effect.gen(function* () {
                    if (event.kind !== 'session' || event.event.type !== 'assistant/message') return
                    yield* Deferred.succeed(seen, textOf(event.event.data as AssistantMessageData))
                  }),
                ),
              ),
            )
            const accepted = yield* client.command({
              sessionId: made.id,
              command: { kind: 'submit', text: 'ping' },
            })
            const answer = yield* Deferred.await(seen)
            return {
              made,
              offered,
              resumed,
              added,
              fileRefused,
              relativeRefused,
              browsed,
              started,
              browseRefused,
              accepted,
              answer,
            }
          })

          const result = yield* withoutServices(used).pipe(
            Effect.provide(RpcClient.layerProtocolSocket()),
            Effect.provide(Socket.layerWebSocket(wsUrl)),
            Effect.provide(Socket.layerWebSocketConstructorGlobal),
            Effect.provide(RpcSerialization.layerJson),
          )
          yield* Deferred.succeed(stop, undefined)
          return result
        }),
      ),
    )

    const store = jsonlSessions({ root })
    const listed = await Effect.runPromise(store.list())
    const opened = await Effect.runPromise(store.open(listed[0]?.id ?? ''))
    const header = opened.events[0]
    const registry = await readFile(join(home, 'web', 'workspaces.json'), 'utf8')

    expect(observed.made.cwd).toBe(otherWorkspace)
    expect(observed.resumed.cwd).toBe(otherWorkspace)
    expect(observed.offered.cwd).toBe(serverWorkspace)
    expect(observed.offered.items.map((item) => item.cwd)).toContain(otherWorkspace)
    expect(observed.added).toBe(true)
    expect(observed.fileRefused).toBe('a workspace must be a directory')
    expect(observed.relativeRefused).toBe('a workspace path must be absolute')
    expect(observed.browsed.path).toBe(serverWorkspace)
    expect(observed.browsed.parent).toBe(dirname(serverWorkspace))
    expect(observed.browsed.items).toContain(join(serverWorkspace, 'nested'))
    expect(observed.started.path).toBe(serverWorkspace)
    expect(observed.browseRefused).toBe('no such directory')
    expect(observed.accepted).toBe(true)
    expect(observed.answer).toContain('hello from jozo-harness')
    // The session header keeps the workspace the page named...
    expect(header?.type === 'session/header' ? header.data.cwd : '').toBe(otherWorkspace)
    // ...and the prompt was assembled from that workspace's instructions.
    expect(
      opened.events
        .flatMap((event) => (event.type === 'system/message' ? [event.data.text] : []))
        .join('\n'),
    ).toContain('the other workspace speaks')
    expect(JSON.parse(registry)).toContain(otherWorkspace)

    await rm(root, { recursive: true, force: true })
    await rm(serverWorkspace, { recursive: true, force: true })
    await rm(otherWorkspace, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }, 30_000)

  test('a skill added while a turn runs reaches the composer list after the next turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-skill-'))
    const workspace = await mkdtemp(join(tmpdir(), 'jozo-harness-web-skill-ws-'))
    const home = await mkdtemp(join(tmpdir(), 'jozo-harness-web-skill-home-'))
    const ready = Effect.runSync(Deferred.make<string>())
    const stop = Effect.runSync(Deferred.make<void>())
    let calls = 0
    const addingLlm: Plugin<{}, Llm, never> = {
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
          stream: () => {
            calls += 1
            // The first answer drops a skill in while the turn is running.
            if (calls === 1) {
              const skill = join(workspace, '.jzh', 'skills', 'fresh')
              mkdirSync(skill, { recursive: true })
              writeFileSync(
                join(skill, 'SKILL.md'),
                '---\nname: fresh\ndescription: Added while the first turn ran\n---\n\nbody\n',
              )
            }
            return Stream.fromIterable(textTurn('done'))
          },
        } satisfies LlmAdapter),
    }

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.forkScoped(
            runCommand({
              profiles: [profile(root)],
              plugins: [
                kernelPlugin,
                sessionJsonlPlugin,
                sessionPlugin,
                toolsPlugin,
                systemPromptPlugin,
                addingLlm,
                agentPlugin,
                agentLoopPlugin,
              ],
              cwd: workspace,
              jzhHome: home,
              route: 'stub/model',
              web: { port: 0, staticRoot },
              stdout: () => undefined,
              stderr: (text) => {
                const match = /http:\/\/127\.0\.0\.1:\d+\/\S*/.exec(text)
                if (match !== null) void Effect.runSync(Deferred.succeed(ready, match[0]))
              },
              interrupt: Deferred.await(stop),
            }),
          )
          const page = new URL(yield* Deferred.await(ready))
          const wsUrl = 'ws://' + page.host + '/ui?token=' + (page.searchParams.get('token') ?? '')

          const used = Effect.gen(function* () {
            const client = yield* RpcClient.make(UiRpcs)
            const opened = yield* client.open({})
            const before = yield* client.commands({ sessionId: opened.id })
            const ended = [yield* Deferred.make<void>(), yield* Deferred.make<void>()]
            yield* Effect.forkScoped(
              client.events({ sessionId: opened.id }).pipe(
                Stream.runForEach((event) =>
                  Effect.gen(function* () {
                    if (event.kind !== 'session' || event.event.type !== 'turn/end') return
                    const data = event.event.data
                    if (typeof data !== 'object' || data === null) return
                    const turn = (data as { readonly turn?: unknown }).turn
                    if (typeof turn !== 'number') return
                    const waiting = ended[turn - 1]
                    if (waiting !== undefined) yield* Deferred.succeed(waiting, undefined)
                  }),
                ),
              ),
            )
            yield* client.command({
              sessionId: opened.id,
              command: { kind: 'submit', text: 'first' },
            })
            yield* Deferred.await(ended[0]!)
            yield* client.command({
              sessionId: opened.id,
              command: { kind: 'submit', text: 'second' },
            })
            yield* Deferred.await(ended[1]!)
            const after = yield* client.commands({ sessionId: opened.id })
            return { before, after }
          })

          const result = yield* withoutServices(used).pipe(
            Effect.provide(RpcClient.layerProtocolSocket()),
            Effect.provide(Socket.layerWebSocket(wsUrl)),
            Effect.provide(Socket.layerWebSocketConstructorGlobal),
            Effect.provide(RpcSerialization.layerJson),
          )
          yield* Deferred.succeed(stop, undefined)
          return result
        }),
      ),
    )

    expect(observed.before.map((view) => view.name)).not.toContain('fresh')
    expect(observed.after).toContainEqual({
      name: 'fresh',
      summary: 'Added while the first turn ran',
      kind: 'skill',
    })

    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }, 30_000)
})
