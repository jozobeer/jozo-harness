import { HooksLive } from '@jozo-harness/kernel'
import type { SessionEvent } from '@jozo-harness/session'
import {
  Tools,
  toolsLayer,
  type ToolDefinition,
  type ToolError,
  type ToolExecutionResult,
} from '@jozo-harness/tools'
import { Context, Effect, Layer } from 'effect'
import { describe, expect, test } from 'vitest'
import { makeGoalTool, type GoalLog, type GoalState } from '../src/index.ts'

/** A log the tool can write to, standing in for the session. */
const fakeLog = (initial: ReadonlyArray<SessionEvent> = []) => {
  const events: Array<SessionEvent> = [...initial]
  let seq = events.length
  const log: GoalLog = {
    events: () => events,
    append: (state: GoalState) =>
      Effect.sync(() => {
        seq += 1
        events.push({
          seq,
          time: seq,
          type: 'goal/updated',
          data: state,
        } as unknown as SessionEvent)
      }),
  }
  return { log, events }
}

const event = (seq: number, type: string, data: unknown): SessionEvent =>
  ({ seq, time: seq, type, data }) as unknown as SessionEvent

const created = (seq: number): SessionEvent =>
  event(seq, 'goal/updated', { objective: 'aim', phase: 'active', maxGoalRounds: 256 })

const goalRound = (seq: number): SessionEvent =>
  event(seq, 'user/message', { text: 'continue', source: 'goal-round' })

const humanWord = (seq: number): SessionEvent =>
  event(seq, 'user/message', { text: 'stop this', source: 'user' })

const call = (
  tool: ToolDefinition<any, any>,
  args: unknown,
): Effect.Effect<ToolExecutionResult | undefined, ToolError, never> =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(Layer.provideMerge(toolsLayer, HooksLive))
      const tools = Context.get(context, Tools)
      yield* tools.register(tool)
      return yield* tools.call({
        callId: 'c1',
        tool: tool.name,
        arguments: JSON.stringify(args),
        context: { sessionId: 's1', cwd: '/work', callId: 'c1' },
      })
    }),
  )

const textOf = (result: ToolExecutionResult | undefined): string =>
  (result?.content ?? []).flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')

