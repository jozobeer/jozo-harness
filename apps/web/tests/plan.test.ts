import { describe, expect, test } from 'vitest'
import type { UiSessionEvent } from '@jozo-harness/ui-protocol'
import { planOf, planToolOf } from '../src/ui/plan.ts'
import { toolsOf, traceOf } from '../src/ui/trace.ts'

const event = (type: string, data: unknown, time: number): UiSessionEvent => ({
  seq: time,
  time,
  type,
  data,
})

const planArgs = (plan: string): string => JSON.stringify({ plan })

const called = (time: number, plan: string): UiSessionEvent =>
  event(
    'tool/call',
    {
      callId: 'call-1',
      name: 'exit_plan_mode',
      summary: 'exit_plan_mode',
      arguments: planArgs(plan),
    },
    time,
  )

const asked = (time: number, options: ReadonlyArray<string>): UiSessionEvent =>
  event(
    'interaction/ask/requested',
    { id: 'call-1', question: 'Leave plan mode and execute this plan?', options },
    time,
  )

const answered = (time: number, answer: string): UiSessionEvent =>
  event('interaction/ask/answered', { id: 'call-1', answer }, time)

const toolOf = (log: ReadonlyArray<UiSessionEvent>) => traceOf(log).flatMap(toolsOf)[0]

const OPTIONS = ['approve', 'keep planning']

describe('a plan a call proposed', () => {
  test('reads the plan out of the arguments the call carried', () => {
    const tool = toolOf([
      event('turn/start', { turn: 1 }, 10),
      event('step/start', { step: 1 }, 10),
      called(11, '# Plan\n\nread first'),
    ])

    expect(tool === undefined ? undefined : planOf(tool)?.text).toBe('# Plan\n\nread first')
  })

  test('stands proposed until the human answers the question', () => {
    const tool = toolOf([
      event('turn/start', { turn: 1 }, 10),
      event('step/start', { step: 1 }, 10),
      called(11, '# Plan'),
      asked(12, OPTIONS),
    ])

    expect(tool === undefined ? undefined : planOf(tool)?.verdict).toBe('proposed')
  })

  test('counts taking the offered approval as an approved plan', () => {
    const tool = toolOf([
      event('turn/start', { turn: 1 }, 10),
      event('step/start', { step: 1 }, 10),
      called(11, '# Plan'),
      asked(12, OPTIONS),
      answered(13, 'approve'),
    ])

    expect(tool === undefined ? undefined : planOf(tool)?.verdict).toBe('approved')
  })

  test('keeps the human own words as the reason plan mode stayed', () => {
    const tool = toolOf([
      event('turn/start', { turn: 1 }, 10),
      event('step/start', { step: 1 }, 10),
      called(11, '# Plan'),
      asked(12, OPTIONS),
      answered(13, 'split the migration out first'),
    ])

    expect(tool === undefined ? undefined : planOf(tool)?.reason).toBe(
      'split the migration out first',
    )
  })

  test('offers the choices the question recorded, approval first', () => {
    const tool = toolOf([
      event('turn/start', { turn: 1 }, 10),
      event('step/start', { step: 1 }, 10),
      called(11, '# Plan'),
      asked(12, OPTIONS),
    ])

    expect(tool === undefined ? undefined : planOf(tool)?.options).toEqual(OPTIONS)
  })

  test('proposes no plan for a call that carried none', () => {
    const tool = toolOf([
      event('turn/start', { turn: 1 }, 10),
      event('step/start', { step: 1 }, 10),
      event('tool/call', { callId: 'call-2', name: 'read', arguments: '{"path":"README.md"}' }, 11),
    ])

    expect(tool === undefined ? undefined : planOf(tool)).toBeUndefined()
  })

  test('proposes no plan when the arguments do not parse', () => {
    const tool = toolOf([
      event('turn/start', { turn: 1 }, 10),
      event('step/start', { step: 1 }, 10),
      event('tool/call', { callId: 'call-2', name: 'exit_plan_mode', arguments: '{nope' }, 11),
    ])

    expect(tool === undefined ? undefined : planOf(tool)).toBeUndefined()
  })

  test('finds the call again by id, as a pane reopened after a reload needs', () => {
    const turns = traceOf([
      event('turn/start', { turn: 1 }, 10),
      event('step/start', { step: 1 }, 10),
      called(11, '# Plan'),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 12),
    ])

    expect(planToolOf(turns, 'call-1')?.name).toBe('exit_plan_mode')
    expect(planToolOf(turns, 'call-9')).toBeUndefined()
  })
})
