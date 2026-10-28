import { describe, expect, test } from 'vitest'
import {
  compositionPlan,
  compositionWritable,
  currentPreset,
  describePreset,
  presetChange,
  presetProblem,
  presetResumable,
  presetTools,
  presetWithTools,
  type SessionEvent,
} from '../src/index.ts'

const event = (seq: number, type: string, data: unknown): SessionEvent =>
  ({ seq, time: seq, type, data }) as unknown as SessionEvent

const selected = (
  seq: number,
  profiles: ReadonlyArray<string>,
  tools: ReadonlyArray<string>,
): SessionEvent => event(seq, 'preset/selected', { profiles, tools })

const CODE = ['read', 'write', 'edit', 'glob', 'grep', 'bash']

describe('the composition a session was started with', () => {
  test('is the newest record in the log, and nothing before the first one', () => {
    expect(currentPreset([])).toBeUndefined()
    const events = [
      selected(1, ['headless'], CODE),
      event(2, 'turn/start', { turn: 1 }),
      selected(3, ['repl'], CODE),
    ]

    expect(currentPreset(events)).toEqual({ profiles: ['repl'], tools: CODE })
  })

  test('the same composition is no problem at all', () => {
    const recorded = { profiles: ['headless', 'base'], tools: CODE }

    expect(
      presetProblem(recorded, { profiles: ['headless', 'base'], tools: [...CODE] }),
    ).toBeUndefined()
  })

  test('a different profile set is named', () => {
    const problem = presetProblem(
      { profiles: ['headless'], tools: CODE },
      { profiles: ['repl'], tools: CODE },
    )

    expect(problem).toContain('profiles')
    expect(problem).toContain('headless')
    expect(problem).toContain('repl')
  })

  test('tools that went missing and tools that arrived are both named', () => {
    const missing = presetProblem(
      { profiles: ['headless'], tools: CODE },
      { profiles: ['headless'], tools: ['read', 'glob', 'grep'] },
    )
    const added = presetProblem(
      { profiles: ['headless'], tools: ['read'] },
      { profiles: ['headless'], tools: ['read', 'write'] },
    )

    expect(missing).toContain('gone: bash, edit, write')
    expect(added).toContain('new: write')
  })

  test('a tool this build added is picked up without asking', () => {
    const change = presetChange(
      { profiles: ['headless'], tools: ['read'] },
      { profiles: ['headless'], tools: ['read', 'write'] },
    )

    expect(change).toEqual({ profilesChanged: false, gone: [], added: ['write'] })
    expect(change !== undefined && presetResumable(change)).toBe(true)
  })

  test('a lost tool or a different profile still stops the run', () => {
    expect(presetResumable({ profilesChanged: false, gone: ['write'], added: [] })).toBe(false)
    expect(presetResumable({ profilesChanged: true, gone: [], added: ['write'] })).toBe(false)
  })

  test('the same composition is no change at all', () => {
    expect(
      presetChange(
        { profiles: ['headless'], tools: CODE },
        { profiles: ['headless'], tools: [...CODE] },
      ),
    ).toBeUndefined()
  })

  test('the next step is offered only the tools the session last chose', () => {
    const offered = ['read', 'write', 'bash', 'grep']
    const events = [selected(1, ['headless'], ['read', 'bash'])]

    expect(
      presetTools(
        events,
        offered.map((name) => ({ name })),
      ),
    ).toEqual([{ name: 'read' }, { name: 'bash' }])
  })

  test('a session that never chose a set is offered every tool', () => {
    expect(presetTools([], [{ name: 'read' }, { name: 'bash' }])).toEqual([
      { name: 'read' },
      { name: 'bash' },
    ])
  })

  test('a chosen set keeps the profile rows it was started with', () => {
    expect(
      presetWithTools({ profiles: ['headless', 'base'], tools: ['read'] }, ['read', 'grep']),
    ).toEqual({ profiles: ['headless', 'base'], tools: ['read', 'grep'] })
  })

  test('a tool this run does not offer is named before anything is written', () => {
    const plan = compositionPlan(['read', 'bash'], ['read', 'write'], ['read', 'bash', 'edit'])

    expect(plan).toEqual({ missing: ['edit'], added: ['bash'], removed: ['write'] })
    expect(compositionWritable(plan)).toBe(false)
  })

  test('a set every chosen tool can supply is writable', () => {
    const plan = compositionPlan(['read', 'bash', 'grep'], ['read', 'bash'], ['read', 'grep'])

    expect(plan.missing).toEqual([])
    expect(compositionWritable(plan)).toBe(true)
    expect(plan.added).toEqual(['grep'])
    expect(plan.removed).toEqual(['bash'])
  })

  test('a composition reads like something a human would say', () => {
    expect(describePreset({ profiles: ['headless', 'base'], tools: ['read', 'bash'] })).toBe(
      'profiles headless, base; 2 tools',
    )
    expect(describePreset({ profiles: [], tools: [] })).toBe('profiles none; 0 tools')
  })
})
