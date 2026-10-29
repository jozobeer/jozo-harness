import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { agentPlugin } from '@jozo-harness/agent'
import { agentLoopPlugin } from '@jozo-harness/agent-loop'
import { kernelPlugin, type Plugin } from '@jozo-harness/kernel'
import { Llm, type LlmAdapter, type StreamChunk } from '@jozo-harness/llm'
import { askPlugin, safetyPlugin } from '@jozo-harness/safety'
import { sessionPlugin, type AssistantMessageData } from '@jozo-harness/session'
import { jsonlSessions, sessionJsonlPlugin } from '@jozo-harness/session-jsonl'
import { systemPromptPlugin } from '@jozo-harness/system-prompt'
import { toolsPlugin } from '@jozo-harness/tools'
import { tier0Plugin } from '@jozo-harness/tools-tier0'
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

/** The text each request carried, so a test can read what the provider was told. */
const seen: Array<string> = []

/** The tools each request offered the model, so a test can read what a composition left. */
const toolNames: Array<ReadonlyArray<string>> = []

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
        toolNames.push((request.tools ?? []).map((tool) => tool.name))
        seen.push(
          request.messages
            .flatMap((message) =>
              message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])),
            )
            .join('\n'),
        )
        return Stream.fromIterable(textTurn('hello from jozo-harness'))
      },
    } satisfies LlmAdapter),
}

const profile = (root: string, systemPrompt: ReadonlyArray<string> = []): string =>
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
    ...systemPrompt.map((line) => '    ' + line),
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

/**
 * The rows a page's composition is chosen from. The Tier 0 tools give the page
 * something to add and take away, and the safety row is the boundary they run in.
 */
const composableProfile = (root: string): string =>
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
    '  - id: ask',
    "    name: '@jozo-harness/ask'",
    '  - id: tier0',
    "    name: '@jozo-harness/tools-tier0'",
    '  - id: llm',
    '    name: stub-llm',
    '  - id: agent',
    "    name: '@jozo-harness/agent'",
    '  - id: agent-loop',
    "    name: '@jozo-harness/agent-loop'",
  ].join('\n')

