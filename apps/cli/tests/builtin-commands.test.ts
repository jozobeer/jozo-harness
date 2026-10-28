import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import {
  makeCommands,
  makeSession,
  type CompactionCheckpoint,
  type Session,
} from '@jozo-harness/session'
import { installBuiltinCommands, type BuiltinCommandOptions } from '../src/commands.ts'

const header = () =>
  ({
    seq: 1,
    time: 0,
    type: 'session/header',
    data: { formatVersion: 1, createdAt: 0, cwd: '/work' },
  }) as const

const build = (options: BuiltinCommandOptions = {}) =>
  Effect.gen(function* () {
    const session = yield* makeSession({
      id: 's-1',
      events: [header()],
      sink: { append: () => Effect.void, flush: () => Effect.void },
      now: () => 1,
    })
    const commands = makeCommands()
    yield* installBuiltinCommands(commands, options)
    return { session, commands }
  })

const seed = (session: Session) =>
  Effect.gen(function* () {
    yield* session.append('user/message', { text: 'x'.repeat(40_000), source: 'user' })
    yield* session.append('assistant/message', {
      provider: 'stub',
      model: 'model',
      content: [{ type: 'text', text: 'the newest word' }],
      stream: [],
    })
  })

const checkpoint: CompactionCheckpoint = {
  shadowedSeqs: [2],
  shadowedRange: { start: 2, end: 2 },
  summary: 'the earlier span, condensed',
  provider: 'stub',
  model: 'model',
}

const compacted = (session: Session) =>
  session.events().filter((event) => event.type === 'compaction/checkpoint')

const switches = () => {
  const models: Array<string> = []
  const efforts: Array<string> = []
  const control = {
    route: () => models.at(-1) ?? 'stub/model',
    effort: () => efforts.at(-1) ?? '',
    setModel: (model: string) => Effect.sync(() => void models.push(model)),
    setEffort: (effort: string) => Effect.sync(() => void efforts.push(effort)),
  }
  return { models, efforts, control }
}

