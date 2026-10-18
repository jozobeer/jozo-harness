import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import { makeCommands, makeSession } from '@jozo-harness/session'
import { installBuiltinCommands } from '../src/commands.ts'

const header = () =>
  ({
    seq: 1,
    time: 0,
    type: 'session/header',
    data: { formatVersion: 1, createdAt: 0, cwd: '/work' },
  }) as const

const build = () =>
  Effect.gen(function* () {
    const session = yield* makeSession({
      id: 's-1',
      events: [header()],
      sink: { append: () => Effect.void, flush: () => Effect.void },
      now: () => 1,
    })
    const commands = makeCommands()
    yield* installBuiltinCommands(commands)
    return { session, commands }
  })

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
    await Effect.runPromise(
      session.append('user/message', { text: 'x'.repeat(40_000), source: 'user' }),
    )
    await Effect.runPromise(
      session.append('assistant/message', {
        provider: 'stub',
        model: 'model',
        content: [{ type: 'text', text: 'the newest word' }],
        stream: [],
      }),
    )

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
})
