import { describe, expect, test } from 'vitest'
import { Effect } from 'effect'
import {
  PROJECTION_CHECKPOINT_VERSION,
  SessionError,
  decodeProjectionCheckpoint,
  deriveMessages,
  deriveMessagesWithSeqs,
  encodeProjectionCheckpoint,
  makeSession,
  registerMessageProjection,
  resumeProjection,
  type DerivedMessage,
  type ProjectionCheckpoint,
  type SessionEvent,
  type SessionSink,
} from '../src/index.ts'
import { event, headerEvent } from './support.ts'

declare module '../src/events.ts' {
  interface SessionEventMap {
    'test/checkpoint-counted': { readonly text: string }
  }
}

let projected = 0
registerMessageProjection({
  type: 'test/checkpoint-counted',
  name: 'test/checkpoint-counted',
  project: (raw, derived: ReadonlyArray<DerivedMessage>) => {
    projected += 1
    return raw.type === 'test/checkpoint-counted'
      ? [
          ...derived,
          {
            seq: raw.seq,
            message: { role: 'user', content: [{ type: 'text', text: raw.data.text }] },
          },
        ]
      : derived
  },
})

const stamp = { mtimeMs: 1_000, size: 4_096 }

const checkpointAt = (
  events: ReadonlyArray<SessionEvent>,
  seq: number,
): ProjectionCheckpoint => ({
  version: PROJECTION_CHECKPOINT_VERSION,
  seq,
  log: stamp,
  derived: deriveMessagesWithSeqs(events.filter((sessionEvent) => sessionEvent.seq <= seq)),
})

const counted = (seq: number, text: string): SessionEvent =>
  event(seq, 'test/checkpoint-counted', { text })

const user = (seq: number, text: string): SessionEvent =>
  event(seq, 'user/message', { text, source: 'user' })

describe('resumeProjection', () => {
  test('resumes from the checkpoint and folds only the events after it', () => {
    const events = [headerEvent(), ...Array.from({ length: 20 }, (_, index) => user(index + 2, `m${index + 2}`))]
    const checkpoint = checkpointAt(events, 15)

    const resumed = resumeProjection(events, checkpoint)

    expect(resumed.resumed).toBe(true)
    expect(resumed.folded).toBe(6)
    expect(resumed.derived).toEqual(deriveMessagesWithSeqs(events))
  })

  test('folds the whole log when the checkpoint points at a seq the log does not hold', () => {
    const events = [headerEvent(), user(2, 'one'), user(3, 'two')]

    const resumed = resumeProjection(events, { ...checkpointAt(events, 2), seq: 999 })

    expect(resumed.resumed).toBe(false)
    expect(resumed.folded).toBe(events.length)
    expect(resumed.derived).toEqual(deriveMessagesWithSeqs(events))
  })

  test('folds the whole log when there is no checkpoint', () => {
    const events = [headerEvent(), user(2, 'one')]

    expect(resumeProjection(events, undefined)).toEqual({
      derived: deriveMessagesWithSeqs(events),
      folded: 2,
      resumed: false,
    })
  })

  test('a broken checkpoint is a miss, never an error', () => {
    expect(decodeProjectionCheckpoint(undefined)).toBeUndefined()
    expect(decodeProjectionCheckpoint({})).toBeUndefined()
    expect(decodeProjectionCheckpoint({ version: 2, seq: 2, log: stamp, derived: [] })).toBeUndefined()
    expect(decodeProjectionCheckpoint({ version: 1, seq: 2, log: stamp, derived: 'no' })).toBeUndefined()
    expect(
      decodeProjectionCheckpoint({
        version: 1,
        seq: 2,
        log: stamp,
        derived: [{ seq: 2, message: { role: 3 } }],
      }),
    ).toBeUndefined()
    expect(
      decodeProjectionCheckpoint({
        version: 1,
        seq: 2,
        log: stamp,
        derived: [{ seq: 5, message: { role: 'user', content: [] } }],
      }),
    ).toBeUndefined()
  })

  test('a checkpoint survives a round trip through the file text', () => {
    const events = [headerEvent(), user(2, 'one'), user(3, 'two')]
    const checkpoint = checkpointAt(events, 2)

    expect(decodeProjectionCheckpoint(JSON.parse(encodeProjectionCheckpoint(checkpoint)))).toEqual(
      checkpoint,
    )
  })
})

