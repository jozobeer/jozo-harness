import { describe, expect, test } from 'vitest'
import { decodeSessionEvent } from '@jozo-harness/session'
import { Effect } from 'effect'
import { approvalEventSchemas } from '../src/index.ts'

describe('approval events', () => {
  test('registers the approval and review events in the catalog', () => {
    expect([...approvalEventSchemas.keys()]).toEqual([
      'safety/approval/requested',
      'safety/approval/answered',
      'safety/auto/reviewed',
    ])
  })

  test('a review decodes from the log', async () => {
    const event = await Effect.runPromise(
      decodeSessionEvent({
        seq: 4,
        time: 1,
        type: 'safety/auto/reviewed',
        data: {
          sessionId: 's1',
          callId: 'c1',
          tool: 'bash',
          decision: 'denied',
          reason: 'it removes the worktree',
        },
      }),
    )

    expect(event?.type).toBe('safety/auto/reviewed')
    expect(event?.type === 'safety/auto/reviewed' ? event.data.decision : '').toBe('denied')
  })

  test('a request decodes from the log', async () => {
    const event = await Effect.runPromise(
      decodeSessionEvent({
        seq: 2,
        time: 1,
        type: 'safety/approval/requested',
        data: { callId: 'c1', tool: 'bash', reason: 'preset read-only does not allow: exec' },
      }),
    )

    expect(event?.type).toBe('safety/approval/requested')
    expect(event?.type === 'safety/approval/requested' ? event.data.tool : '').toBe('bash')
  })

  test('a malformed request is rejected', async () => {
    const result = await Effect.runPromise(
      Effect.match(
        decodeSessionEvent({
          seq: 3,
          time: 1,
          type: 'safety/approval/answered',
          data: { callId: 'c1' },
        }),
        { onFailure: () => 'rejected', onSuccess: () => 'accepted' },
      ),
    )

    expect(result).toBe('rejected')
  })
})
