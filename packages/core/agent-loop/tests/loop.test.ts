import { describe, expect, test } from 'vitest'
import {
  Agents,
  agentsLayer,
  type Agent,
  type AgentError,
  type AgentsShape,
} from '@jozo-harness/agent'
import { Hooks, makeHooks, type HookRegistry } from '@jozo-harness/kernel'
import { Llm, LlmFailure, type LlmAdapter, type StreamChunk } from '@jozo-harness/llm'
import {
  QUOTE_LIMITS,
  SessionError,
  sessionsLayer,
  shortenTitle,
  type OpenedSession,
  type SessionEvent,
  type SessionHeader,
  type SessionId,
  type SessionPersistence,
  type SessionSink,
  type SessionSummary,
} from '@jozo-harness/session'
import {
  SystemPrompt,
  makeSystemPrompt,
  tmuxContextEntry,
  type SystemPromptShape,
} from '@jozo-harness/system-prompt'
import {
  Tools,
  ToolError,
  makeTools,
  type ToolDefinition,
  type ToolRegistry,
} from '@jozo-harness/tools'
import { Effect, Layer, Schema, Scope, Stream } from 'effect'
import {
  AgentLoop,
  agentLoopEffect,
  installRetry,
  type AgentLoopConfig,
  type AgentRequest,
} from '../src/index.ts'

type Script = () => Stream.Stream<StreamChunk, LlmFailure>

const chunks =
  (list: ReadonlyArray<StreamChunk>): Script =>
  () =>
    Stream.fromIterable(list)
const fails =
  (failure: LlmFailure): Script =>
  () =>
    Stream.fail(failure)
const forever =
  (list: ReadonlyArray<StreamChunk>): Script =>
  () =>
    Stream.concat(Stream.fromIterable(list), Stream.never)

const adapter = (scripts: ReadonlyArray<Script>): LlmAdapter => {
  let call = 0
  return {
    name: 'fake',
    capabilities: {
      toolChoice: false,
      reasoningEffort: null,
      images: 'none',
      promptCacheControl: false,
    },
    stream: () => {
      const script = scripts[call] ?? chunks([])
      call += 1
      return script()
    },
  }
}

const sessionPersistence = (
  flush: () => Effect.Effect<void, SessionError> = () => Effect.void,
): SessionPersistence => {
  const stored = new Map<SessionId, { events: Array<SessionEvent> }>()
  const opened = (id: SessionId): OpenedSession => {
    const record = stored.get(id)
    if (record === undefined) throw new Error('missing session')
    const sink: SessionSink = {
      append: (event) =>
        Effect.sync(() => {
          record.events.push(event)
        }),
      flush,
    }
    return { id, events: [...record.events], sink }
  }
  return {
    create: (header: SessionHeader) =>
      Effect.sync(() => {
        const id = crypto.randomUUID()
        stored.set(id, {
          events: [{ seq: 1, time: header.createdAt, type: 'session/header', data: header }],
        })
        return opened(id)
      }),
    open: (id) =>
      stored.has(id)
        ? Effect.sync(() => opened(id))
        : Effect.fail(new SessionError({ code: 'not-found', message: 'no session' })),
    stat: (id) => Effect.fail(new SessionError({ code: 'not-found', message: `no summary ${id}` })),
    list: () => Effect.succeed<ReadonlyArray<SessionSummary>>([]),
  }
}

interface Ctx {
  readonly agents: AgentsShape
  readonly hooks: HookRegistry
  readonly tools: ToolRegistry
  readonly prompt: SystemPromptShape
}

const scenario = <A>(
  scripts: ReadonlyArray<Script>,
  body: (ctx: Ctx) => Effect.Effect<A, AgentError | ToolError, Scope.Scope>,
  persistence: SessionPersistence = sessionPersistence(),
  config: AgentLoopConfig = {},
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const hooks = makeHooks()
      const tools = makeTools(hooks)
      const prompt = makeSystemPrompt()
      const services = Layer.mergeAll(
        Layer.succeed(Hooks, hooks),
        Layer.succeed(Tools, tools),
        Layer.succeed(SystemPrompt, prompt),
        Layer.succeed(Llm, adapter(scripts)),
      )
      const runner = yield* AgentLoop.pipe(
        Effect.provide(Layer.provide(Layer.effect(AgentLoop, agentLoopEffect(config)), services)),
      )
      const app = Layer.provideMerge(
        Layer.provide(agentsLayer(runner), sessionsLayer(persistence, { now: () => 1 })),
        Layer.succeed(Hooks, hooks),
      )
      return yield* Effect.provide(
        Effect.scoped(
          Effect.gen(function* () {
            const agents = yield* Agents
            return yield* Effect.orDie(body({ agents, hooks, tools, prompt }))
          }),
        ),
        app,
      )
    }),
  )

const types = (agent: Agent) => agent.session.events().map((event) => event.type)
const reason = (agent: Agent) =>
  agent.session.events().flatMap((event) => (event.type === 'turn/end' ? [event.data.reason] : []))

const textTurn = (text: string): ReadonlyArray<StreamChunk> => [
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } },
  { type: 'finish', kind: 'stop' },
]

