import type { Agent, AgentStatus, AgentsShape } from '@jozo-harness/agent'
import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import { stopSubagentOf, subagentsOf } from '../src/subagents.ts'

/** A child agent with only the fields the run state reads, and a cancel that says it ran. */
const childAgent = (
  id: string,
  status: AgentStatus,
  startedAt: number,
  seen: Array<string>,
  parent = 's1',
): Agent =>
  ({
    id,
    status,
    parent,
    session: { header: { createdAt: startedAt } },
    cancel: (cause: string) =>
      Effect.sync(() => {
        seen.push(id + ' ' + cause)
      }),
  }) as unknown as Agent

const fakeAgents = (children: ReadonlyArray<Agent>): AgentsShape =>
  ({
    get: (id: string) => children.find((child) => child.id === id),
    list: () => children,
    childrenOf: (id: string) =>
      children.filter((child) => (child as { parent?: string }).parent === id),
  }) as unknown as AgentsShape

describe('the live subagent list', () => {
  test('the children one session started become the run state list, with their state and start', () => {
    const seen: Array<string> = []
    const children = [
      childAgent('child-1', 'running', 1_700_000_000_000, seen),
      childAgent('child-2', 'idle', 1_700_000_010_000, seen),
    ]

    expect(subagentsOf(children)).toEqual([
      { id: 'child-1', status: 'running', startedAt: 1_700_000_000_000 },
      { id: 'child-2', status: 'idle', startedAt: 1_700_000_010_000 },
    ])
    expect(subagentsOf([])).toEqual([])
  })

  test('stopping a child this session started cancels it as the user asked', async () => {
    const seen: Array<string> = []
    const agents = fakeAgents([childAgent('child-1', 'running', 1, seen)])

    await Effect.runPromise(stopSubagentOf(agents, 's1', 'child-1'))

    expect(seen).toEqual(['child-1 user'])
  })

  test('a child another session started, or one nobody started, is refused', async () => {
    const seen: Array<string> = []
    const agents = fakeAgents([childAgent('other-1', 'running', 1, seen, 's2')])

    const other = await Effect.runPromise(stopSubagentOf(agents, 's1', 'other-1').pipe(Effect.flip))
    const missing = await Effect.runPromise(
      stopSubagentOf(agents, 's1', 'nowhere').pipe(Effect.flip),
    )

    expect(other.message).toBe('the subagent is not running')
    expect(missing.message).toBe('the subagent is not running')
    expect(seen).toEqual([])
  })
})
