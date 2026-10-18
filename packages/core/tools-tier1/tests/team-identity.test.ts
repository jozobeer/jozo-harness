import type { Agent, AgentsShape } from '@jozo-harness/agent'
import type { SessionEvent } from '@jozo-harness/session'
import { describe, expect, test } from 'vitest'
import { teamIdentityLine, teamIdentityOf } from '../src/index.ts'

const event = (seq: number, type: string, data: unknown): SessionEvent =>
  ({ seq, time: seq, type, data }) as unknown as SessionEvent

const agentWith = (id: string, events: ReadonlyArray<SessionEvent>): Agent =>
  ({ id, status: 'idle', session: { events: () => events } }) as unknown as Agent

const agentsOf = (...list: ReadonlyArray<Agent>): AgentsShape =>
  ({ list: () => list }) as unknown as AgentsShape

const rosterOf = (lead: string, name: string, role: string, child: string): AgentsShape =>
  agentsOf(
    agentWith(lead, [event(1, 'team/spawned', { name, role, sessionId: child })]),
    agentWith(child, []),
  )

describe('teamIdentityOf', () => {
  test('finds the name, role, and lead that spawned this session', () => {
    const agents = rosterOf('lead-1', 'builder', 'writes the code', 'child-1')

    expect(teamIdentityOf(agents, 'child-1')).toEqual({
      name: 'builder',
      role: 'writes the code',
      lead: 'lead-1',
    })
  })

  test('a lead and an agent outside any roster have no identity', () => {
    const agents = rosterOf('lead-1', 'builder', 'writes the code', 'child-1')

    expect(teamIdentityOf(agents, 'lead-1')).toBeUndefined()
    expect(teamIdentityOf(agents, 'nobody')).toBeUndefined()
  })

  test("a session named by another session's roster is not this one's teammate", () => {
    const agents = agentsOf(
      agentWith('lead-1', [
        event(1, 'team/spawned', { name: 'builder', role: '', sessionId: 'child-1' }),
      ]),
      agentWith('lead-2', [
        event(2, 'team/spawned', { name: 'writer', role: '', sessionId: 'child-2' }),
      ]),
    )

    expect(teamIdentityOf(agents, 'child-2')).toEqual({ name: 'writer', role: '', lead: 'lead-2' })
  })
})

describe('teamIdentityLine', () => {
  test('names the teammate, its role, and the lead session', () => {
    expect(teamIdentityLine({ name: 'builder', role: 'writes the code', lead: 'lead-1' })).toBe(
      'team: you are teammate "builder" (writes the code); your Team Lead is session lead-1. ' +
        'Act as that teammate, not as the lead.',
    )
  })

  test('an empty role leaves no empty parentheses', () => {
    expect(teamIdentityLine({ name: 'builder', role: '', lead: 'lead-1' })).toBe(
      'team: you are teammate "builder"; your Team Lead is session lead-1. ' +
        'Act as that teammate, not as the lead.',
    )
  })
})