const composablePlugins: ReadonlyArray<Plugin<any, any, any>> = [
  kernelPlugin,
  sessionJsonlPlugin,
  sessionPlugin,
  toolsPlugin,
  systemPromptPlugin,
  safetyPlugin,
  askPlugin,
  tier0Plugin,
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
    place: {
      readonly root: string
      readonly workspace: string
      readonly resume?: string
      /** The profile document to serve, for a page that composes from more rows. */
      readonly profileText?: string
      /** The plugins those rows name, when they differ from the plain profile's. */
      readonly pluginSet?: ReadonlyArray<Plugin<any, any, any>>
    },
    body: (wsUrl: string) => Effect.Effect<A, E, Scope.Scope>,
  ): Effect.Effect<A, E> =>
    Effect.scoped(
      Effect.gen(function* () {
        const ready = yield* Deferred.make<string>()
        const stop = yield* Deferred.make<void>()
        yield* Effect.forkScoped(
          runCommand({
            profiles: [place.profileText ?? profile(place.root)],
            plugins: place.pluginSet ?? plugins,
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
          'ws://' + page.host + '/ui?code=' + (page.searchParams.get('code') ?? ''),
        )
        yield* Deferred.succeed(stop, undefined)
        return result
      }),
    )

  /**
   * Runs one turn through a real page and returns the session and the origin
   * the server printed, so a test can read the log against the address it served.
   */
  const turnThroughPage = (
    profileText: string,
    workspace: string,
  ): Promise<{ readonly id: string; readonly origin: string }> =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ready = yield* Deferred.make<string>()
          const stop = yield* Deferred.make<void>()
          yield* Effect.forkScoped(
            runCommand({
              profiles: [profileText],
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
          const wsUrl = 'ws://' + page.host + '/ui?code=' + (page.searchParams.get('code') ?? '')
          const used = Effect.gen(function* () {
            const client = yield* RpcClient.make(UiRpcs)
            const opened = yield* client.open({})
            const answered = yield* Deferred.make<void>()
            yield* Effect.forkScoped(
              client.events({ sessionId: opened.id }).pipe(
                Stream.runForEach((event) =>
                  Effect.gen(function* () {
                    if (event.kind !== 'session' || event.event.type !== 'assistant/message') return
                    yield* Deferred.succeed(answered, undefined)
                  }),
                ),
              ),
            )
            yield* client.command({
              sessionId: opened.id,
              command: { kind: 'submit', text: 'where is the GUI?' },
            })
            yield* Deferred.await(answered)
            return { id: opened.id, origin: page.origin }
          })
          const result = yield* used.pipe(clientLayers(wsUrl))
          yield* Deferred.succeed(stop, undefined)
          return result
        }),
      ),
    )

  test('the model reads the GUI URL as a user context, not in the system prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-gui-'))
    const workspace = await mkdtemp(join(tmpdir(), 'jozo-harness-web-gui-ws-'))

    const before = seen.length
    const turn = await turnThroughPage(profile(root), workspace)
    const request = seen.slice(before)
    const session = await Effect.runPromise(jsonlSessions({ root }).open(turn.id))
    const snapshots = session.events.flatMap((event) =>
      event.type === 'user/message' && event.data.source === 'runtime-context'
        ? [event.data.text]
        : [],
    )
    const system = session.events.flatMap((event) =>
      event.type === 'system/message' ? [event.data.text] : [],
    )

    // The page the human opened is named in the snapshot the model reads...
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toContain('- gui: ' + turn.origin)
    // ...and in the request the provider answers.
    expect(request).toHaveLength(1)
    expect(request[0]).toContain('- gui: ' + turn.origin)
    // ...and the prompt the provider caches carries no address at all.
    expect(system).toHaveLength(1)
    expect(system[0]).not.toContain(turn.origin)

    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }, 30_000)

  test('the system-prompt row keeps the GUI fact out of every session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-nogui-'))
    const workspace = await mkdtemp(join(tmpdir(), 'jozo-harness-web-nogui-ws-'))

    const before = seen.length
    const turn = await turnThroughPage(profile(root, ['config:', '  devContext: false']), workspace)
    const request = seen.slice(before)
    const session = await Effect.runPromise(jsonlSessions({ root }).open(turn.id))
    const snapshots = session.events.flatMap((event) =>
      event.type === 'user/message' && event.data.source === 'runtime-context'
        ? [event.data.text]
        : [],
    )
    const everything = session.events.flatMap((event) =>
      event.type === 'system/message' || event.type === 'user/message' ? [event.data.text] : [],
    )

    // The workspace and the clock still arrive; the address the setting turned off does not.
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toContain('- cwd: ' + workspace)
    expect(request).toHaveLength(1)
    expect(request[0]).toContain('- cwd: ' + workspace)
    expect(request[0]).not.toContain('gui:')
    expect(everything.join('\n')).not.toContain('gui:')
    expect(everything.join('\n')).not.toContain(turn.origin)

    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }, 30_000)

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
          const wsUrl = 'ws://' + page.host + '/ui?code=' + (page.searchParams.get('code') ?? '')

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

  test('a page composes a session and the default the session it opens next starts from', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-composition-'))
    const workspace = await mkdtemp(join(tmpdir(), 'jozo-harness-web-composition-ws-'))
    const configHome = await mkdtemp(join(tmpdir(), 'jozo-harness-web-composition-config-'))
    // `jzh config set tools` writes under XDG; the page and the test must agree on the file.
    const previous = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = configHome
    const before = toolNames.length

    try {
      const observed = await Effect.runPromise(
        Effect.gen(function* () {
          const first = yield* withPage(
            {
              root,
              workspace,
              profileText: composableProfile(root),
              pluginSet: composablePlugins,
            },
            (wsUrl) =>
              withoutServices(
                Effect.gen(function* () {
                  const client = yield* RpcClient.make(UiRpcs)
                  const opened = yield* client.open({})
                  // What the session runs with, and what a smaller set would take away.
                  const held = yield* client.composition({ sessionId: opened.id })
                  const preview = yield* client.previewComposition({
                    sessionId: opened.id,
                    tools: ['read', 'glob'],
                  })
                  const applied = yield* client.setComposition({
                    sessionId: opened.id,
                    tools: ['read', 'glob'],
                  })
                  // The turn after the choice is the one that reads the smaller set.
                  const answered = yield* Deferred.make<void>()
                  yield* Effect.forkScoped(
                    client.events({ sessionId: opened.id }).pipe(
                      Stream.runForEach((event) =>
                        Effect.gen(function* () {
                          if (event.kind !== 'session') return
                          if (event.event.type !== 'assistant/message') return
                          yield* Deferred.succeed(answered, undefined)
                        }),
                      ),
                    ),
                  )
                  yield* client.command({
                    sessionId: opened.id,
                    command: { kind: 'submit', text: 'read the tree' },
                  })
                  yield* Deferred.await(answered)
                  // The default is a separate write, into the file a human also edits.
                  const saved = yield* client.saveDefaultComposition({ tools: ['read', 'grep'] })
                  const next = yield* client.open({})
                  const born = yield* client.composition({ sessionId: next.id })
                  return { opened, held, preview, applied, saved, born }
                }).pipe(clientLayers(wsUrl)),
              ),
          )
          // A resumed run builds its boot session a different way, and still answers for it.
          const resumed = yield* withPage(
            {
              root,
              workspace,
              resume: first.opened.id,
              profileText: composableProfile(root),
              pluginSet: composablePlugins,
            },
            (wsUrl) =>
              withoutServices(
                Effect.gen(function* () {
                  const client = yield* RpcClient.make(UiRpcs)
                  const listed = yield* client.sessions()
                  const held = yield* client.composition({ sessionId: listed.initial })
                  const applied = yield* client.setComposition({
                    sessionId: listed.initial,
                    tools: ['bash'],
                  })
                  return { listed, held, applied }
                }).pipe(clientLayers(wsUrl)),
              ),
          )
          return { first, resumed }
        }),
      )

      const asked = toolNames.slice(before)
      // Before anything is chosen the page offers every tool the rows registered.
      expect(observed.first.held.profiles).toEqual(['test'])
      expect(observed.first.held.selected).toEqual(observed.first.held.offered)
      expect(observed.first.held.offered).toEqual(expect.arrayContaining(['read', 'glob', 'bash']))
      // The preview names what the set would remove, and writes nothing.
      expect(observed.first.preview.missing).toEqual([])
      expect(observed.first.preview.writable).toBe(true)
      expect(observed.first.preview.removed).toContain('bash')
      expect(observed.first.preview.removed).not.toContain('read')
      // The write is recorded, and the turn after it asks for only those tools.
      expect(observed.first.applied.selected).toEqual(['read', 'glob'])
      expect(asked).toEqual([['read', 'glob']])
      // The default lands in the same key `jzh config set tools` writes.
      expect(observed.first.saved).toBe(true)
      const settings = await readFile(join(configHome, 'jzh', 'config.yaml'), 'utf8')
      expect(settings).toContain('tools:\n  - read\n  - grep')
      // A session the page opens after the save starts from the default...
      expect(observed.first.born.selected).toEqual(['read', 'grep'])
      // ...while a run that resumes a session keeps the set its own log recorded.
      expect(observed.resumed.listed.initial).toBe(observed.first.opened.id)
      expect(observed.resumed.held.selected).toEqual(['read', 'glob'])
      expect(observed.resumed.applied.selected).toEqual(['bash'])
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previous
      await rm(root, { recursive: true, force: true })
      await rm(workspace, { recursive: true, force: true })
      await rm(configHome, { recursive: true, force: true })
    }
  }, 60_000)

  test('a settings file that does not parse is reported while a session still opens', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-bad-settings-'))
    const workspace = await mkdtemp(join(tmpdir(), 'jozo-harness-web-bad-settings-ws-'))
    const configHome = await mkdtemp(join(tmpdir(), 'jozo-harness-web-bad-settings-config-'))
    await mkdir(join(configHome, 'jzh'), { recursive: true })
    await writeFile(join(configHome, 'jzh', 'config.yaml'), 'model: [unclosed\n')
    const previous = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = configHome

    try {
      const observed = await Effect.runPromise(
        withPage(
          {
            root,
            workspace,
            profileText: composableProfile(root),
            pluginSet: composablePlugins,
          },
          (wsUrl) =>
            withoutServices(
              Effect.gen(function* () {
                const client = yield* RpcClient.make(UiRpcs)
                // A default that cannot be read leaves the new session with every tool...
                const opened = yield* client.open({})
                // ...and the read that needed it says what the file said.
                const composed = yield* client
                  .composition({ sessionId: opened.id })
                  .pipe(Effect.catch((message) => Effect.succeed(message)))
                return { opened, composed }
              }).pipe(clientLayers(wsUrl)),
            ),
        ),
      )

      expect(observed.opened.id).not.toBe('')
      expect(observed.composed).toContain('settings are not valid YAML')
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previous
      await rm(root, { recursive: true, force: true })
      await rm(workspace, { recursive: true, force: true })
      await rm(configHome, { recursive: true, force: true })
    }
  }, 30_000)

  test('a default the settings file refuses comes back as the message it wrote', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-unwritable-'))
    const workspace = await mkdtemp(join(tmpdir(), 'jozo-harness-web-unwritable-ws-'))
    // A file where the settings directory would go: the write cannot make its parent.
    const blocked = join(workspace, 'blocked-home')
    await writeFile(blocked, 'a file, not a directory\n')
    const previous = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = blocked

    try {
      const observed = await Effect.runPromise(
        withPage(
          {
            root,
            workspace,
            profileText: composableProfile(root),
            pluginSet: composablePlugins,
          },
          (wsUrl) =>
            withoutServices(
              Effect.gen(function* () {
                const client = yield* RpcClient.make(UiRpcs)
                const opened = yield* client.open({})
                // A file that is not there is no settings, so the read still answers.
                const held = yield* client.composition({ sessionId: opened.id })
                const saved = yield* client
                  .saveDefaultComposition({ tools: ['read'] })
                  .pipe(Effect.catch((message) => Effect.succeed(message)))
                return { held, saved }
              }).pipe(clientLayers(wsUrl)),
            ),
        ),
      )

      expect(observed.held.offered).toContain('read')
      // The refusal is the line the writer printed, with the path it could not write.
      expect(observed.saved).toContain('cannot write')
      expect(observed.saved).toContain(join(blocked, 'jzh', 'config.yaml'))
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previous
      await rm(root, { recursive: true, force: true })
      await rm(workspace, { recursive: true, force: true })
    }
  }, 30_000)

  test('the page reads the run settings and saves the ones that differ from the defaults', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-run-settings-'))
    const workspace = await mkdtemp(join(tmpdir(), 'jozo-harness-web-run-settings-ws-'))
    const configHome = await mkdtemp(join(tmpdir(), 'jozo-harness-web-run-settings-config-'))
    const previous = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = configHome
    const path = join(configHome, 'jzh', 'config.yaml')

    try {
      const observed = await Effect.runPromise(
        withPage(
          {
            root,
            workspace,
            profileText: composableProfile(root),
            pluginSet: composablePlugins,
          },
          (wsUrl) =>
            withoutServices(
              Effect.gen(function* () {
                const client = yield* RpcClient.make(UiRpcs)
                yield* client.open({})
                const held = yield* client.runSettings()
                const written = yield* client.saveRunSettings({
                  search: '',
                  apiKeyRef: '',
                  bashTimeoutMs: 60000,
                  maxParallelToolCalls: 4,
                  subagentDepth: held.subagentDepth.value,
                  delegateTools: [],
                })
                const before = yield* Effect.promise(() => readFile(path, 'utf8'))
                // A field the file cannot take is refused before anything is written.
                const refused = yield* client
                  .saveRunSettings({
                    search: '',
                    apiKeyRef: '',
                    bashTimeoutMs: 0,
                    maxParallelToolCalls: 4,
                    subagentDepth: held.subagentDepth.value,
                    delegateTools: [],
                  })
                  .pipe(Effect.catch((message) => Effect.succeed(message)))
                const after = yield* Effect.promise(() => readFile(path, 'utf8'))
                return { held, written, before, refused, after }
              }).pipe(clientLayers(wsUrl)),
            ),
        ),
      )

      // The first read resolves every limit the run would use...
      expect(observed.held.bashTimeoutMs.value).toBe(120_000)
      expect(observed.held.maxParallelToolCalls.value).toBeGreaterThan(0)
      // ...and a save writes only what differs from the defaults.
      expect(observed.written.bashTimeoutMs.value).toBe(60_000)
      expect(observed.written.maxParallelToolCalls.value).toBe(4)
      expect(observed.before).toContain('timeoutMs: 60000')
      expect(observed.before).toContain('maxParallelToolCalls: 4')
      // A refused save names the field and leaves the file as it was.
      expect(observed.refused).toContain('bashTimeoutMs:')
      expect(observed.refused).toContain('between 1 and')
      expect(observed.after).toBe(observed.before)
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previous
      await rm(root, { recursive: true, force: true })
      await rm(workspace, { recursive: true, force: true })
      await rm(configHome, { recursive: true, force: true })
    }
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
          const wsUrl = 'ws://' + page.host + '/ui?code=' + (page.searchParams.get('code') ?? '')

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
          const wsUrl = 'ws://' + page.host + '/ui?code=' + (page.searchParams.get('code') ?? '')

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
          const wsUrl = 'ws://' + page.host + '/ui?code=' + (page.searchParams.get('code') ?? '')

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

  test('a turn reads one skill catalog while another session is open', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-web-catalog-'))
    const workspace = await mkdtemp(join(tmpdir(), 'jozo-harness-web-catalog-ws-'))
    await mkdir(join(workspace, '.jzh', 'skills', 'demo'), { recursive: true })
    await writeFile(
      join(workspace, '.jzh', 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: Explains how to greet\n---\n\nbody\n',
    )
    const ready = Effect.runSync(Deferred.make<string>())
    const stop = Effect.runSync(Deferred.make<void>())

    const ids = await Effect.runPromise(
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
          const wsUrl = 'ws://' + page.host + '/ui?code=' + (page.searchParams.get('code') ?? '')

          const used = Effect.gen(function* () {
            const client = yield* RpcClient.make(UiRpcs)
            // A page keeps every session it opened alive; both listen at once.
            const first = yield* client.open({})
            const second = yield* client.open({})
            const firstDone = yield* Deferred.make<void>()
            const secondDone = yield* Deferred.make<void>()
            const watch = (sessionId: string, waiting: Deferred.Deferred<void>) =>
              Effect.forkScoped(
                client.events({ sessionId }).pipe(
                  Stream.runForEach((event) =>
                    Effect.gen(function* () {
                      if (event.kind !== 'session' || event.event.type !== 'assistant/message') {
                        return
                      }
                      yield* Deferred.succeed(waiting, undefined)
                    }),
                  ),
                ),
              )
            yield* watch(first.id, firstDone)
            yield* watch(second.id, secondDone)
            yield* client.command({
              sessionId: first.id,
              command: { kind: 'submit', text: 'ping' },
            })
            yield* Deferred.await(firstDone)
            yield* client.command({
              sessionId: second.id,
              command: { kind: 'submit', text: 'ping' },
            })
            yield* Deferred.await(secondDone)
            return [first.id, second.id]
          })

          const opened = yield* withoutServices(used).pipe(
            Effect.provide(RpcClient.layerProtocolSocket()),
            Effect.provide(Socket.layerWebSocket(wsUrl)),
            Effect.provide(Socket.layerWebSocketConstructorGlobal),
            Effect.provide(RpcSerialization.layerJson),
          )
          yield* Deferred.succeed(stop, undefined)
          return opened
        }),
      ),
    )

    // One turn opens with the catalog of its own session, once.
    for (const id of ids) {
      const session = await Effect.runPromise(jsonlSessions({ root }).open(id))
      const catalogs = session.events.flatMap((event) =>
        event.type === 'user/message' && event.data.source === 'skill-catalog'
          ? [event.data.text]
          : [],
      )
      expect(catalogs).toHaveLength(1)
      expect(catalogs[0]).toContain('- demo: Explains how to greet')
    }

    await rm(root, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }, 30_000)
})