describe('agent loop', () => {
  test('runs one completed turn and records the request series in order', async () => {
    const text = crypto.randomUUID()
    const events = await scenario([chunks(textTurn(text))], (ctx) =>
      Effect.gen(function* () {
        const agent = yield* ctx.agents.create({ cwd: '/work', options: { route: 'fake/model' } })
        yield* agent.followup({ text: 'hello', source: 'user' })
        yield* agent.whenIdle
        return agent
      }),
    )

    expect(types(events)).toEqual([
      'session/header',
      'agent/inbox/queued',
      'turn/start',
      'agent/inbox/claimed',
      'step/start',
      'system/message',
      'user/message',
      'request/header',
      'assistant/message',
      'step/end',
      'turn/end',
    ])
    expect(reason(events)).toEqual([{ kind: 'completed' }])
    const assistant = events.session
      .events()
      .flatMap((event) => (event.type === 'assistant/message' ? [event.data.content] : []))
    expect(assistant).toEqual([[{ type: 'text', text }]])
  })

  test('records the files attached to a human message beside its text', async () => {
    const attachment = {
      hash: 'a'.repeat(64),
      mediaType: 'text/plain',
      name: 'note.txt',
      bytes: 5,
    }
    const events = await scenario([chunks(textTurn('read'))], (ctx) =>
      Effect.gen(function* () {
        const agent = yield* ctx.agents.create({ cwd: '/work', options: { route: 'fake/model' } })
        yield* agent.followup({ text: 'see this', source: 'user', attachments: [attachment] })
        yield* agent.whenIdle
        return agent
      }),
    )

    const logged = events.session
      .events()
      .flatMap((event) => (event.type === 'user/message' ? [event.data] : []))
    expect(logged[0]?.attachments).toEqual([attachment])
  })

  test('adds a runtime snapshot only when the tmux location changes', async () => {
    let output = 'main:2.1'
    const reader = {
      env: { TMUX: '/tmp/tmux-501/default,1,0', TMUX_PANE: '%1' },
      run: () => output,
    }
    const events = await scenario(
      [chunks(textTurn('one')), chunks(textTurn('two')), chunks(textTurn('three'))],
      (ctx) =>
        Effect.gen(function* () {
          yield* Effect.orDie(ctx.prompt.context(tmuxContextEntry(reader)))
          const agent = yield* ctx.agents.create({
            cwd: '/work',
            options: { route: 'fake/model' },
          })
          yield* agent.followup({ text: 'one', source: 'user' })
          yield* agent.whenIdle
          yield* agent.followup({ text: 'two', source: 'user' })
          yield* agent.whenIdle
          output = 'main:2.2'
          yield* agent.followup({ text: 'three', source: 'user' })
          yield* agent.whenIdle
          return agent
        }),
    )

    const snapshots = events.session
      .events()
      .flatMap((event) =>
        event.type === 'user/message' && event.data.source === 'runtime-context'
          ? [event.data.text]
          : [],
      )
    expect(snapshots).toHaveLength(2)
    expect(snapshots[0]).toContain('pane 1')
    expect(snapshots[1]).toContain('pane 2')
  })

  test('a quoted passage is logged with the message, cut to the size a log keeps', async () => {
    const passage = 'p'.repeat(QUOTE_LIMITS.maxQuoteChars + 40)
    const events = await scenario([chunks(textTurn('it holds'))], (ctx) =>
      Effect.gen(function* () {
        const agent = yield* ctx.agents.create({ cwd: '/work', options: { route: 'fake/model' } })
        yield* agent.followup({
          text: 'does this hold?',
          source: 'user',
          quotes: [{ text: passage, sourceSeq: 4 }],
        })
        yield* agent.whenIdle
        return agent
      }),
    )

    const logged = events.session
      .events()
      .flatMap((event) =>
        event.type === 'user/message' && event.data.source === 'user' ? [event.data] : [],
      )
    expect(logged).toHaveLength(1)
    expect(logged[0]?.text).toBe('does this hold?')
    expect(logged[0]?.quotes).toEqual([
      { text: passage.slice(0, QUOTE_LIMITS.maxQuoteChars) + '…', sourceSeq: 4 },
    ])
  })

  test('names a session with a shorter title from the first message', async () => {
    const first = 'please fix the flaky login test that only fails on CI sometimes'
    const title = 'flaky login test'
    const events = await scenario(
      [chunks(textTurn(title)), chunks(textTurn('done'))],
      (ctx) =>
        Effect.gen(function* () {
          const agent = yield* ctx.agents.create({ cwd: '/work', options: { route: 'fake/model' } })
          yield* agent.followup({ text: first, source: 'user' })
          yield* agent.whenIdle
          return agent
        }),
      sessionPersistence(),
      { title: { maxChars: 40 } },
    )

    const written = events.session
      .events()
      .flatMap((event) => (event.type === 'session/title' ? [event.data] : []))
    expect(written).toEqual([{ title, source: 'model' }])
    // The point of the call: the row says what the session is about, not the opening.
    expect(written[0]?.title).not.toBe(shortenTitle(first))
    expect(reason(events)).toEqual([{ kind: 'completed' }])
  })

  test('falls back to the cut first message when the title call fails', async () => {
    const first = 'please fix the flaky login test that only fails on CI sometimes'
    const events = await scenario(
      [
        fails(new LlmFailure({ code: 'PROVIDER', message: 'the title call failed' })),
        chunks(textTurn('done')),
      ],
      (ctx) =>
        Effect.gen(function* () {
          const agent = yield* ctx.agents.create({ cwd: '/work', options: { route: 'fake/model' } })
          yield* agent.followup({ text: first, source: 'user' })
          yield* agent.whenIdle
          return agent
        }),
      sessionPersistence(),
      { title: { maxChars: 20 } },
    )

    const written = events.session
      .events()
      .flatMap((event) => (event.type === 'session/title' ? [event.data] : []))
    expect(written).toEqual([{ title: shortenTitle(first), source: 'fallback' }])
    // A name that could not be written is no reason to lose the answer.
    expect(reason(events)).toEqual([{ kind: 'completed' }])
  })

  test('does not name a session again after the first message', async () => {
    const events = await scenario(
      [chunks(textTurn('first title')), chunks(textTurn('first')), chunks(textTurn('second'))],
      (ctx) =>
        Effect.gen(function* () {
          const agent = yield* ctx.agents.create({ cwd: '/work', options: { route: 'fake/model' } })
          yield* agent.followup({ text: 'the opening', source: 'user' })
          yield* agent.whenIdle
          yield* agent.followup({ text: 'one more thing', source: 'user' })
          yield* agent.whenIdle
          return agent
        }),
      sessionPersistence(),
      { title: {} },
    )

    const written = events.session.events().filter((event) => event.type === 'session/title')
    expect(written).toHaveLength(1)
    expect(types(events).filter((type) => type === 'turn/start')).toHaveLength(2)
  })

  test('a step cut off by the token cap ends the turn as max-tokens', async () => {
    const text = 'half an ans'
    let stopping = 0
    const events = await scenario(
      [
        chunks([
          { type: 'text-delta', index: 0, text },
          { type: 'block-end', index: 0, block: { type: 'text', text } },
          { type: 'finish', kind: 'length' },
        ]),
      ],
      (ctx) =>
        Effect.gen(function* () {
          yield* ctx.hooks.on('agent/turn-stopping', () =>
            Effect.sync(() => {
              stopping += 1
            }),
          )
          const agent = yield* ctx.agents.create({ cwd: '/work', options: { route: 'fake/model' } })
          yield* agent.followup({ text: 'go', source: 'user' })
          yield* agent.whenIdle
          return agent
        }),
    )

    // The answer is still history, but the turn says why it stopped.
    const assistant = events.session
      .events()
      .flatMap((event) => (event.type === 'assistant/message' ? [event.data.content] : []))
    expect(assistant).toEqual([[{ type: 'text', text }]])
    expect(reason(events)).toEqual([{ kind: 'max-tokens' }])
    // A truncated turn is not one that may queue another goal round.
    expect(stopping).toBe(0)
  })

  test('executes a tool call and runs a second step with its result', async () => {
    const echo: ToolDefinition<{ readonly text: string }, { readonly text: string }> = {
      name: 'echo',
      description: 'Echo',
      parameters: Schema.Struct({ text: Schema.String }),
      output: {
        schema: Schema.Struct({ text: Schema.String }),
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      execute: (args) => Effect.succeed({ text: args.text }),
    }
    const events = await scenario(
      [
        chunks([
          {
            type: 'block-end',
            index: 0,
            block: { type: 'tool-call', id: 'c1', name: 'echo', arguments: '{"text":"x"}' },
          },
          { type: 'finish', kind: 'tool-calls' },
        ]),
        chunks(textTurn('done')),
      ],
      (ctx) =>
        Effect.gen(function* () {
          yield* ctx.tools.register(echo)
          const agent = yield* ctx.agents.create({ cwd: '/work', options: { route: 'fake/model' } })
          yield* agent.followup({ text: 'go', source: 'user' })
          yield* agent.whenIdle
          return agent
        }),
    )

    const eventTypes = types(events)
    expect(eventTypes.filter((type) => type === 'step/start')).toHaveLength(2)
    expect(eventTypes).toContain('tool/call')
    expect(eventTypes).toContain('tool/result')
    expect(eventTypes.indexOf('tool/call')).toBeLessThan(eventTypes.indexOf('tool/result'))
    expect(reason(events)).toEqual([{ kind: 'completed' }])
  })

  test('records the code of a failed tool call in the log', async () => {
    const broken: ToolDefinition<{}, { readonly ok: boolean }> = {
      name: 'broken',
      description: 'Fails',
      parameters: Schema.Struct({}),
      output: {
        schema: Schema.Struct({ ok: Schema.Boolean }),
        render: () => [{ type: 'text', text: 'ok' }],
      },
      execute: () => Effect.fail(new ToolError({ code: 'execution', message: 'disk is gone' })),
    }
    const events = await scenario(
      [
        chunks([
          {
            type: 'block-end',
            index: 0,
            block: { type: 'tool-call', id: 'c1', name: 'broken', arguments: '{}' },
          },
          { type: 'finish', kind: 'tool-calls' },
        ]),
        chunks(textTurn('failed')),
      ],
      (ctx) =>
        Effect.gen(function* () {
          yield* ctx.tools.register(broken)
          const agent = yield* ctx.agents.create({ cwd: '/work', options: { route: 'fake/model' } })
          yield* agent.followup({ text: 'go', source: 'user' })
          yield* agent.whenIdle
          return agent
        }),
    )

    const result = events.session.events().find((event) => event.type === 'tool/result')
    expect(result?.type === 'tool/result' ? result.data.error : undefined).toEqual({
      name: 'ToolError',
      code: 'execution',
    })
  })

  test('does not send a request whose log is not durable', async () => {
    let requests = 0
    const counted =
      (script: Script): Script =>
      () => {
        requests += 1
        return script()
      }
    const events = await scenario(
      [counted(chunks(textTurn('never sent')))],
      (ctx) =>
        Effect.gen(function* () {
          const agent = yield* ctx.agents.create({ cwd: '/work', options: { route: 'fake/model' } })
          yield* agent.followup({ text: 'go', source: 'user' })
          yield* agent.whenIdle
          return agent
        }),
      sessionPersistence(() =>
        Effect.fail(new SessionError({ code: 'persistence', message: 'log is not durable' })),
      ),
    )

    expect(requests).toBe(0)
    expect(reason(events)).toEqual([
      {
        kind: 'error',
        failure: { _tag: 'LlmFailure', code: 'PROVIDER', message: 'the turn failed' },
      },
    ])
  })

  test('does not run a tool whose call is not durable', async () => {
    let executed = 0
    const poke: ToolDefinition<{}, { readonly ok: boolean }> = {
      name: 'poke',
      description: 'Counts a side effect',
      parameters: Schema.Struct({}),
      output: {
        schema: Schema.Struct({ ok: Schema.Boolean }),
        render: () => [{ type: 'text', text: 'poked' }],
      },
      execute: () =>
        Effect.sync(() => {
          executed += 1
          return { ok: true }
        }),
    }
    let flushes = 0
    const failSecond = () =>
      Effect.suspend(() => {
        flushes += 1
        return flushes === 1
          ? Effect.void
          : Effect.fail(new SessionError({ code: 'persistence', message: 'log is not durable' }))
      })
    const events = await scenario(
      [
        chunks([
          {
            type: 'block-end',
            index: 0,
            block: { type: 'tool-call', id: 'c1', name: 'poke', arguments: '{}' },
          },
          { type: 'finish', kind: 'tool-calls' },
        ]),
      ],
      (ctx) =>
        Effect.gen(function* () {
          yield* ctx.tools.register(poke)
          const agent = yield* ctx.agents.create({ cwd: '/work', options: { route: 'fake/model' } })
          yield* agent.followup({ text: 'go', source: 'user' })
          yield* agent.whenIdle
          return agent
        }),
      sessionPersistence(failSecond),
    )

    // The request is allowed once the log is durable; the call is appended after it.
    expect(flushes).toBe(2)
    expect(executed).toBe(0)
    expect(types(events)).toContain('tool/call')
    expect(reason(events)).toEqual([
      {
        kind: 'error',
        failure: { _tag: 'LlmFailure', code: 'PROVIDER', message: 'the turn failed' },
      },
    ])
  })

  test('a concluding tool ends the turn without another step', async () => {
    const finish: ToolDefinition<{}, { readonly ok: boolean }> = {
      name: 'finish',
      description: 'Ends the turn from its result',
      parameters: Schema.Struct({}),
      output: {
        schema: Schema.Struct({ ok: Schema.Boolean }),
        render: () => [{ type: 'text', text: 'finished' }],
      },
      execute: (_args, context) => {
        context.concludeTurn?.()
        return Effect.succeed({ ok: true })
      },
    }
    const events = await scenario(
      [
        chunks([
          {
            type: 'block-end',
            index: 0,
            block: { type: 'tool-call', id: 'c1', name: 'finish', arguments: '{}' },
          },
          { type: 'finish', kind: 'tool-calls' },
        ]),
        chunks(textTurn('the model is asked again')),
      ],
      (ctx) =>
        Effect.gen(function* () {
          yield* ctx.tools.register(finish)
          const agent = yield* ctx.agents.create({ cwd: '/work', options: { route: 'fake/model' } })
          yield* agent.followup({ text: 'go', source: 'user' })
          yield* agent.whenIdle
          return agent
        }),
    )

    const stored = events.session.events()
    expect(types(events).filter((type) => type === 'step/start')).toHaveLength(1)
    expect(types(events).filter((type) => type === 'assistant/message')).toHaveLength(1)
    const results = stored.flatMap((event) => (event.type === 'tool/result' ? [event.data] : []))
    expect(results[0]?.concludesTurn).toBe(true)
    expect(reason(events)).toEqual([{ kind: 'completed' }])
  })

  test('a steer queued while a concluding tool runs opens the next turn', async () => {
    const note = crypto.randomUUID()
    const events = await scenario(
      [
        chunks([
          {
            type: 'block-end',
            index: 0,
            block: { type: 'tool-call', id: 'c1', name: 'finish', arguments: '{}' },
          },
          { type: 'finish', kind: 'tool-calls' },
        ]),
        chunks(textTurn('the next turn')),
      ],
      (ctx) =>
        Effect.gen(function* () {
          const agent = yield* ctx.agents.create({ cwd: '/work', options: { route: 'fake/model' } })
          const finish: ToolDefinition<{}, { readonly ok: boolean }> = {
            name: 'finish',
            description: 'Queues one note and ends the turn',
            parameters: Schema.Struct({}),
            output: {
              schema: Schema.Struct({ ok: Schema.Boolean }),
              render: () => [{ type: 'text', text: 'finished' }],
            },
            execute: (_args, context) =>
              agent.steer({ text: note, source: 'inject' }).pipe(
                Effect.mapError(
                  () => new ToolError({ code: 'execution', message: 'cannot queue the note' }),
                ),
                Effect.tap(() => Effect.sync(() => context.concludeTurn?.())),
                Effect.as({ ok: true }),
              ),
          }
          yield* ctx.tools.register(finish)
          yield* agent.followup({ text: 'go', source: 'user' })
          yield* agent.whenIdle
          return agent
        }),
    )

    const stored = events.session.events()
    const delivered = stored.flatMap((event) =>
      event.type === 'user/message' && event.data.source === 'inject' ? [event.data.text] : [],
    )
    expect(types(events).filter((type) => type === 'turn/start')).toHaveLength(2)
    expect(delivered).toEqual([note])
    expect(events.inbox.pending).toBe(false)
  })

  test('hands tools the image capability the route declared', async () => {
    const seen: Array<string | undefined> = []
    const probe: ToolDefinition<{}, { readonly carried: boolean }> = {
      name: 'image_capability',
      description: 'Probe',
      parameters: Schema.Struct({}),
      output: {
        schema: Schema.Struct({ carried: Schema.Boolean }),
        render: (_args, value) => [{ type: 'text', text: String(value.carried) }],
      },
      execute: (_args, context) => {
        seen.push(context.images)
        return Effect.succeed({ carried: context.images === 'base64' })
      },
    }
    const events = await scenario(
      [
        chunks([
          {
            type: 'block-end',
            index: 0,
            block: { type: 'tool-call', id: 'c1', name: 'image_capability', arguments: '{}' },
          },
          { type: 'finish', kind: 'tool-calls' },
        ]),
        chunks(textTurn('done')),
      ],
      (ctx) =>
        Effect.gen(function* () {
          yield* ctx.tools.register(probe)
          const agent = yield* ctx.agents.create({ cwd: '/work', options: { route: 'fake/model' } })
          yield* agent.followup({ text: 'go', source: 'user' })
          yield* agent.whenIdle
          return agent
        }),
    )

    expect(seen).toEqual(['none'])
    const results = events.session
      .events()
      .flatMap((event) => (event.type === 'tool/result' ? [event.data.content] : []))
    expect(results).toEqual([[{ type: 'text', text: 'false' }]])
  })

  test('input queued while a tool runs joins the next step', async () => {
    const note = crypto.randomUUID()
    const events = await scenario(
      [
        chunks([
          {
            type: 'block-end',
            index: 0,
            block: { type: 'tool-call', id: 'c1', name: 'poke', arguments: '{}' },
          },
          { type: 'finish', kind: 'tool-calls' },
        ]),
        chunks(textTurn('done')),
      ],
      (ctx) =>
        Effect.gen(function* () {
          const agent = yield* ctx.agents.create({ cwd: '/work', options: { route: 'fake/model' } })
          const poke: ToolDefinition<{}, { readonly ok: boolean }> = {
            name: 'poke',
            description: 'Queues one note while it runs',
            parameters: Schema.Struct({}),
            output: {
              schema: Schema.Struct({ ok: Schema.Boolean }),
              render: () => [{ type: 'text', text: 'poked' }],
            },
            execute: () =>
              agent.inject({ text: note, source: 'inject' }).pipe(
                Effect.mapError(
                  () => new ToolError({ code: 'execution', message: 'cannot queue the note' }),
                ),
                Effect.as({ ok: true }),
              ),
          }
          yield* ctx.tools.register(poke)
          yield* agent.followup({ text: 'go', source: 'user' })
          yield* agent.whenIdle
          return agent
        }),
    )

    const kinds = types(events)
    const stored = events.session.events()
    const result = kinds.indexOf('tool/result')
    const injected = stored.findIndex(
      (event) => event.type === 'user/message' && event.data.source === 'inject',
    )
    // The note is in the log before the answer of the step that carried it.
    const answer = kinds.indexOf('assistant/message', result)

    expect(kinds.filter((type) => type === 'step/start')).toHaveLength(2)
    expect(injected).toBeGreaterThan(result)
    expect(injected).toBeLessThan(answer)
    expect(stored[injected]?.type === 'user/message' ? stored[injected].data.text : '').toBe(note)
  })

  test('a steer queued as the turn closes is delivered and whenIdle settles', async () => {
    const note = crypto.randomUUID()
    let steered = false
    const events = await scenario([chunks(textTurn('first')), chunks(textTurn('second'))], (ctx) =>
      Effect.gen(function* () {
        // The closing edge of a turn: the step loop already found no input, so
        // only the wake this steer offers can open the turn it is claimed by.
        yield* ctx.hooks.on('agent/turn-stopping', (agent) =>
          Effect.gen(function* () {
            if (steered) return
            steered = true
            yield* agent.steer({ text: note, source: 'inject' }).pipe(Effect.orDie)
          }),
        )
        const agent = yield* ctx.agents.create({ cwd: '/work', options: { route: 'fake/model' } })
        yield* agent.followup({ text: 'go', source: 'user' })
        yield* agent.whenIdle
        return agent
      }),
    )

    const stored = events.session.events()
    const delivered = stored.flatMap((event) =>
      event.type === 'user/message' && event.data.source === 'inject' ? [event.data.text] : [],
    )
    expect(types(events).filter((type) => type === 'turn/start')).toHaveLength(2)
    expect(delivered).toEqual([note])
    expect(events.inbox.pending).toBe(false)
  })

  test('a pre-step listener opens the turn with its messages', async () => {
    const note = crypto.randomUUID()
    const events = await scenario([chunks(textTurn('done'))], (ctx) =>
      Effect.gen(function* () {
        yield* ctx.hooks.on('agent/pre-step', (_input, next) =>
          Effect.map(next(), (decision) =>
            decision?.kind === 'reject'
              ? decision
              : {
                  kind: 'enter' as const,
                  messages: [{ text: note, source: 'inject' as const }],
                },
          ),
        )
        const agent = yield* ctx.agents.create({ cwd: '/work', options: { route: 'fake/model' } })
        yield* agent.followup({ text: 'go', source: 'user' })
        yield* agent.whenIdle
        return agent
      }),
    )

    const stored = events.session.events()
    const messages = stored.flatMap((event) =>
      event.type === 'user/message' ? [{ text: event.data.text, source: event.data.source }] : [],
    )
    expect(messages).toEqual([
      { text: note, source: 'inject' },
      { text: 'go', source: 'user' },
    ])
  })

  test('writes one request header per series and a new one when the tools change', async () => {
    const extra: ToolDefinition<{}, { readonly ok: boolean }> = {
      name: 'extra',
      description: 'A tool that appears later',
      parameters: Schema.Struct({}),
      output: {
        schema: Schema.Struct({ ok: Schema.Boolean }),
        render: () => [{ type: 'text', text: 'extra' }],
      },
      execute: () => Effect.succeed({ ok: true }),
    }
    const events = await scenario([chunks(textTurn('one')), chunks(textTurn('two'))], (ctx) =>
      Effect.gen(function* () {
        const agent = yield* ctx.agents.create({ cwd: '/work', options: { route: 'fake/model' } })
        yield* agent.followup({ text: 'first', source: 'user' })
        yield* agent.whenIdle
        yield* ctx.tools.register(extra)
        yield* agent.followup({ text: 'second', source: 'user' })
        yield* agent.whenIdle
        return agent
      }),
    )

    const headers = events.session
      .events()
      .flatMap((event) => (event.type === 'request/header' ? [event.data] : []))

    expect(headers.map((data) => data.series)).toEqual([1, 2])
    expect(headers.map((data) => data.reason)).toEqual(['opened', 'changed'])
    expect(headers[0]?.tools.map((tool) => tool.name)).toEqual([])
    expect(headers[1]?.tools.map((tool) => tool.name)).toEqual(['extra'])
  })

  test('the effort an agent was given is recorded as the field the provider reads', async () => {
    const events = await scenario([chunks(textTurn('hi'))], (ctx) =>
      Effect.gen(function* () {
        const agent = yield* ctx.agents.create({
          cwd: '/work',
          options: { route: 'fake/model', reasoningEffort: 'high' },
        })
        yield* agent.followup({ text: 'go', source: 'user' })
        yield* agent.whenIdle
        return agent
      }),
    )

    const header = events.session
      .events()
      .flatMap((event) => (event.type === 'request/header' ? [event.data] : []))[0]

    // Params reach the provider as written, so the effort uses the provider's own field.
    expect(header?.params).toEqual({ reasoning_effort: 'high' })
  })

  test('an effort a session was switched to reaches the request after the switch', async () => {
    const events = await scenario([chunks(textTurn('one')), chunks(textTurn('two'))], (ctx) =>
      Effect.gen(function* () {
        const agent = yield* ctx.agents.create({ cwd: '/work', options: { route: 'fake/model' } })
        yield* agent.followup({ text: 'first', source: 'user' })
        yield* agent.whenIdle
        yield* agent.setEffort('high')
        yield* agent.followup({ text: 'second', source: 'user' })
        yield* agent.whenIdle
        return agent
      }),
    )

    const params = events.session
      .events()
      .flatMap((event) => (event.type === 'request/header' ? [event.data.params] : []))

    // The first request named no effort; the one after the switch asks for it.
    expect(params).toEqual([{}, { reasoning_effort: 'high' }])
  })

  test('a route a session was switched to reaches the request after the switch', async () => {
    const events = await scenario([chunks(textTurn('one')), chunks(textTurn('two'))], (ctx) =>
      Effect.gen(function* () {
        const agent = yield* ctx.agents.create({ cwd: '/work', options: { route: 'fake/model' } })
        yield* agent.followup({ text: 'first', source: 'user' })
        yield* agent.whenIdle
        yield* agent.setRoute('other/model')
        yield* agent.followup({ text: 'second', source: 'user' })
        yield* agent.whenIdle
        return agent
      }),
    )

    const headers = events.session
      .events()
      .flatMap((event) => (event.type === 'request/header' ? [event.data] : []))

    // The switch is a change of route, so the log opens a second series rather
    // than reusing the header the session started with.
    expect(headers.map((data) => [data.provider, data.model, data.reason])).toEqual([
      ['fake', 'model', 'opened'],
      ['other', 'model', 'changed'],
    ])
  })

  test('an effort switched while a turn runs reaches that turn', async () => {
    const events = await scenario(
      [
        chunks([
          {
            type: 'block-end',
            index: 0,
            block: { type: 'tool-call', id: 'c1', name: 'switch-effort', arguments: '{}' },
          },
          { type: 'finish', kind: 'tool-calls' },
        ]),
        chunks(textTurn('done')),
      ],
      (ctx) =>
        Effect.gen(function* () {
          const agent = yield* ctx.agents.create({ cwd: '/work', options: { route: 'fake/model' } })
          // Anything the human does while the turn runs, standing in for the command.
          const pick: ToolDefinition<{}, { readonly ok: boolean }> = {
            name: 'switch-effort',
            description: 'switches the effort from inside a turn',
            parameters: Schema.Struct({}),
            output: {
              schema: Schema.Struct({ ok: Schema.Boolean }),
              render: () => [{ type: 'text', text: 'switched' }],
            },
            execute: () => agent.setEffort('high').pipe(Effect.as({ ok: true })),
          }
          yield* ctx.tools.register(pick)
          yield* agent.followup({ text: 'go', source: 'user' })
          yield* agent.whenIdle
          return agent
        }),
    )

    const params = events.session
      .events()
      .flatMap((event) => (event.type === 'request/header' ? [event.data.params] : []))

    // One turn, two requests: the one that called the tool, and the one after it.
    expect(params).toEqual([{}, { reasoning_effort: 'high' }])
  })

  test('a turn that changes nothing reuses the header it opened', async () => {
    const events = await scenario([chunks(textTurn('one')), chunks(textTurn('two'))], (ctx) =>
      Effect.gen(function* () {
        const agent = yield* ctx.agents.create({ cwd: '/work', options: { route: 'fake/model' } })
        yield* agent.followup({ text: 'first', source: 'user' })
        yield* agent.whenIdle
        yield* agent.followup({ text: 'second', source: 'user' })
        yield* agent.whenIdle
        return agent
      }),
    )

    const kinds = types(events)
    expect(kinds.filter((type) => type === 'request/header')).toHaveLength(1)
    expect(kinds.filter((type) => type === 'turn/start')).toHaveLength(2)
  })

  test('records the system prompt once across turns that keep it the same', async () => {
    const events = await scenario(
      [chunks(textTurn('one')), chunks(textTurn('two')), chunks(textTurn('three'))],
      (ctx) =>
        Effect.gen(function* () {
          const agent = yield* ctx.agents.create({ cwd: '/work', options: { route: 'fake/model' } })
          for (const text of ['first', 'second', 'third']) {
            yield* agent.followup({ text, source: 'user' })
            yield* agent.whenIdle
          }
          return agent
        }),
    )

    const prompts = events.session
      .events()
      .flatMap((event) => (event.type === 'system/message' ? [event.data.text] : []))

    expect(types(events).filter((type) => type === 'turn/start')).toHaveLength(3)
    expect(prompts).toHaveLength(1)
  })

  test('records a changed system prompt and sends both frames', async () => {
    let frame = 'first frame'
    const requests: Array<AgentRequest> = []
    const events = await scenario([chunks(textTurn('one')), chunks(textTurn('two'))], (ctx) =>
      Effect.gen(function* () {
        yield* ctx.prompt
          .section({ name: 'test-frame', order: 1, text: () => frame })
          .pipe(Effect.orDie)
        yield* ctx.hooks.on('agent/request', (request, next) =>
          Effect.map(next(), (adjusted) => {
            requests.push(adjusted ?? request)
            return adjusted
          }),
        )
        const agent = yield* ctx.agents.create({ cwd: '/work', options: { route: 'fake/model' } })
        yield* agent.followup({ text: 'first', source: 'user' })
        yield* agent.whenIdle
        frame = 'second frame'
        yield* agent.followup({ text: 'second', source: 'user' })
        yield* agent.whenIdle
        return agent
      }),
    )

    const prompts = events.session
      .events()
      .flatMap((event) => (event.type === 'system/message' ? [event.data.text] : []))
    const sent = (requests[1]?.messages ?? [])
      .filter((message) => message.role === 'system')
      .flatMap((message) =>
        message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])),
      )

    expect(prompts).toEqual(['first frame', 'second frame'])
    // The changed frame reaches the request without dropping the one it replaces.
    expect(sent).toEqual(['first frame', 'second frame'])
  })

  test('a resumed log with duplicate prompts does not append the frame again', async () => {
    const events = await scenario([chunks(textTurn('done'))], (ctx) =>
      Effect.gen(function* () {
        yield* ctx.prompt
          .section({ name: 'test-frame', order: 1, text: 'the frame' })
          .pipe(Effect.orDie)
        const agent = yield* ctx.agents.create({ cwd: '/work', options: { route: 'fake/model' } })
        // A session recorded by a run that appended the same prompt every turn.
        yield* agent.session.append('system/message', { text: 'the frame' })
        yield* agent.session.append('system/message', { text: 'the frame' })
        yield* agent.followup({ text: 'go', source: 'user' })
        yield* agent.whenIdle
        return agent
      }),
    )

    const prompts = events.session
      .events()
      .flatMap((event) => (event.type === 'system/message' ? [event.data.text] : []))

    expect(prompts).toEqual(['the frame', 'the frame'])
  })

  test('retries a failed attempt without repeating the request header', async () => {
    const text = crypto.randomUUID()
    const events = await scenario(
      [fails(new LlmFailure({ code: 'TIMEOUT', message: 'slow' })), chunks(textTurn(text))],
      (ctx) =>
        Effect.gen(function* () {
          yield* ctx.hooks.on('agent/request-error', () =>
            Effect.succeed({ kind: 'retry' as const }),
          )
          const agent = yield* ctx.agents.create({ cwd: '/work', options: { route: 'fake/model' } })
          yield* agent.followup({ text: 'go', source: 'user' })
          yield* agent.whenIdle
          return agent
        }),
    )

    const eventTypes = types(events)
    expect(eventTypes.filter((type) => type === 'assistant/attempt')).toHaveLength(1)
    expect(eventTypes.filter((type) => type === 'assistant/message')).toHaveLength(1)
    expect(eventTypes.filter((type) => type === 'request/header')).toHaveLength(1)
    expect(reason(events)).toEqual([{ kind: 'completed' }])
  })

  test('an installed retry policy retries a rate limit and logs the wait', async () => {
    const text = crypto.randomUUID()
    const events = await scenario(
      [fails(new LlmFailure({ code: 'RATE_LIMIT', message: 'slow down' })), chunks(textTurn(text))],
      (ctx) =>
        Effect.gen(function* () {
          yield* installRetry(ctx.hooks, { maxRetries: 1, initialDelayMs: 0, jitterRatio: 0 })
          const agent = yield* ctx.agents.create({ cwd: '/work', options: { route: 'fake/model' } })
          yield* agent.followup({ text: 'go', source: 'user' })
          yield* agent.whenIdle
          return agent
        }),
    )

    const log = events.session.events()
    const retries = log.flatMap((event) => (event.type === 'llm/retry' ? [event.data] : []))
    const started = log.flatMap((event) => (event.type === 'llm/retry-started' ? [event.data] : []))
    expect(retries).toMatchObject([
      { attempt: 1, code: 'RATE_LIMIT', delayMs: 0, cause: 'transient' },
    ])
    expect(retries[0]?.retryId).toEqual(expect.any(String))
    expect(started).toEqual([{ retryId: retries[0]?.retryId }])
    expect(reason(events)).toEqual([{ kind: 'completed' }])
  })

  test('a wait cut short still leaves the retry it started in the log', async () => {
    const events = await scenario(
      [fails(new LlmFailure({ code: 'RATE_LIMIT', message: 'slow down' }))],
      (ctx) =>
        Effect.gen(function* () {
          // Long enough that the wait is still running when the cancel lands.
          yield* installRetry(ctx.hooks, { maxRetries: 1, initialDelayMs: 60_000, jitterRatio: 0 })
          const agent = yield* ctx.agents.create({ cwd: '/work', options: { route: 'fake/model' } })
          yield* agent.followup({ text: 'go', source: 'user' })
          let retried = false
          for (let index = 0; index < 400 && !retried; index += 1) {
            yield* Effect.sleep(5)
            retried = agent.session.events().some((event) => event.type === 'llm/retry')
          }
          expect(retried).toBe(true)
          yield* agent.cancel('user')
          yield* agent.whenIdle
          return agent
        }),
    )

    const log = events.session.events()
    const retries = log.flatMap((event) => (event.type === 'llm/retry' ? [event.data] : []))
    const started = log.flatMap((event) => (event.type === 'llm/retry-started' ? [event.data] : []))
    expect(retries).toMatchObject([{ attempt: 1, code: 'RATE_LIMIT', cause: 'transient' }])
    expect(started).toEqual([])
    expect(reason(events)).toEqual([{ kind: 'cancelled', cause: 'user' }])
  })

  test('a context overflow compacts once and retries the rebuilt request', async () => {
    const huge = 'x'.repeat(200_000)
    const events = await scenario(
      [
        fails(new LlmFailure({ code: 'CONTEXT_WINDOW_EXCEEDED', message: 'too long' })),
        chunks(textTurn('the summary')),
        chunks(textTurn('done')),
      ],
      (ctx) =>
        Effect.gen(function* () {
          const agent = yield* ctx.agents.create({ cwd: '/work', options: { route: 'fake/model' } })
          yield* agent.session.append('user/message', { text: huge, source: 'user' })
          yield* agent.followup({ text: 'go', source: 'user' })
          yield* agent.whenIdle
          return agent
        }),
    )

    const retries = events.session
      .events()
      .flatMap((event) => (event.type === 'llm/retry' ? [event.data] : []))
    expect(retries).toMatchObject([
      { attempt: 1, code: 'CONTEXT_WINDOW_EXCEEDED', delayMs: 0, cause: 'context-overflow' },
    ])
    const started = events.session
      .events()
      .flatMap((event) => (event.type === 'llm/retry-started' ? [event.data] : []))
    expect(started).toEqual([{ retryId: retries[0]?.retryId }])
    expect(reason(events)).toEqual([{ kind: 'completed' }])
  })

  test('cancel records a cancelled turn end', async () => {
    const events = await scenario(
      [forever([{ type: 'block-start', index: 0, blockType: 'text' }])],
      (ctx) =>
        Effect.gen(function* () {
          const agent = yield* ctx.agents.create({ cwd: '/work', options: { route: 'fake/model' } })
          yield* agent.followup({ text: 'go', source: 'user' })
          for (let index = 0; index < 50 && agent.status !== 'running'; index += 1)
            yield* Effect.yieldNow
          expect(agent.status).toBe('running')
          yield* agent.cancel('user')
          yield* agent.whenIdle
          return agent
        }),
    )

    expect(reason(events)).toEqual([{ kind: 'cancelled', cause: 'user' }])
  })

  test('a cancel before the turn takes the message drops it, and the agent settles', async () => {
    const events = await scenario([forever([])], (ctx) =>
      Effect.gen(function* () {
        const agent = yield* ctx.agents.create({ cwd: '/work', options: { route: 'fake/model' } })
        yield* agent.followup({ text: 'go', source: 'user' })
        yield* agent.cancel('user')
        yield* agent.whenIdle
        return agent
      }),
    )

    expect(events.inbox.pending).toBe(false)
    expect(types(events)).not.toContain('turn/start')
  })

  test('the next message after a cancel runs a turn, and its failure is not the cancel', async () => {
    const events = await scenario(
      [
        forever([{ type: 'block-start', index: 0, blockType: 'text' }]),
        fails(new LlmFailure({ code: 'INVALID_REQUEST', message: 'bad' })),
      ],
      (ctx) =>
        Effect.gen(function* () {
          const agent = yield* ctx.agents.create({ cwd: '/work', options: { route: 'fake/model' } })
          yield* agent.followup({ text: 'go', source: 'user' })
          for (let index = 0; index < 50 && agent.status !== 'running'; index += 1)
            yield* Effect.yieldNow
          yield* agent.cancel('user')
          yield* agent.whenIdle
          yield* agent.followup({ text: 'once more', source: 'user' })
          yield* agent.whenIdle
          return agent
        }),
    )

    expect(reason(events).map((ended) => ended.kind)).toEqual(['cancelled', 'error'])
  })

  test('cancel during a tool call pairs the call with a synthesized result', async () => {
    const slow: ToolDefinition<{}, { readonly ok: boolean }> = {
      name: 'slow',
      description: 'Never finishes',
      parameters: Schema.Struct({}),
      output: {
        schema: Schema.Struct({ ok: Schema.Boolean }),
        render: () => [{ type: 'text', text: 'ok' }],
      },
      execute: () => Effect.sleep('1 hour').pipe(Effect.as({ ok: true })),
    }

    const events = await scenario(
      [
        chunks([
          {
            type: 'block-end',
            index: 0,
            block: { type: 'tool-call', id: 'c1', name: 'slow', arguments: '{}' },
          },
          { type: 'finish', kind: 'tool-calls' },
        ]),
        chunks(textTurn('done')),
      ],
      (ctx) =>
        Effect.gen(function* () {
          yield* ctx.tools.register(slow)
          const agent = yield* ctx.agents.create({ cwd: '/work', options: { route: 'fake/model' } })
          yield* agent.followup({ text: 'go', source: 'user' })
          for (let index = 0; index < 200; index += 1) {
            if (agent.session.events().some((event) => event.type === 'tool/call')) break
            yield* Effect.yieldNow
          }
          yield* agent.cancel('user')
          yield* agent.whenIdle
          return agent
        }),
    )

    const kinds = types(events)
    const callIndex = kinds.indexOf('tool/call')
    const resultIndex = kinds.indexOf('tool/result')
    const result = events.session.events().find((event) => event.type === 'tool/result')

    expect(callIndex).toBeGreaterThanOrEqual(0)
    expect(resultIndex).toBeGreaterThan(callIndex)
    expect(result?.data.isError).toBe(true)
    expect(reason(events)).toEqual([{ kind: 'cancelled', cause: 'user' }])
  })

  test('a call the previous run left open is answered before the next turn asks', async () => {
    const events = await scenario([chunks(textTurn('done'))], (ctx) =>
      Effect.gen(function* () {
        const agent = yield* ctx.agents.create({ cwd: '/work', options: { route: 'fake/model' } })
        // A run that ended between a call and its result — a killed process, a
        // question nobody answered — leaves the log holding a call no provider
        // accepts without an answer. The next turn says so before it asks again.
        yield* agent.session.append('tool/call', {
          callId: 'c1',
          name: 'echo',
          arguments: '{}',
        })
        yield* agent.followup({ text: 'go', source: 'user' })
        yield* agent.whenIdle
        return agent
      }),
    )

    const kinds = types(events)
    const result = events.session.events().find((event) => event.type === 'tool/result')
    expect(result?.data.isError).toBe(true)
    expect(result?.data.content).toEqual([
      {
        type: 'text',
        text: 'tool echo did not finish: its outcome is unknown. Do not retry blindly; retry only a read-only or idempotent call, and verify external state before retrying one with side effects.',
      },
    ])
    expect(kinds.indexOf('tool/result')).toBeLessThan(kinds.indexOf('turn/start'))
    expect(reason(events)).toEqual([{ kind: 'completed' }])
  })

  test('records parallel results in call order even when they finish out of order', async () => {
    const wait: ToolDefinition<
      { readonly ms: number; readonly label: string },
      { readonly label: string }
    > = {
      name: 'wait',
      description: 'Waits, then answers with its label',
      parameters: Schema.Struct({ ms: Schema.Number, label: Schema.String }),
      output: {
        schema: Schema.Struct({ label: Schema.String }),
        render: (_args, value) => [{ type: 'text', text: value.label }],
      },
      execute: (args) => Effect.sleep(`${args.ms} millis`).pipe(Effect.as({ label: args.label })),
      isConcurrencySafe: () => true,
    }
    const call = (index: number, id: string, ms: number, label: string) => ({
      type: 'block-end' as const,
      index,
      block: {
        type: 'tool-call' as const,
        id,
        name: 'wait',
        arguments: JSON.stringify({ ms, label }),
      },
    })
    const events = await scenario(
      [
        chunks([
          call(0, 'c1', 30, 'slow'),
          call(1, 'c2', 1, 'fast'),
          { type: 'finish', kind: 'tool-calls' },
        ]),
        chunks(textTurn('done')),
      ],
      (ctx) =>
        Effect.gen(function* () {
          yield* ctx.tools.register(wait)
          const agent = yield* ctx.agents.create({ cwd: '/work', options: { route: 'fake/model' } })
          yield* agent.followup({ text: 'go', source: 'user' })
          yield* agent.whenIdle
          return agent
        }),
    )

    const results = events.session
      .events()
      .flatMap((event) => (event.type === 'tool/result' ? [event.data.callId] : []))
    // The log pairs each call with its result in the order the model asked them.
    expect(results).toEqual(['c1', 'c2'])
  })

  test('runs at most ten calls at once in a parallel batch', async () => {
    let active = 0
    let peak = 0
    const probe: ToolDefinition<{}, { readonly ok: boolean }> = {
      name: 'probe',
      description: 'Counts how many of its calls are in flight',
      parameters: Schema.Struct({}),
      output: {
        schema: Schema.Struct({ ok: Schema.Boolean }),
        render: () => [{ type: 'text', text: 'ok' }],
      },
      execute: () =>
        Effect.gen(function* () {
          active += 1
          peak = Math.max(peak, active)
          yield* Effect.sleep('5 millis')
          active -= 1
          return { ok: true }
        }),
      isConcurrencySafe: () => true,
    }
    const calls = Array.from({ length: 12 }, (_, index) => ({
      type: 'block-end' as const,
      index,
      block: {
        type: 'tool-call' as const,
        id: `c${index}`,
        name: 'probe',
        arguments: '{}',
      },
    }))
    const events = await scenario(
      [chunks([...calls, { type: 'finish', kind: 'tool-calls' }]), chunks(textTurn('done'))],
      (ctx) =>
        Effect.gen(function* () {
          yield* ctx.tools.register(probe)
          const agent = yield* ctx.agents.create({ cwd: '/work', options: { route: 'fake/model' } })
          yield* agent.followup({ text: 'go', source: 'user' })
          yield* agent.whenIdle
          return agent
        }),
    )

    const results = events.session.events().filter((event) => event.type === 'tool/result')
    expect(results).toHaveLength(12)
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(10)
  })

  test('a resumed log closes the interrupted turn and separates started calls from unstarted ones', async () => {
    const events = await scenario([chunks(textTurn('done'))], (ctx) =>
      Effect.gen(function* () {
        const agent = yield* ctx.agents.create({ cwd: '/work', options: { route: 'fake/model' } })
        // The process died inside a turn: the turn and its step are open, one
        // call was dispatched, and the second request never left the log.
        yield* agent.session.append('turn/start', { turn: 1 })
        yield* agent.session.append('step/start', { step: 1 })
        yield* agent.session.append('assistant/message', {
          provider: 'fake',
          model: 'model',
          content: [
            { type: 'tool-call', id: 'c1', name: 'echo', arguments: '{}' },
            { type: 'tool-call', id: 'c2', name: 'echo', arguments: '{}' },
          ],
          stream: [],
        })
        yield* agent.session.append('tool/call', { callId: 'c1', name: 'echo', arguments: '{}' })
        yield* agent.followup({ text: 'go', source: 'user' })
        yield* agent.whenIdle
        return agent
      }),
    )

    const stored = events.session.events()
    const results = stored.flatMap((event) => (event.type === 'tool/result' ? [event.data] : []))
    expect(results.map((data) => data.callId)).toEqual(['c1', 'c2'])
    expect(results[0]?.content).toEqual([
      {
        type: 'text',
        text: 'tool echo did not finish: its outcome is unknown. Do not retry blindly; retry only a read-only or idempotent call, and verify external state before retrying one with side effects.',
      },
    ])
    expect(results[1]?.content).toEqual([
      { type: 'text', text: 'tool echo did not start; retry it if it is still needed.' },
    ])
    // The interrupted turn closes with its step, before the next turn opens.
    expect(reason(events)).toEqual([{ kind: 'interrupted' }, { kind: 'completed' }])
    const stepEnd = stored.findIndex((event) => event.type === 'step/end' && event.data.step === 1)
    const interrupted = stored.findIndex(
      (event) => event.type === 'turn/end' && event.data.reason.kind === 'interrupted',
    )
    const nextTurn = stored.findIndex(
      (event) => event.type === 'turn/start' && event.data.turn === 2,
    )
    expect(stepEnd).toBeGreaterThanOrEqual(0)
    expect(stepEnd).toBeLessThan(interrupted)
    expect(interrupted).toBeLessThan(nextTurn)
  })

  test('a restarted session runs every message still queued in its log', async () => {
    const first = 'finish the migration'
    const second = 'then run the tests'
    const events = await scenario([chunks(textTurn('done')), chunks(textTurn('done'))], (ctx) =>
      Effect.gen(function* () {
        const dead = yield* ctx.agents.create({ cwd: '/work', options: { route: 'fake/model' } })
        // A followup both appends the message and wakes the runner. The wake
        // does not survive the process, so a killed run leaves only the log.
        yield* dead.session.append('agent/inbox/queued', {
          target: 'next-turn',
          message: { text: first, source: 'user' },
        })
        yield* dead.session.append('agent/inbox/queued', {
          target: 'next-turn',
          message: { text: second, source: 'user' },
        })
        const id = dead.id
        yield* ctx.agents.dispose(id)
        const agent = yield* ctx.agents.create({
          cwd: '/work',
          resume: id,
          options: { route: 'fake/model' },
        })
        yield* agent.whenIdle
        return agent
      }),
    )

    const texts = events.session
      .events()
      .flatMap((event) =>
        event.type === 'user/message' && event.data.source === 'user' ? [event.data.text] : [],
      )
    expect(texts).toEqual([first, second])
    expect(reason(events)).toEqual([{ kind: 'completed' }, { kind: 'completed' }])
  })
})