describe('the goal tool', () => {
  test('create records an objective the session can be resumed from', async () => {
    const { log, events } = fakeLog()

    const result = await Effect.runPromise(
      call(makeGoalTool(log), { action: 'create', objective: 'ship the thing' }),
    )

    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('goal/updated')
    expect(result?.value).toMatchObject({ objective: 'ship the thing', phase: 'active' })
    expect(textOf(result)).toContain('ship the thing')
  })

  test('create needs an objective', async () => {
    const { log, events } = fakeLog()

    const result = await Effect.runPromise(call(makeGoalTool(log), { action: 'create' }))

    expect(result?.isError).toBe(true)
    expect(textOf(result)).toContain('objective')
    expect(events).toHaveLength(0)
  })

  test('pause, resume, and complete move the phase in a turn a human started', async () => {
    const { log, events } = fakeLog([humanWord(1)])

    const created = await Effect.runPromise(
      call(makeGoalTool(log), { action: 'create', objective: 'aim' }),
    )
    const paused = await Effect.runPromise(call(makeGoalTool(log), { action: 'pause' }))
    const resumed = await Effect.runPromise(call(makeGoalTool(log), { action: 'resume' }))
    const completed = await Effect.runPromise(call(makeGoalTool(log), { action: 'complete' }))

    expect(created?.value).toMatchObject({ phase: 'active' })
    expect(paused?.value).toMatchObject({ phase: 'paused' })
    expect(resumed?.value).toMatchObject({ phase: 'active' })
    expect(completed?.value).toMatchObject({ phase: 'complete' })
    expect(events.filter((each) => each.type === 'goal/updated')).toHaveLength(4)
  })

  test('a turn the model started cannot pause or resume the goal', async () => {
    const { log, events } = fakeLog([created(1), goalRound(2)])

    const paused = await Effect.runPromise(call(makeGoalTool(log), { action: 'pause' }))
    const resumed = await Effect.runPromise(call(makeGoalTool(log), { action: 'resume' }))

    expect(paused?.isError).toBe(true)
    expect(textOf(paused)).toContain('human')
    expect(resumed?.isError).toBe(true)
    expect(textOf(resumed)).toContain('human')
    expect(events.filter((each) => each.type === 'goal/updated')).toHaveLength(1)
  })

  test('an automatic round that also received a steer still cannot block early', async () => {
    const { log } = fakeLog([
      created(1),
      goalRound(2),
      event(3, 'user/message', { text: 'a job finished', source: 'inject' }),
    ])

    const result = await Effect.runPromise(
      call(makeGoalTool(log), { action: 'blocked', blockedReason: 'waiting on the API' }),
    )

    expect(result?.isError).toBe(true)
    expect(textOf(result)).toContain('3')
  })

  test('moving a goal that is not there is refused', async () => {
    const { log } = fakeLog()

    const result = await Effect.runPromise(call(makeGoalTool(log), { action: 'pause' }))

    expect(result?.isError).toBe(true)
    expect(textOf(result)).toContain('no goal')
  })

  test('blocked needs a reason, and in an automatic round it needs rounds behind it', async () => {
    const { log } = fakeLog([created(1), goalRound(2), goalRound(3)])

    const noReason = await Effect.runPromise(call(makeGoalTool(log), { action: 'blocked' }))
    const tooEarly = await Effect.runPromise(
      call(makeGoalTool(log), { action: 'blocked', blockedReason: 'waiting on the API' }),
    )

    expect(noReason?.isError).toBe(true)
    expect(textOf(noReason)).toContain('blockedReason')
    expect(tooEarly?.isError).toBe(true)
    expect(textOf(tooEarly)).toContain('3')

    // One more round and the same blocker has persisted long enough to report.
    const { log: third, events } = fakeLog([created(1), goalRound(2), goalRound(3), goalRound(4)])
    const accepted = await Effect.runPromise(
      call(makeGoalTool(third), { action: 'blocked', blockedReason: 'waiting on the API' }),
    )

    expect(accepted?.isError).toBe(false)
    expect(accepted?.value).toMatchObject({
      phase: 'blocked',
      blockedReason: 'waiting on the API',
    })
    expect(events.at(-1)?.data).toMatchObject({ phase: 'blocked' })
  })

  test('a human asking for a stop may block after any number of rounds', async () => {
    const { log } = fakeLog([created(1), goalRound(2), humanWord(3)])

    const result = await Effect.runPromise(
      call(makeGoalTool(log), { action: 'blocked', blockedReason: 'the key is gone' }),
    )

    expect(result?.isError).toBe(false)
    expect(result?.value).toMatchObject({ phase: 'blocked' })
  })

  test('a phase change leaves the old blocker behind', async () => {
    const { log } = fakeLog([
      event(1, 'goal/updated', {
        objective: 'aim',
        phase: 'blocked',
        maxGoalRounds: 256,
        blockedReason: 'the key is gone',
      }),
      humanWord(2),
    ])

    const resumed = await Effect.runPromise(call(makeGoalTool(log), { action: 'resume' }))

    expect(resumed?.value).toMatchObject({ phase: 'active' })
    expect(resumed?.value).not.toHaveProperty('blockedReason')
  })

  test('read reports the goal, its rounds, and its blocker without writing', async () => {
    const { log, events } = fakeLog([
      event(1, 'goal/updated', {
        objective: 'aim',
        phase: 'blocked',
        maxGoalRounds: 10,
        blockedReason: 'the key is gone',
      }),
      goalRound(2),
      goalRound(3),
    ])

    const result = await Effect.runPromise(call(makeGoalTool(log), { action: 'read' }))

    expect(result?.isError).toBe(false)
    expect(result?.value).toMatchObject({
      action: 'read',
      objective: 'aim',
      phase: 'blocked',
      rounds: 2,
      maxGoalRounds: 10,
      blockedReason: 'the key is gone',
    })
    expect(textOf(result)).toContain('aim')
    expect(events).toHaveLength(3)
  })

  test('create refuses to replace a goal that already exists', async () => {
    const { log, events } = fakeLog([created(1)])

    const result = await Effect.runPromise(
      call(makeGoalTool(log), { action: 'create', objective: 'another aim' }),
    )

    expect(result?.isError).toBe(true)
    expect(textOf(result)).toContain('already exists')
    expect(textOf(result)).toContain('edit')
    expect(events).toHaveLength(1)
    expect(events[0]?.data).toMatchObject({ objective: 'aim' })
  })
})
