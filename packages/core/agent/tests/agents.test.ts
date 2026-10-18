import { describe, expect, test } from 'vitest'
import { Hooks, HooksLive } from '@jozo-harness/kernel'
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
import { Effect, Queue, type Scope } from 'effect'
import {
  AgentInitError,
  Agents,
  agentsLayer,
  type AgentError,
  type AgentRunner,
  type UserMessage,
} from '../src/index.ts'

const makePersistence = (): SessionPersistence => {
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

const message = (text: string): UserMessage => ({ text, source: 'user' })

/** A runner that answers every wake with one completed turn. */
const turnRunner = (): AgentRunner => ({
  run: (agent) =>
    Effect.gen(function* () {
      while (true) {
        yield* Queue.take(agent.driver.wake)
        if (!agent.inbox.pending) continue
        yield* agent.driver.setStatus('running')
        const claimed = yield* agent.inbox.claim(true)
        const turn =
          agent.session.events().filter((event) => event.type === 'turn/start').length + 1
        yield* agent.session.append('turn/start', { turn })
        for (const input of claimed) {
          yield* agent.session.append('user/message', { text: input.text, source: input.source })
        }
        yield* agent.session.append('turn/end', { turn, reason: { kind: 'completed' } })
        yield* agent.driver.setStatus('idle')
      }
    }).pipe(Effect.catchCause(() => Effect.void)),
})

const withAgents = <A>(
  runner: AgentRunner,
  body: () => Effect.Effect<A, AgentError, Agents | Hooks | Scope.Scope>,
) =>
  Effect.runPromise(
    Effect.scoped(body()).pipe(
      Effect.provide(agentsLayer(runner)),
      Effect.provide(sessionsLayer(makePersistence(), { now: () => 1 })),
      Effect.provide(HooksLive),
    ),
  )

describe('Agents', () => {
  test('creates an agent over a fresh session and lists it', async () => {
    const created = await withAgents(turnRunner(), () =>
      Effect.gen(function* () {
        const agents = yield* Agents
        const agent = yield* agents.create({
          cwd: '/work',
          options: { route: 'ollama-cloud/qwen3-coder:480b' },
        })
        return {
          id: agent.id,
          status: agent.status,
          listed: agents.list().map((entry) => entry.id),
        }
      }),
    )

    expect(created.status).toBe('idle')
    expect(created.listed).toEqual([created.id])
  })

  test('followup wakes the runner, runs one turn, and records the message', async () => {
    const text = crypto.randomUUID()
    const events = await withAgents(turnRunner(), () =>
      Effect.gen(function* () {
        const agents = yield* Agents
        const agent = yield* agents.create({ cwd: '/work', options: { route: 'r' } })
        yield* agent.followup(message(text))
        yield* agent.whenIdle
        return {
          types: agent.session.events().map((event) => event.type),
          texts: agent.session
            .events()
            .flatMap((event) => (event.type === 'user/message' ? [event.data.text] : [])),
          status: agent.status,
        }
      }),
    )

    expect(events.types).toEqual([
      'session/header',
      'agent/inbox/queued',
      'agent/inbox/claimed',
      'turn/start',
      'user/message',
      'turn/end',
    ])
    expect(events.texts).toEqual([text])
    expect(events.status).toBe('idle')
  })

  test('steer waits for a wake and is claimed with the next turn', async () => {
    const steered = crypto.randomUUID()
    const turn = crypto.randomUUID()
    const seen = await withAgents(turnRunner(), () =>
      Effect.gen(function* () {
        const agents = yield* Agents
        const agent = yield* agents.create({ cwd: '/work', options: { route: 'r' } })
        yield* agent.steer(message(steered))
        yield* Effect.yieldNow
        const beforeWake = agent.session
          .events()
          .filter((event) => event.type === 'turn/start').length
        yield* agent.followup(message(turn))
        yield* agent.whenIdle
        return {
          beforeWake,
          users: agent.session
            .events()
            .flatMap((event) => (event.type === 'user/message' ? [event.data.text] : [])),
        }
      }),
    )

    expect(seen.beforeWake).toBe(0)
    expect(seen.users).toEqual([steered, turn])
  })

  test('cancel interrupts a running turn and returns the agent to idle', async () => {
    const blocking: AgentRunner = {
      run: (agent) =>
        Effect.gen(function* () {
          yield* Queue.take(agent.driver.wake)
          yield* agent.driver.setStatus('running')
          yield* agent.inbox.claim(true)
          yield* agent.session.append('turn/start', { turn: 1 })
          yield* Effect.sleep('1 hour')
        }).pipe(Effect.catchCause(() => Effect.void)),
    }

    const status = await withAgents(blocking, () =>
      Effect.gen(function* () {
        const agents = yield* Agents
        const agent = yield* agents.create({ cwd: '/work', options: { route: 'r' } })
        yield* agent.followup(message('go'))
        yield* Effect.yieldNow
        yield* Effect.yieldNow
        expect(agent.status).toBe('running')
        yield* agent.cancel('user')
        yield* agent.whenIdle
        const current = agent.status
        yield* agents.disposeAll()
        return current
      }),
    )

    expect(status).toBe('idle')
  })

  test('agent/created runs before the runner starts', async () => {
    const order: Array<string> = []
    const runner: AgentRunner = {
      run: (agent) =>
        Effect.sync(() => {
          order.push('runner')
        }).pipe(Effect.andThen(Queue.take(agent.driver.wake))),
    }

    await withAgents(runner, () =>
      Effect.gen(function* () {
        const hooks = yield* Hooks
        yield* hooks.on('agent/created', () =>
          Effect.sync(() => {
            order.push('created')
          }),
        )
        const agents = yield* Agents
        yield* agents.create({ cwd: '/work', options: { route: 'r' } })
        yield* Effect.yieldNow
        yield* agents.disposeAll()
      }),
    )

    expect(order).toEqual(['created', 'runner'])
  })

  test('a failing agent/created rolls the agent back', async () => {
    const order: Array<string> = []
    const runner: AgentRunner = {
      run: () =>
        Effect.sync(() => {
          order.push('runner')
        }),
    }

    const result = await withAgents(runner, () =>
      Effect.gen(function* () {
        const hooks = yield* Hooks
        yield* hooks.on('agent/created', () =>
          Effect.fail(new AgentInitError({ code: 'init', message: 'rejected' })),
        )
        const agents = yield* Agents
        const outcome = yield* Effect.match(
          agents.create({ cwd: '/work', options: { route: 'r' } }),
          {
            onFailure: (error: AgentError) => ({ ok: false as const, error }),
            onSuccess: () => ({ ok: true as const }),
          },
        )
        return { outcome, listed: agents.list().length }
      }),
    )

    expect(result.outcome.ok).toBe(false)
    expect(result.outcome.ok ? undefined : result.outcome.error).toBeInstanceOf(AgentInitError)
    expect(result.listed).toBe(0)
    expect(order).toEqual([])
  })

  test('the effort of a session can be switched, and switched off again', async () => {
    const seen = await withAgents(turnRunner(), () =>
      Effect.gen(function* () {
        const agents = yield* Agents
        const agent = yield* agents.create({
          cwd: '/work',
          options: { route: 'r', reasoningEffort: 'low' },
        })
        const started = agent.options.reasoningEffort
        yield* agent.setEffort('high')
        const switched = agent.options.reasoningEffort
        yield* agent.setEffort('')
        return {
          started,
          switched,
          cleared: agent.options.reasoningEffort,
          // The switch changes the effort and leaves the rest of the options as they were.
          route: agent.options.route,
        }
      }),
    )

    expect(seen.started).toBe('low')
    expect(seen.switched).toBe('high')
    expect(seen.cleared).toBeUndefined()
    expect(seen.route).toBe('r')
  })

  test('the route of a session can be switched on its own', async () => {
    const seen = await withAgents(turnRunner(), () =>
      Effect.gen(function* () {
        const agents = yield* Agents
        const agent = yield* agents.create({
          cwd: '/work',
          options: { route: 'stub/model', reasoningEffort: 'low' },
        })
        const started = agent.options.route
        yield* agent.setRoute('stub/other')
        return {
          started,
          switched: agent.options.route,
          // The switch changes the route and leaves the rest of the options as they were.
          effort: agent.options.reasoningEffort,
        }
      }),
    )

    expect(seen.started).toBe('stub/model')
    expect(seen.switched).toBe('stub/other')
    expect(seen.effort).toBe('low')
  })

  test('childrenOf answers only the agents this one started', async () => {
    const seen = await withAgents(turnRunner(), () =>
      Effect.gen(function* () {
        const agents = yield* Agents
        const left = yield* agents.create({ cwd: '/work', options: { route: 'r' } })
        const right = yield* agents.create({ cwd: '/work', options: { route: 'r' } })
        const leftChild = yield* agents.create({
          cwd: '/work',
          options: { route: 'r' },
          parent: left.id,
        })
        return {
          left: agents.childrenOf(left.id).map((agent) => agent.id),
          right: agents.childrenOf(right.id).map((agent) => agent.id),
          child: leftChild.id,
          all: agents.list().length,
        }
      }),
    )

    expect(seen.left).toEqual([seen.child])
    expect(seen.right).toEqual([])
    expect(seen.all).toBe(3)
  })

  test('cancelling a parent cancels the child it started', async () => {
    const interrupted: Array<string> = []
    const blocking: AgentRunner = {
      run: (agent) =>
        Effect.gen(function* () {
          while (true) {
            yield* Queue.take(agent.driver.wake)
            if (!agent.inbox.pending) continue
            yield* agent.driver.setStatus('running')
            yield* agent.inbox.claim(true)
            yield* Effect.never.pipe(Effect.ensuring(Effect.sync(() => interrupted.push(agent.id))))
          }
        }).pipe(Effect.catchCause(() => Effect.void)),
    }

    const seen = await withAgents(blocking, () =>
      Effect.gen(function* () {
        const agents = yield* Agents
        const parent = yield* agents.create({ cwd: '/work', options: { route: 'r' } })
        const child = yield* agents.create({
          cwd: '/work',
          options: { route: 'r' },
          parent: parent.id,
        })
        yield* parent.followup(message('go'))
        yield* child.followup(message('go'))
        while (parent.status !== 'running' || child.status !== 'running') yield* Effect.yieldNow
        yield* parent.cancel('user')
        yield* child.whenIdle
        return {
          child: child.id,
          interrupted: [...interrupted],
          parentStatus: parent.status,
          childStatus: child.status,
        }
      }),
    )

    // The parent's own turn is interrupted too; the child must be among them.
    expect(seen.interrupted).toContain(seen.child)
    expect(seen.parentStatus).toBe('idle')
    expect(seen.childStatus).toBe('idle')
  })

  test('disposing a parent disposes the child it started', async () => {
    const seen = await withAgents(turnRunner(), () =>
      Effect.gen(function* () {
        const agents = yield* Agents
        const parent = yield* agents.create({ cwd: '/work', options: { route: 'r' } })
        const child = yield* agents.create({
          cwd: '/work',
          options: { route: 'r' },
          parent: parent.id,
        })
        yield* agents.dispose(parent.id)
        return {
          child: agents.get(child.id),
          status: child.status,
          listed: agents.list().map((agent) => agent.id),
        }
      }),
    )

    expect(seen.child).toBeUndefined()
    expect(seen.status).toBe('disposed')
    expect(seen.listed).toEqual([])
  })
})
