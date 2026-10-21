import { HooksLive } from '@jozo-harness/kernel'
import { decodeSessionEvent } from '@jozo-harness/session'
import { ToolError, Tools, toolsLayer, type ToolDefinition } from '@jozo-harness/tools'
import { Context, Effect, Layer, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import {
  currentPlanMode,
  makePlanMode,
  PLAN_MODE_TOOLS,
  planModeRestriction,
  type PlanModeName,
} from '../src/index.ts'

const tool = (name: string): ToolDefinition<{}, { readonly ok: boolean }> => ({
  name,
  description: 'Does nothing',
  parameters: Schema.Struct({}),
  output: {
    schema: Schema.Struct({ ok: Schema.Boolean }),
    render: () => [{ type: 'text', text: 'ok' }],
  },
  execute: () => Effect.succeed({ ok: true }),
})

/** Builds a workspace with the restriction installed, and a way to lift it. */
const build = (install: boolean) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(Layer.provideMerge(toolsLayer, HooksLive))
      const tools = Context.get(context, Tools)
      const planMode = makePlanMode()
      for (const name of ['read', 'write', 'bash', 'todo_write', 'exit_plan_mode']) {
        yield* tools.register(tool(name))
      }
      if (install) yield* planMode.install(tools)
      const before = tools.schemas().map((schema) => schema.name)
      const hiddenWrite = yield* tools.call({
        callId: 'c1',
        tool: 'write',
        arguments: '{}',
        context: { sessionId: 's1', cwd: '/tmp', callId: 'c1' },
      })
      yield* planMode.leave()
      const after = tools.schemas().map((schema) => schema.name)
      const allowedWrite = yield* tools.call({
        callId: 'c2',
        tool: 'write',
        arguments: '{}',
        context: { sessionId: 's1', cwd: '/tmp', callId: 'c2' },
      })
      return {
        before,
        hiddenWrite: hiddenWrite.isError,
        after,
        allowedWrite: allowedWrite.isError,
        active: planMode.active(),
      }
    }),
  )

describe('plan mode', () => {
  test('hides the tools that could change the workspace', async () => {
    const observed = await Effect.runPromise(build(true))

    expect(observed.before).toEqual(['read', 'todo_write', 'exit_plan_mode'])
    expect(observed.hiddenWrite).toBe(true)
  })

  test('without the restriction everything stays visible', async () => {
    const observed = await Effect.runPromise(build(false))

    expect(observed.before).toEqual(['read', 'write', 'bash', 'todo_write', 'exit_plan_mode'])
    expect(observed.hiddenWrite).toBe(false)
  })

  test('leaving plan mode brings the hidden tools back from the next call on', async () => {
    const observed = await Effect.runPromise(build(true))

    expect(observed.after).toContain('write')
    expect(observed.after).not.toContain('exit_plan_mode')
    expect(observed.allowedWrite).toBe(false)
    expect(observed.active).toBe(false)
  })

  test('the allowed list is the read-only set plus the way out', () => {
    const planMode = makePlanMode()

    expect(planModeRestriction(planMode.active).allows('read')).toBe(true)
    expect(planModeRestriction(planMode.active).allows('bash')).toBe(false)
    expect(PLAN_MODE_TOOLS).not.toContain('write')
    expect(PLAN_MODE_TOOLS).toContain('exit_plan_mode')
  })

  test('a session that never wrote a mode starts in plan mode', () => {
    expect(currentPlanMode([])).toBeUndefined()
    expect(makePlanMode().active()).toBe(true)
  })

  test('leaving records execute before the restriction lifts', async () => {
    const recorded: Array<PlanModeName> = []
    const planMode = makePlanMode({
      record: (mode) =>
        Effect.sync(() => {
          // A failed record must not lift the restriction, so the write comes first.
          expect(planMode.active()).toBe(true)
          recorded.push(mode)
        }),
    })

    await Effect.runPromise(planMode.leave())

    expect(recorded).toEqual(['execute'])
    expect(planMode.active()).toBe(false)
  })

  test('a failed record leaves the workspace tools hidden', async () => {
    const planMode = makePlanMode({
      record: () => Effect.fail(new ToolError({ code: 'execution', message: 'disk is gone' })),
    })

    const result = await Effect.runPromise(Effect.exit(planMode.leave()))

    expect(result._tag).toBe('Failure')
    expect(planMode.active()).toBe(true)
  })

  test('a log that already left plan mode resumes with the workspace tools', () => {
    const planMode = makePlanMode({ recorded: 'execute' })

    expect(planMode.active()).toBe(false)
    expect(planModeRestriction(planMode.active).allows('write')).toBe(true)
  })

  test('the newest mode in the log decides the state', () => {
    const events = [
      { seq: 2, time: 1, type: 'plan/mode', data: { mode: 'plan' } },
      { seq: 3, time: 2, type: 'plan/mode', data: { mode: 'execute' } },
      { seq: 4, time: 3, type: 'turn/start', data: { turn: 1 } },
    ] as const

    expect(currentPlanMode([...events])).toBe('execute')
  })

  test('a mode change decodes from the log', async () => {
    const event = await Effect.runPromise(
      decodeSessionEvent({
        seq: 5,
        time: 3,
        type: 'plan/mode',
        data: { mode: 'execute' },
      }),
    )

    expect(event?.type).toBe('plan/mode')
    expect(event?.type === 'plan/mode' ? event.data.mode : '').toBe('execute')
  })
})