describe('the built-in commands a session can switch with', () => {
  test('/model switches the route, and alone says what it is', async () => {
    const { commands, session } = await Effect.runPromise(build())
    const { models, control } = switches()

    const switched = await Effect.runPromise(commands.run('/model stub/other', session, control))
    expect(switched).toEqual({ ok: true, text: 'model: stub/other' })
    expect(models).toEqual(['stub/other'])

    expect(await Effect.runPromise(commands.run('/model', session, control))).toEqual({
      ok: true,
      text: 'model: stub/other',
    })
    expect(await Effect.runPromise(commands.run('/model', session))).toMatchObject({ ok: false })
  })

  test('/effort switches the effort and default gives it back to the provider', async () => {
    const { commands, session } = await Effect.runPromise(build())
    const { efforts, control } = switches()

    expect(await Effect.runPromise(commands.run('/effort high', session, control))).toEqual({
      ok: true,
      text: 'effort: high',
    })
    expect(efforts).toEqual(['high'])
    await Effect.runPromise(commands.run('/effort default', session, control))
    expect(efforts).toEqual(['high', ''])
    expect(await Effect.runPromise(commands.run('/effort', session, control))).toEqual({
      ok: true,
      text: 'effort: default',
    })
  })

  test('/compact prunes the oversized history now and says what it freed', async () => {
    const { commands, session } = await Effect.runPromise(build())
    await Effect.runPromise(seed(session))

    const outcome = await Effect.runPromise(commands.run('/compact', session))

    expect(outcome?.ok).toBe(true)
    expect(outcome?.text).toContain('compacted')
    const pruned = session.events().filter((event) => event.type === 'compaction/prune')
    expect(pruned).toHaveLength(1)

    // A second run has nothing left to fold.
    expect(await Effect.runPromise(commands.run('/compact', session))).toEqual({
      ok: true,
      text: 'nothing to compact',
    })
  })

  test('/feedback rates an answer without starting a turn, and the log keeps it', async () => {
    const { commands, session } = await Effect.runPromise(build())
    await Effect.runPromise(seed(session))
    const answer = session.events().findLast((event) => event.type === 'assistant/message')
    const mark = session.events().length

    const outcome = await Effect.runPromise(
      commands.run('/feedback like #' + String(answer?.seq) + ' clear and short', session),
    )

    expect(outcome).toEqual({
      ok: true,
      text: 'rated #' + String(answer?.seq) + ' like: clear and short',
    })
    expect(
      session
        .events()
        .slice(mark)
        .map((event) => event.type),
    ).toEqual(['command/run', 'feedback/rated', 'command/done'])
    expect(session.events().some((event) => event.type === 'turn/start')).toBe(false)
    expect(
      session
        .events()
        .slice(mark)
        .some((event) => event.type === 'user/message'),
    ).toBe(false)
  })

  test('/feedback rejects a line without a verdict, and the answer still reaches the log', async () => {
    const { commands, session } = await Effect.runPromise(build())
    await Effect.runPromise(seed(session))
    const mark = session.events().length

    const outcome = await Effect.runPromise(commands.run('/feedback just words', session))

    expect(outcome?.ok).toBe(false)
    expect(outcome?.text).toContain('usage: /feedback')
    expect(
      session
        .events()
        .slice(mark)
        .map((event) => event.type),
    ).toEqual(['command/run', 'command/done'])
  })

  test('/compact records the checkpoint the summary call earned', async () => {
    let calls = 0
    const compactNow = () => {
      calls += 1
      return Effect.succeed<CompactionCheckpoint | undefined>(checkpoint)
    }
    const { commands, session } = await Effect.runPromise(build({ compactNow }))
    await Effect.runPromise(seed(session))

    await Effect.runPromise(commands.run('/compact', session))

    expect(calls).toBe(1)
    const recorded = compacted(session)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.type === 'compaction/checkpoint' ? recorded[0].data : undefined).toEqual(
      checkpoint,
    )
    // The prune still lands before the checkpoint it bounds.
    const types = session.events().map((event) => event.type)
    expect(types.indexOf('compaction/prune')).toBeLessThan(types.indexOf('compaction/checkpoint'))
  })

  test('/compact leaves the log without a checkpoint when the summary call has no word', async () => {
    const { commands, session } = await Effect.runPromise(
      build({ compactNow: () => Effect.succeed(undefined) }),
    )
    await Effect.runPromise(seed(session))

    await Effect.runPromise(commands.run('/compact', session))

    expect(session.events().filter((event) => event.type === 'compaction/prune')).toHaveLength(1)
    expect(compacted(session)).toHaveLength(0)
  })

  test('/compact keeps the prune when the summary call dies before it answers', async () => {
    const { commands, session } = await Effect.runPromise(
      build({ compactNow: () => Effect.die(new Error('the summarizer is gone')) }),
    )
    await Effect.runPromise(seed(session))

    // The fold cannot be completed, so the human is told; the prune it already wrote
    // stays in the log and no checkpoint claims a summary that was never given.
    const outcome = await Effect.runPromise(commands.run('/compact', session))

    expect(outcome).toEqual({ ok: false, text: 'the summarizer is gone' })
    expect(session.events().filter((event) => event.type === 'compaction/prune')).toHaveLength(1)
    expect(compacted(session)).toHaveLength(0)
  })

  test('/compact refuses while a turn holds the agent, and folds nothing', async () => {
    const { commands, session } = await Effect.runPromise(build({ isBusy: () => true }))
    await Effect.runPromise(seed(session))

    const outcome = await Effect.runPromise(commands.run('/compact', session))

    expect(outcome).toEqual({ ok: false, text: 'a turn is running; /compact after it' })
    expect(session.events().filter((event) => event.type === 'compaction/prune')).toHaveLength(0)
  })

  test('/compact prunes alone when no summary call was handed in', async () => {
    const { commands, session } = await Effect.runPromise(build())
    await Effect.runPromise(seed(session))

    await Effect.runPromise(commands.run('/compact', session))

    expect(session.events().filter((event) => event.type === 'compaction/prune')).toHaveLength(1)
    expect(compacted(session)).toHaveLength(0)
  })
})
