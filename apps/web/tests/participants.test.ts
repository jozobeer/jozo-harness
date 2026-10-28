import { describe, expect, test } from 'vitest'
import { makeParticipantRegistry } from '../src/server/participants.ts'

describe('the invitations one run hands out', () => {
  test('issues a token nobody can guess and keeps the label the owner typed', () => {
    const registry = makeParticipantRegistry(() => 1_000)
    const participant = registry.issue('  Alice  ')
    expect(participant.label).toBe('Alice')
    expect(participant.id).toMatch(/^[0-9a-f]{16}$/)
    expect(participant.token).toMatch(/^[0-9a-f]{64}$/)
    expect(participant.joinedAt).toBe(1_000)
  })

  test('finds the invitation a token names, and names none for a stranger', () => {
    const registry = makeParticipantRegistry(() => 0)
    const alice = registry.issue('Alice')
    expect(registry.find(alice.token)?.id).toBe(alice.id)
    expect(registry.find(undefined)).toBeUndefined()
    expect(registry.find('')).toBeUndefined()
    expect(registry.find('f'.repeat(64))).toBeUndefined()
  })

  test('lists every live invitation oldest first', () => {
    let clock = 0
    const registry = makeParticipantRegistry(() => clock++)
    const alice = registry.issue('Alice')
    const bob = registry.issue('Bob')
    expect(registry.list()).toEqual([alice, bob])
  })

  test('cuts one invitation and leaves the others live', () => {
    const registry = makeParticipantRegistry(() => 0)
    const alice = registry.issue('Alice')
    const bob = registry.issue('Bob')
    expect(registry.revoke(alice.id)).toBe(true)
    expect(registry.find(alice.token)).toBeUndefined()
    expect(registry.find(bob.token)?.id).toBe(bob.id)
    expect(registry.list().map((one) => one.id)).toEqual([bob.id])
    expect(registry.revoke(alice.id)).toBe(false)
  })

  test('names a blank invitation guest so its row is still one row', () => {
    const registry = makeParticipantRegistry(() => 0)
    expect(registry.issue('   ').label).toBe('guest')
  })
})
