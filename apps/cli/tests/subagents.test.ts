import type { Agent, AgentStatus, AgentsShape } from '@jozo-harness/agent'
import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import { messageSubagentOf, stopSubagentOf, subagentsOf } from '../src/subagents.ts'

/** A child agent with only the fields the run state reads; every way in records that it ran. */
const childAgent = (
  id: string,
  status: AgentStatus,
  started_at: number,
  seen: Array<string>,
  parent = 's1',
  preset?: string,
  endedAt?: number,
): Agent =>
  ({
    id,
    status,
    parent,
    options: preset === undefined ? {} : { preset },
    session: {
      header: { createdAt: started_at },
      events: () => (endedAt === undefined ? [] : [{ seq: 1, time: endedAt, type: 'turn/end' }]),
    },
    cancel: (cause: string) =>
      Effect.sync(() => {
        seen.push(id + ' ' + cause)
      }),
    followup: (message: { text: string }) =>
      Effect.sync(() => {
        seen.push(id + ' followup ' + message.text)
      }),
    steer: (message: { text: string }) =>
      Effect.sync(() => {
        seen.push(id + ' steer ' + message.text)
      }),
  }) as unknown as Agent

const fakeAgents = (
  children: ReadonlyArray<Agent>,
  /** How far below the root each child sits; one level unless a test says otherwise. */
  depthOf: (id: string) => number = () => 1,
): AgentsShape =>
  ({
    get: (id: string) => children.find((child) => child.id === id),
    list: () => children,
    childrenOf: (id: string) =>
      children.filter((child) => (child as { parent?: string }).parent === id),
    depthOf,
  }) as unknown as AgentsShape

describe('the live subagent list', () => {
  test('the children one session started become the run state list, with their state and start', () => {
    const seen: Array<string> = []
    const children = [
      childAgent('child-1', 'running', 1_700_000_000_000, seen),
      childAgent('child-2', 'idle', 1_700_000_010_000, seen),
    ]

    expect(subagentsOf(fakeAgents(children), children, 2)).toEqual([
      {
        id: 'child-1',
        status: 'running',
        startedAt: 1_700_000_000_000,
        depth: 1,
        maxDepth: 2,
      },
      {
        id: 'child-2',
        status: 'idle',
        startedAt: 1_700_000_010_000,
        depth: 1,
        maxDepth: 2,
      },
    ])
    expect(subagentsOf(fakeAgents([]), [], 2)).toEqual([])
  })

  test('each row says how deep the child sits and how deep this run allows children to go', () => {
    const seen: Array<string> = []
    const children = [
      childAgent('child-1', 'idle', 10, seen),
      childAgent('grand-1', 'running', 20, seen, 'child-1'),
    ]
    const agents = fakeAgents(children, (id) => (id === 'grand-1' ? 2 : 1))

    expect(subagentsOf(agents, children, 1).map((child) => [child.depth, child.maxDepth])).toEqual([
      [1, 1],
      [2, 1],
    ])
  })

  test('a settled child says which preset it ran under and when it stopped', () => {
    const seen: Array<string> = []
    const children = [
      childAgent('child-1', 'idle', 10, seen, 's1', 'reviewer', 20),
      childAgent('child-2', 'disposed', 30, seen),
    ]

    expect(subagentsOf(fakeAgents(children), children, 1)).toEqual([
      {
        id: 'child-1',
        status: 'idle',
        startedAt: 10,
        depth: 1,
        maxDepth: 1,
        preset: 'reviewer',
        endedAt: 20,
      },
      { id: 'child-2', status: 'disposed', startedAt: 30, depth: 1, maxDepth: 1 },
    ])
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

describe('a follow-up sent from the run pane', () => {
  test('an idle child starts a new turn with the message, as send_message does', async () => {
    const seen: Array<string> = []
    const agents = fakeAgents([childAgent('child-1', 'idle', 1, seen)])

    const result = await Effect.runPromise(messageSubagentOf(agents, 's1', 'child-1', 'try again'))

    expect(result).toEqual({ id: 'child-1', queued: false })
    expect(seen).toEqual(['child-1 followup try again'])
  })

  test('a child that is working reads the message at its next step, and the page says it queued', async () => {
    const seen: Array<string> = []
    const agents = fakeAgents([childAgent('child-1', 'running', 1, seen)])

    const result = await Effect.runPromise(
      messageSubagentOf(agents, 's1', 'child-1', 'stop at two'),
    )

    expect(result).toEqual({ id: 'child-1', queued: true })
    expect(seen).toEqual(['child-1 steer stop at two'])
  })

  test('a child another session started, or one nobody started, is refused and hears nothing', async () => {
    const seen: Array<string> = []
    const agents = fakeAgents([childAgent('other-1', 'idle', 1, seen, 's2')])

    const other = await Effect.runPromise(
      messageSubagentOf(agents, 's1', 'other-1', 'hello').pipe(Effect.flip),
    )
    const missing = await Effect.runPromise(
      messageSubagentOf(agents, 's1', 'nowhere', 'hello').pipe(Effect.flip),
    )

    expect(other.message).toBe('the subagent is not running')
    expect(missing.message).toBe('the subagent is not running')
    expect(seen).toEqual([])
  })
})
