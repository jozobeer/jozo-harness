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
  type ScheduleHost,
  type ScheduleWrite,
} from '../src/index.ts'

/** A host store the tool can write to, standing in for the shared file. */
const fakeHost = (initial: ReadonlyArray<Schedule> = []) => {
  let standing = [...initial]
  let counter = 0
  const writes: Array<ScheduleWrite> = []
  const host: ScheduleHost = {
    sessionId: 's1',
    list: () => standing,
    write: (write: ScheduleWrite) =>
      Effect.sync(() => {
        writes.push(write)
        if (write.kind === 'deleted') {
          standing = standing.filter((schedule) => schedule.id !== write.id)
          return
        }
        const exists = standing.some((schedule) => schedule.id === write.schedule.id)
        standing = exists
          ? standing.map((schedule) =>
              schedule.id === write.schedule.id ? write.schedule : schedule,
            )
          : [...standing, write.schedule]
      }),
    nextId: () => {
      counter += 1
      return 'sched-' + String(counter)
    },
    now: () => Date.parse('2026-10-14T09:00:00Z'),
  }
  return { host, writes, standing: () => standing }
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
    const { host, writes } = fakeHost()

    const result = await Effect.runPromise(
      call(makeScheduleTool(host), { action: 'create', every: 60, prompt: 'check the build' }),
    )

    expect(writes).toHaveLength(1)
    expect(writes[0]?.kind).toBe('created')
    expect(result?.value).toMatchObject({
      action: 'create',
      schedules: [
        { id: 'sched-1', rule: { kind: 'every', seconds: 60 }, prompt: 'check the build' },
      ],
    })
    expect(textOf(result)).toBe('scheduled sched-1 every 60s -> check the build')
  })

  test('create needs one rule and a prompt', async () => {
    const { host } = fakeHost()

    const noRule = await Effect.runPromise(
      call(makeScheduleTool(host), { action: 'create', prompt: 'x' }),
    )
    const twoRules = await Effect.runPromise(
      call(makeScheduleTool(host), { action: 'create', every: 60, daily: '08:00', prompt: 'x' }),
    )
    const noPrompt = await Effect.runPromise(
      call(makeScheduleTool(host), { action: 'create', every: 60 }),
    )

    expect(noRule?.isError).toBe(true)
    expect(textOf(noRule)).toContain('every, daily, weekly, cron, at, or after')
    expect(twoRules?.isError).toBe(true)
    expect(noPrompt?.isError).toBe(true)
    expect(textOf(noPrompt)).toContain('prompt')
  })

  test('a rule that never comes around is refused where the model can change it', async () => {
    const { host, writes } = fakeHost()

    const result = await Effect.runPromise(
      call(makeScheduleTool(host), {
        action: 'create',
        cron: '0 0 30 2 *',
        prompt: 'never',
      }),
    )

    expect(result?.isError).toBe(true)
    expect(textOf(result)).toContain('never comes around')
    expect(writes).toHaveLength(0)
  })

  test('list shows what stands, and says so when nothing does', async () => {
    const { host } = fakeHost()

    const empty = await Effect.runPromise(call(makeScheduleTool(host), { action: 'list' }))
    await Effect.runPromise(
      call(makeScheduleTool(host), { action: 'create', daily: '08:30', prompt: 'stand up' }),
    )
    const listed = await Effect.runPromise(call(makeScheduleTool(host), { action: 'list' }))

    expect(textOf(empty)).toBe('(no schedules)')
    expect(textOf(listed)).toBe('sched-1 daily at 08:30 -> stand up')
  })

  test('create records a short title, and the list shows the title', async () => {
    const { host, writes } = fakeHost()

    const created = await Effect.runPromise(
      call(makeScheduleTool(host), {
        action: 'create',
        every: 60,
        prompt: 'run pnpm run check and report the failing jobs',
        title: 'check the build',
      }),
    )
    const listed = await Effect.runPromise(call(makeScheduleTool(host), { action: 'list' }))

    expect(writes[0]?.kind).toBe('created')
    expect(created?.value).toMatchObject({ schedules: [{ title: 'check the build' }] })
    expect(textOf(created)).toBe('scheduled sched-1 every 60s -> check the build')
    expect(textOf(listed)).toBe('sched-1 every 60s -> check the build')
  })

  test('create names a zone, an instant, or a delay, and refuses a past instant', async () => {
    const { host } = fakeHost()
    const tool = makeScheduleTool(host)

    const zoned = await Effect.runPromise(
      call(tool, {
        action: 'create',
        daily: '08:30',
        timeZone: 'Asia/Tokyo',
        prompt: 'good morning',
      }),
    )
    const at = await Effect.runPromise(
      call(tool, { action: 'create', at: '2026-10-14T18:30:00Z', prompt: 'once' }),
    )
    const after = await Effect.runPromise(
      call(tool, { action: 'create', after: 90, prompt: 'soon' }),
    )
    const past = await Effect.runPromise(
      call(tool, { action: 'create', at: '2020-01-01T00:00:00Z', prompt: 'gone' }),
    )
    const badZone = await Effect.runPromise(
      call(tool, { action: 'create', daily: '08:30', timeZone: 'Mars/Base', prompt: 'x' }),
    )

    expect(zoned?.value).toMatchObject({ schedules: [{ rule: { timeZone: 'Asia/Tokyo' } }] })
    expect(textOf(zoned)).toContain('(Asia/Tokyo)')
    expect(at?.value).toMatchObject({ schedules: [{ rule: { kind: 'at' } }] })
    expect(after?.value).toMatchObject({ schedules: [{ rule: { kind: 'after' } }] })
    expect(past?.isError).toBe(true)
    expect(textOf(past)).toContain('already in the past')
    expect(badZone?.isError).toBe(true)
    expect(textOf(badZone)).toContain('IANA')
  })

  test('pause keeps the schedule and resume brings it back', async () => {
    const { host } = fakeHost()
    const tool = makeScheduleTool(host)
    await Effect.runPromise(call(tool, { action: 'create', every: 60, prompt: 'x' }))

    const paused = await Effect.runPromise(call(tool, { action: 'pause', id: 'sched-1' }))
    const listed = await Effect.runPromise(call(tool, { action: 'list' }))
    const resumed = await Effect.runPromise(call(tool, { action: 'resume', id: 'sched-1' }))

    expect(paused?.value).toMatchObject({ schedules: [{ paused: true }] })
    expect(textOf(listed)).toBe('sched-1 every 60s -> x (paused)')
    expect(resumed?.value).toMatchObject({ schedules: [{ paused: false }] })
  })

  test('a title longer than 120 characters is refused', async () => {
    const { host, writes } = fakeHost()

    const result = await Effect.runPromise(
      call(makeScheduleTool(host), {
        action: 'create',
        every: 60,
        prompt: 'x',
        title: 'a'.repeat(121),
      }),
    )

    expect(result?.isError).toBe(true)
    expect(textOf(result)).toContain('120')
    expect(writes).toHaveLength(0)
  })

  test('update changes the title', async () => {
    const { host } = fakeHost()
    await Effect.runPromise(
      call(makeScheduleTool(host), {
        action: 'create',
        every: 600,
        prompt: 'old words',
        title: 'old title',
      }),
    )

    const updated = await Effect.runPromise(
      call(makeScheduleTool(host), { action: 'update', id: 'sched-1', title: 'new title' }),
    )
    const listed = await Effect.runPromise(call(makeScheduleTool(host), { action: 'list' }))

    expect(updated?.value).toMatchObject({ schedules: [{ title: 'new title' }] })
    expect(textOf(listed)).toBe('sched-1 every 600s -> new title')
  })

  test('an older schedule without a title shows the first line of its prompt', async () => {
    const { host } = fakeHost([
      {
        id: 'old',
        rule: { kind: 'every', seconds: 60 },
        prompt: 'first line\nsecond line',
        createdAt: 1,
      },
    ])

    const listed = await Effect.runPromise(call(makeScheduleTool(host), { action: 'list' }))

    expect(textOf(listed)).toBe('old every 60s -> first line')
  })

  test('update changes the rule or the words, delete removes it', async () => {
    const { host } = fakeHost()
    await Effect.runPromise(
      call(makeScheduleTool(host), { action: 'create', every: 600, prompt: 'old words' }),
    )

    const updated = await Effect.runPromise(
      call(makeScheduleTool(host), { action: 'update', id: 'sched-1', cron: '0 9 * * 1-5' }),
    )
    const deleted = await Effect.runPromise(
      call(makeScheduleTool(host), { action: 'delete', id: 'sched-1' }),
    )
    const missing = await Effect.runPromise(
      call(makeScheduleTool(host), { action: 'delete', id: 'sched-9' }),
    )

    expect(updated?.value).toMatchObject({
      schedules: [{ id: 'sched-1', rule: { kind: 'cron' }, prompt: 'old words' }],
    })
    expect(deleted?.isError).toBe(false)
    expect(missing?.isError).toBe(true)
    expect(host.list()).toEqual([])
  })
})

describe('the schedules a log holds', () => {
  test('are the created and updated ones minus the deleted', () => {
    const schedule = (id: string, prompt: string): Schedule => ({
      id,
      rule: { kind: 'every', seconds: 60 },
      prompt,
      createdAt: 1,
    })
    const event = (seq: number, type: string, data: unknown): SessionEvent =>
      ({ seq, time: seq, type, data }) as unknown as SessionEvent
    const events = [
      event(1, 'schedule/created', { schedule: schedule('a', 'first') }),
      event(2, 'schedule/created', { schedule: schedule('b', 'second') }),
      event(3, 'schedule/updated', { schedule: schedule('a', 'changed') }),
      event(4, 'schedule/deleted', { id: 'b' }),
    ]

    expect(currentSchedules(events).map((each) => [each.id, each.prompt])).toEqual([
      ['a', 'changed'],
    ])
  })
})