describe('session projection checkpoints', () => {
  test('a reopened session folds only the events the checkpoint does not cover', async () => {
    const events = [
      headerEvent(),
      counted(2, 'one'),
      counted(3, 'two'),
      counted(4, 'three'),
      counted(5, 'four'),
    ]
    const checkpoint = checkpointAt(events, 3)
    const expected = deriveMessages(events)
    projected = 0
    const sink: SessionSink = {
      append: () => Effect.void,
      flush: () => Effect.void,
      loadProjection: () => Effect.succeed(checkpoint),
      saveProjection: () => Effect.void,
    }

    const session = await Effect.runPromise(makeSession({ id: 'session', events, sink }))

    // A full fold would project five events; the checkpoint covers the first three.
    expect(projected).toBe(2)
    expect(session.derive()).toEqual(expected)
    expect(projected).toBe(2)
  })

  test('a broken checkpoint falls back to folding the whole log', async () => {
    const events = [headerEvent(), counted(2, 'one'), counted(3, 'two')]
    const expected = deriveMessages(events)
    projected = 0
    const sink: SessionSink = {
      append: () => Effect.void,
      flush: () => Effect.void,
      loadProjection: () => Effect.succeed(undefined),
      saveProjection: () => Effect.void,
    }

    const session = await Effect.runPromise(makeSession({ id: 'session', events, sink }))

    expect(session.derive()).toEqual(expected)
    expect(projected).toBe(2)
  })

  test('writes a checkpoint after two hundred appended events', async () => {
    const saves: Array<{ seq: number; derived: ReadonlyArray<DerivedMessage> }> = []
    const sink: SessionSink = {
      append: () => Effect.void,
      flush: () => Effect.void,
      saveProjection: (seq, derived) =>
        Effect.sync(() => {
          saves.push({ seq, derived })
        }),
    }
    const session = await Effect.runPromise(
      makeSession({ id: 'session', events: [headerEvent()], sink, now: () => 0 }),
    )

    for (let index = 0; index < 199; index += 1) {
      await Effect.runPromise(session.append('user/message', { text: `m${index}`, source: 'user' }))
    }
    expect(saves).toEqual([])

    await Effect.runPromise(session.append('user/message', { text: 'two hundred', source: 'user' }))
    expect(saves.map((save) => save.seq)).toEqual([201])
    expect(saves[0]?.derived).toHaveLength(200)
  })

  test('writes a checkpoint once five seconds pass between appends', async () => {
    let clock = 0
    const saves: Array<number> = []
    const sink: SessionSink = {
      append: () => Effect.void,
      flush: () => Effect.void,
      saveProjection: (seq) =>
        Effect.sync(() => {
          saves.push(seq)
        }),
    }
    const session = await Effect.runPromise(
      makeSession({ id: 'session', events: [headerEvent()], sink, now: () => clock }),
    )

    await Effect.runPromise(session.append('user/message', { text: 'at zero', source: 'user' }))
    clock = 4_999
    await Effect.runPromise(session.append('user/message', { text: 'still soon', source: 'user' }))
    expect(saves).toEqual([])

    clock = 5_001
    await Effect.runPromise(session.append('user/message', { text: 'later', source: 'user' }))
    expect(saves).toEqual([4])
  })

  test('writes a checkpoint when the session is flushed', async () => {
    const saves: Array<number> = []
    const sink: SessionSink = {
      append: () => Effect.void,
      flush: () => Effect.void,
      saveProjection: (seq) =>
        Effect.sync(() => {
          saves.push(seq)
        }),
    }
    const session = await Effect.runPromise(
      makeSession({ id: 'session', events: [headerEvent()], sink, now: () => 0 }),
    )

    await Effect.runPromise(session.append('user/message', { text: 'one', source: 'user' }))
    await Effect.runPromise(session.flush())

    expect(saves).toEqual([2])
  })

  test('a checkpoint write failure does not fail the append or the close', async () => {
    const sink: SessionSink = {
      append: () => Effect.void,
      flush: () => Effect.void,
      saveProjection: () =>
        Effect.fail(new SessionError({ code: 'persistence', message: 'disk full' })),
    }
    const session = await Effect.runPromise(
      makeSession({ id: 'session', events: [headerEvent()], sink, now: () => 0 }),
    )

    await Effect.runPromise(session.append('user/message', { text: 'one', source: 'user' }))
    await expect(Effect.runPromise(session.flush())).resolves.toBeUndefined()
  })
})
