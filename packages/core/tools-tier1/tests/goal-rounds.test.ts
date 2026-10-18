import type { Agent, AgentsShape } from '@jozo-harness/agent'
import type { SessionEvent } from '@jozo-harness/session'
import { Deferred, Effect, Fiber } from 'effect'
import { describe, expect, test } from 'vitest'
import { goalRoundDecision, startGoalRound, type GoalState } from '../src/index.ts'

const event = (seq: number, type: string, data: unknown): SessionEvent =>
  ({ seq, time: seq, type, data }) as unknown as SessionEvent

const goal = (seq: number, phase: string, maxGoalRounds = 256): SessionEvent =>
  event(seq, 'goal/updated', { objective: 'ship it', phase, maxGoalRounds })

const round = (seq: number): SessionEvent =>
  event(seq, 'user/message', { text: 'continue', source: 'goal-round' })

describe('what the end of a turn means for the goal', () => {
  test('no goal, or a goal that is not active, asks for nothing', () => {
    expect(goalRoundDecision([])).toEqual({ kind: 'none' })
    expect(goalRoundDecision([goal(1, 'paused')])).toEqual({ kind: 'none' })
    expect(goalRoundDecision([goal(1, 'complete')])).toEqual({ kind: 'none' })
  })

  test('an active goal asks for the next round, counted from the log', () => {
    const decision = goalRoundDecision([goal(1, 'active'), round(2), round(3)])

    expect(decision).toMatchObject({ kind: 'round', round: 3 })
    expect(decision.kind === 'round' ? decision.text : '').toContain('Objective: ship it')
    expect(decision.kind === 'round' ? decision.text : '').toContain('Round: 3/256')
    expect(decision.kind === 'round' ? decision.text : '').toContain('action read')
  })

  test('a goal at its limit asks to be stopped instead', () => {
    const decision = goalRoundDecision([goal(1, 'active', 2), round(2), round(3)])

    expect(decision).toMatchObject({ kind: 'limit', state: { objective: 'ship it' } })
  })
})

/** An agent that writes down what the driver asked of it; its log accepts appends. */
const fakeAgent = (events: ReadonlyArray<SessionEvent>) => {
  const log = [...events]
  const sent: Array<{ text: string; source: string }> = []
  const appended: Array<GoalState> = []
  const agent = {
    session: {
      events: () => log,
      append: (_type: string, data: GoalState) =>
        Effect.sync(() => {
          appended.push(data)
          log.push(event(log.length + 1, 'goal/updated', data))
        }),
    },
    followup: (message: { text: string; source: string }) =>
      Effect.sync(() => {
        sent.push(message)
      }),
  } as unknown as Agent
  return { agent, sent, appended }
}

/** A child agent that reports when its wait starts and ends when the test says so. */
const childAgent = (id: string, whenIdle: Effect.Effect<void>): Agent =>
  ({ id, whenIdle }) as unknown as Agent

const fakeRegistry = (children: ReadonlyArray<Agent>): AgentsShape =>
  ({ childrenOf: () => children }) as unknown as AgentsShape

/** A registry with no children: the wait is a no-op. */
const noChildren = fakeRegistry([])

describe('starting the next round', () => {
  test('queues the round the goal asked for', async () => {
    const { agent, sent } = fakeAgent([goal(1, 'active')])

    await Effect.runPromise(startGoalRound(agent, noChildren))

    expect(sent).toHaveLength(1)
    expect(sent[0]?.source).toBe('goal-round')
    expect(sent[0]?.text).toContain('Round: 1/256')
  })

  test('stops a goal that has run its rounds, without queueing another', async () => {
    const { agent, sent, appended } = fakeAgent([
      goal(1, 'active', 1),
      round(2),
      goal(3, 'active', 1),
    ])

    await Effect.runPromise(startGoalRound(agent, noChildren))

    expect(sent).toEqual([])
    expect(appended).toHaveLength(1)
    expect(appended[0]).toMatchObject({ phase: 'blocked' })
    expect(appended[0]?.blockedReason).toContain('round-limit')
  })

  test('a paused goal is left alone', async () => {
    const { agent, sent, appended } = fakeAgent([goal(1, 'paused')])

    await Effect.runPromise(startGoalRound(agent, noChildren))

    expect(sent).toEqual([])
    expect(appended).toEqual([])
  })

  test('waits for a running child before queueing the round', async () => {
    const { agent, sent } = fakeAgent([goal(1, 'active')])
    const started = await Effect.runPromise(Deferred.make<void>())
    const idle = await Effect.runPromise(Deferred.make<void>())
    const child = childAgent(
      'child-1',
      Deferred.succeed(started, void 0).pipe(Effect.andThen(Deferred.await(idle))),
    )

    const fiber = Effect.runFork(startGoalRound(agent, fakeRegistry([child])))
    await Effect.runPromise(Deferred.await(started))

    // The child is still working: the round is not queued yet.
    expect(sent).toEqual([])

    await Effect.runPromise(Deferred.succeed(idle, void 0))
    await Effect.runPromise(Fiber.join(fiber))

    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).toContain('Round: 1/256')
  })

  test('a goal paused while the child runs queues no round', async () => {
    const { agent, sent } = fakeAgent([goal(1, 'active')])
    const started = await Effect.runPromise(Deferred.make<void>())
    const idle = await Effect.runPromise(Deferred.make<void>())
    const child = childAgent(
      'child-1',
      Deferred.succeed(started, void 0).pipe(Effect.andThen(Deferred.await(idle))),
    )

    const fiber = Effect.runFork(startGoalRound(agent, fakeRegistry([child])))
    await Effect.runPromise(Deferred.await(started))
    await Effect.runPromise(
      agent.session.append('goal/updated', {
        objective: 'ship it',
        phase: 'paused',
        maxGoalRounds: 256,
      }),
    )
    await Effect.runPromise(Deferred.succeed(idle, void 0))
    await Effect.runPromise(Fiber.join(fiber))

    expect(sent).toEqual([])
  })
})