describe('tool context', () => {
  const okTool = (
    name: string,
    fragment?: string,
  ): ToolDefinition<{}, { readonly ok: boolean }> => ({
    name,
    description: 'Adds a fragment for the next request',
    parameters: Schema.Struct({}),
    output: {
      schema: Schema.Struct({ ok: Schema.Boolean }),
      render: () => [{ type: 'text', text: 'ok' }],
    },
    execute: (_args, exec) =>
      Effect.sync(() => {
        if (fragment !== undefined) exec.addContext?.(fragment)
        return { ok: true }
      }),
  })

  const toolTurn = (id: string, name: string): ReadonlyArray<StreamChunk> => [
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: '{}' } },
    { type: 'finish', kind: 'tool-calls' },
  ]

  const userTexts = (request: AgentRequest | undefined): ReadonlyArray<string> =>
    (request?.messages ?? []).flatMap((message) =>
      message.role === 'user'
        ? message.content.flatMap((block) => (block.type === 'text' ? [block.text] : []))
        : [],
    )

  const capture = (requests: Array<AgentRequest>, ctx: Ctx) =>
    ctx.hooks.on('agent/request', (request, next) =>
      Effect.map(next(), (adjusted) => {
        requests.push(adjusted ?? request)
        return adjusted
      }),
    )

  test('a fragment a tool adds reaches the next request after its result', async () => {
    const fragment = 'the team left a note'
    const requests: Array<AgentRequest> = []
    const events = await scenario(
      [chunks(toolTurn('c1', 'note')), chunks(textTurn('done'))],
      (ctx) =>
        Effect.gen(function* () {
          yield* ctx.tools.register(okTool('note', fragment))
          yield* capture(requests, ctx)
          const agent = yield* ctx.agents.create({ cwd: '/work', options: { route: 'fake/model' } })
          yield* agent.followup({ text: 'go', source: 'user' })
          yield* agent.whenIdle
          return agent
        }),
    )

    expect(userTexts(requests[1])).toEqual(['go', fragment])
    expect(requests[1]?.messages.at(-1)?.role).toBe('user')
    expect(requests[1]?.messages.at(-2)?.role).toBe('tool')
    const recorded = events.session
      .events()
      .flatMap((event) =>
        event.type === 'tool/context'
          ? [{ callId: event.data.callId, text: event.data.text, source: event.data.source }]
          : [],
      )
    expect(recorded).toEqual([{ callId: 'c1', text: fragment, source: 'inject' }])
  })

  test('a tool that adds nothing leaves the next request unchanged', async () => {
    const requests: Array<AgentRequest> = []
    await scenario([chunks(toolTurn('c1', 'quiet')), chunks(textTurn('done'))], (ctx) =>
      Effect.gen(function* () {
        yield* ctx.tools.register(okTool('quiet'))
        yield* capture(requests, ctx)
        const agent = yield* ctx.agents.create({ cwd: '/work', options: { route: 'fake/model' } })
        yield* agent.followup({ text: 'go', source: 'user' })
        yield* agent.whenIdle
      }),
    )

    expect(userTexts(requests[1])).toEqual(['go'])
    expect(requests[1]?.messages.at(-1)?.role).toBe('tool')
  })

  test('a fragment is carried by one request and not the one after it', async () => {
    const fragment = 'one step only'
    const requests: Array<AgentRequest> = []
    await scenario(
      [chunks(toolTurn('c1', 'note')), chunks(toolTurn('c2', 'quiet')), chunks(textTurn('done'))],
      (ctx) =>
        Effect.gen(function* () {
          yield* ctx.tools.register(okTool('note', fragment))
          yield* ctx.tools.register(okTool('quiet'))
          yield* capture(requests, ctx)
          const agent = yield* ctx.agents.create({ cwd: '/work', options: { route: 'fake/model' } })
          yield* agent.followup({ text: 'go', source: 'user' })
          yield* agent.whenIdle
        }),
    )

    expect(userTexts(requests[1])).toEqual(['go', fragment])
    expect(userTexts(requests[2])).toEqual(['go'])
  })
})
