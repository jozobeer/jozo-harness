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
  SessionError,
  sessionsLayer,
  type OpenedSession,
  type SessionEvent,
  type SessionHeader,
  type SessionId,
  type SessionPersistence,
  type SessionSink,
  type SessionSummary,
} from '@jozo-harness/session'
import { SystemPrompt, makeSystemPrompt, type SystemPromptShape } from '@jozo-harness/system-prompt'
import {
  Tools,
  ToolError,
  makeTools,
  type ToolDefinition,
  type ToolRegistry,
} from '@jozo-harness/tools'
import { Effect, Layer, Schema, Scope, Stream } from 'effect'
import { AgentLoop, agentLoopLayer, type AgentRequest } from '../src/index.ts'

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

const sessionPersistence = (): SessionPersistence => {
  const stored = new Map<SessionId, { events: Array<SessionEvent> }>()
  const opened = (id: SessionId): OpenedSession => {
    const record = stored.get(id)
    if (record === undefined) throw new Error('missing session')
    const sink: SessionSink = {
      append: (event) =>
        Effect.sync(() => {
          record.events.push(event)
        }),
      flush: () => Effect.void,
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
      const runner = yield* AgentLoop.pipe(Effect.provide(Layer.provide(agentLoopLayer, services)))
      const app = Layer.provideMerge(
        Layer.provide(agentsLayer(runner), sessionsLayer(sessionPersistence(), { now: () => 1 })),
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
    expect(result?.data.content).toEqual([{ type: 'text', text: 'tool echo did not finish' }])
    expect(kinds.indexOf('tool/result')).toBeLessThan(kinds.indexOf('turn/start'))
    expect(reason(events)).toEqual([{ kind: 'completed' }])
  })
})
