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
import {
  currentSchedules,
  makeScheduleTool,
  type Schedule,
  type ScheduleLog,
  type ScheduleWrite,
} from '../src/index.ts'

/** A log the tool can write to, standing in for the session. */
const fakeLog = (initial: ReadonlyArray<SessionEvent> = []) => {
  const events: Array<SessionEvent> = [...initial]
  let seq = events.length
  let counter = 0
  const log: ScheduleLog = {
    events: () => events,
    write: (write: ScheduleWrite) =>
      Effect.sync(() => {
        seq += 1
        const type = 'schedule/' + write.kind
        const data = write.kind === 'deleted' ? { id: write.id } : { schedule: write.schedule }
        events.push({ seq, time: seq, type, data } as unknown as SessionEvent)
      }),
    nextId: () => {
      counter += 1
      return 'sched-' + String(counter)
    },
    now: () => 1_000_000,
  }
  return { log, events }
}

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

describe('the schedule tool', () => {
  test('create records a rule and the prompt it delivers', async () => {
    const { log, events } = fakeLog()

    const result = await Effect.runPromise(
      call(makeScheduleTool(log), { action: 'create', every: 60, prompt: 'check the build' }),
    )

    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('schedule/created')
    expect(result?.value).toMatchObject({
      action: 'create',
      schedules: [
        { id: 'sched-1', rule: { kind: 'every', seconds: 60 }, prompt: 'check the build' },
      ],
    })
    expect(textOf(result)).toBe('scheduled sched-1 every 60s -> check the build')
  })

  test('create needs one rule and a prompt', async () => {
    const { log } = fakeLog()

    const noRule = await Effect.runPromise(
      call(makeScheduleTool(log), { action: 'create', prompt: 'x' }),
    )
    const twoRules = await Effect.runPromise(
      call(makeScheduleTool(log), { action: 'create', every: 60, daily: '08:00', prompt: 'x' }),
    )
    const noPrompt = await Effect.runPromise(
      call(makeScheduleTool(log), { action: 'create', every: 60 }),
    )

    expect(noRule?.isError).toBe(true)
    expect(textOf(noRule)).toContain('every, daily, weekly, or cron')
    expect(twoRules?.isError).toBe(true)
    expect(noPrompt?.isError).toBe(true)
    expect(textOf(noPrompt)).toContain('prompt')
  })

  test('a rule that never comes around is refused where the model can change it', async () => {
    const { log, events } = fakeLog()

    const result = await Effect.runPromise(
      call(makeScheduleTool(log), {
        action: 'create',
        cron: '0 0 30 2 *',
        prompt: 'never',
      }),
    )

    expect(result?.isError).toBe(true)
    expect(textOf(result)).toContain('never comes around')
    expect(events).toHaveLength(0)
  })

  test('list shows what stands, and says so when nothing does', async () => {
    const { log } = fakeLog()

    const empty = await Effect.runPromise(call(makeScheduleTool(log), { action: 'list' }))
    await Effect.runPromise(
      call(makeScheduleTool(log), { action: 'create', daily: '08:30', prompt: 'stand up' }),
    )
    const listed = await Effect.runPromise(call(makeScheduleTool(log), { action: 'list' }))

    expect(textOf(empty)).toBe('(no schedules)')
    expect(textOf(listed)).toBe('sched-1 daily at 08:30 -> stand up')
  })

  test('create records a short title, and the list shows the title', async () => {
    const { log, events } = fakeLog()

    const created = await Effect.runPromise(
      call(makeScheduleTool(log), {
        action: 'create',
        every: 60,
        prompt: 'run pnpm run check and report the failing jobs',
        title: 'check the build',
      }),
    )
    const listed = await Effect.runPromise(call(makeScheduleTool(log), { action: 'list' }))

    expect(events[0]?.type).toBe('schedule/created')
    expect(created?.value).toMatchObject({ schedules: [{ title: 'check the build' }] })
    expect(textOf(created)).toBe('scheduled sched-1 every 60s -> check the build')
    expect(textOf(listed)).toBe('sched-1 every 60s -> check the build')
  })

  test('a title longer than 120 characters is refused', async () => {
    const { log, events } = fakeLog()

    const result = await Effect.runPromise(
      call(makeScheduleTool(log), {
        action: 'create',
        every: 60,
        prompt: 'x',
        title: 'a'.repeat(121),
      }),
    )

    expect(result?.isError).toBe(true)
    expect(textOf(result)).toContain('120')
    expect(events).toHaveLength(0)
  })

  test('update changes the title', async () => {
    const { log } = fakeLog()
    await Effect.runPromise(
      call(makeScheduleTool(log), {
        action: 'create',
        every: 600,
        prompt: 'old words',
        title: 'old title',
      }),
    )

    const updated = await Effect.runPromise(
      call(makeScheduleTool(log), { action: 'update', id: 'sched-1', title: 'new title' }),
    )
    const listed = await Effect.runPromise(call(makeScheduleTool(log), { action: 'list' }))

    expect(updated?.value).toMatchObject({ schedules: [{ title: 'new title' }] })
    expect(textOf(listed)).toBe('sched-1 every 600s -> new title')
  })

  test('an older schedule without a title shows the first line of its prompt', async () => {
    const legacy = {
      seq: 1,
      time: 1,
      type: 'schedule/created',
      data: {
        schedule: {
          id: 'old',
          rule: { kind: 'every', seconds: 60 },
          prompt: 'first line\nsecond line',
          createdAt: 1,
        },
      },
    } as unknown as SessionEvent
    const { log } = fakeLog([legacy])

    const listed = await Effect.runPromise(call(makeScheduleTool(log), { action: 'list' }))

    expect(textOf(listed)).toBe('old every 60s -> first line')
  })

  test('update changes the rule or the words, delete removes it', async () => {
    const { log, events } = fakeLog()
    await Effect.runPromise(
      call(makeScheduleTool(log), { action: 'create', every: 600, prompt: 'old words' }),
    )

    const updated = await Effect.runPromise(
      call(makeScheduleTool(log), { action: 'update', id: 'sched-1', cron: '0 9 * * 1-5' }),
    )
    const deleted = await Effect.runPromise(
      call(makeScheduleTool(log), { action: 'delete', id: 'sched-1' }),
    )
    const missing = await Effect.runPromise(
      call(makeScheduleTool(log), { action: 'delete', id: 'sched-9' }),
    )

    expect(updated?.value).toMatchObject({
      schedules: [{ id: 'sched-1', rule: { kind: 'cron' }, prompt: 'old words' }],
    })
    expect(deleted?.isError).toBe(false)
    expect(missing?.isError).toBe(true)
    expect(currentSchedules(events)).toEqual([])
  })
})

describe('the schedules a log holds', () => {
  test('are the created and updated ones minus the deleted', () => {
    const { log, events } = fakeLog()
    const writeEvent = (each: ScheduleWrite) => log.write(each)
    const schedule = (id: string, prompt: string): Schedule => ({
      id,
      rule: { kind: 'every', seconds: 60 },
      prompt,
      createdAt: 1,
    })

    return Effect.runPromise(
      Effect.gen(function* () {
        yield* writeEvent({ kind: 'created', schedule: schedule('a', 'first') })
        yield* writeEvent({ kind: 'created', schedule: schedule('b', 'second') })
        yield* writeEvent({ kind: 'updated', schedule: schedule('a', 'changed') })
        yield* writeEvent({ kind: 'deleted', id: 'b' })

        expect(currentSchedules(events).map((each) => [each.id, each.prompt])).toEqual([
          ['a', 'changed'],
        ])
      }),
    )
  })
})
