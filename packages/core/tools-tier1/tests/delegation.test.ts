import type { AgentsShape } from '@jozo-harness/agent'
import { describe, expect, test } from 'vitest'
import {
  DELEGATION_MAX_DEPTH,
  delegationLine,
  delegationRefusal,
  eventsOfAgent,
} from '../src/index.ts'

const fakeAgents = (depth: number, events: ReadonlyArray<never> = []): AgentsShape =>
  ({
    depthOf: () => depth,
    get: (id: string) => (id === 's1' ? { session: { events: () => events } } : undefined),
  }) as unknown as AgentsShape

describe('the delegation depth', () => {
  test('a child may delegate, while the depth below it may not', () => {
    expect(DELEGATION_MAX_DEPTH).toBe(1)
    expect(delegationRefusal(fakeAgents(0), 's1')).toBeUndefined()
    const refusal = delegationRefusal(fakeAgents(1), 's1')
    expect(refusal?.code).toBe('execution')
    expect(refusal?.message).toContain('delegation depth')
  })

  test('the limit is read when the call is made, so a change reaches the next one', () => {
    let limit = 0
    const read = () => limit

    expect(delegationRefusal(fakeAgents(0), 's1', read)?.message).toContain('(0)')
    limit = 2
    expect(delegationRefusal(fakeAgents(0), 's1', read)).toBeUndefined()
    expect(delegationLine(1, read)).toBeUndefined()
    limit = 1
    expect(delegationLine(1, read)).toContain('maximum 1')
  })

  test('the runtime line speaks only at the limit', () => {
    expect(delegationLine(0)).toBeUndefined()
    expect(delegationLine(DELEGATION_MAX_DEPTH)).toBe(
      'Delegation depth for subagent: current 1, maximum 1, remaining levels 0. Do not call subagent at this depth; carry out the work directly.',
    )
  })

  test('the events of the calling agent are the ones a fork reads', () => {
    const events = [{ type: 'assistant/message' }] as unknown as ReadonlyArray<never>
    expect(eventsOfAgent(fakeAgents(0, events), 's1')).toBe(events)
    expect(eventsOfAgent(fakeAgents(0), 'nowhere')).toEqual([])
  })
})
