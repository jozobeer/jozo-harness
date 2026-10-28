import { describe, expect, test } from 'vitest'
import { Effect } from 'effect'
import {
  SystemPrompt,
  makeSystemPrompt,
  readTmuxLocation,
  systemPromptLayerWith,
  tmuxContextEntry,
  type TmuxProbe,
} from '../src/index.ts'

const TMUX_ENV = { TMUX: '/tmp/tmux-501/default,1,0', TMUX_PANE: '%1' }

const probe = (
  run: () => string | undefined,
  env: Readonly<Record<string, string | undefined>> = TMUX_ENV,
  calls: Array<ReadonlyArray<string>> = [],
): TmuxProbe => ({
  env,
  run: (args) => {
    calls.push(args)
    return run()
  },
})

const render = (options: Parameters<typeof systemPromptLayerWith>[0]): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt
      return yield* prompt.runtimeContext({ cwd: '/work' })
    }).pipe(Effect.provide(systemPromptLayerWith(options))),
  )

const snapshot = (reader: TmuxProbe): Promise<string> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const prompt = makeSystemPrompt()
        yield* prompt.context(tmuxContextEntry(reader))
        return yield* prompt.runtimeContext({ cwd: '/work' })
      }),
    ),
  )

describe('tmux runtime context', () => {
  test('names the window and pane when the setting is on and the process is in tmux', async () => {
    const text = await render({ tmuxContext: true, tmux: probe(() => 'main:2.1\n') })

    expect(text).toContain('- tmux: session main, window 2, pane 1')
  })

  test('reads the location of the pane that owns this process', async () => {
    const calls: Array<ReadonlyArray<string>> = []
    await render({ tmuxContext: true, tmux: probe(() => 'main:2.1\n', TMUX_ENV, calls) })

    expect(calls).toEqual([['display-message', '-p', '-t', '%1', '#S:#I.#P']])
  })

  test('adds no line outside tmux even when the setting is on', async () => {
    const calls: Array<ReadonlyArray<string>> = []
    const text = await render({ tmuxContext: true, tmux: probe(() => 'main:2.1\n', {}, calls) })

    expect(text).not.toContain('tmux:')
    expect(calls).toEqual([])
  })

  test('adds no line in tmux when the setting is off', async () => {
    const calls: Array<ReadonlyArray<string>> = []
    const text = await render({ tmux: probe(() => 'main:2.1\n', TMUX_ENV, calls) })

    expect(text).not.toContain('tmux:')
    expect(calls).toEqual([])
  })

  test('a missing or unreadable answer adds no line', async () => {
    expect(await render({ tmuxContext: true, tmux: probe(() => undefined) })).not.toContain('tmux:')
    expect(await render({ tmuxContext: true, tmux: probe(() => 'not a location') })).not.toContain(
      'tmux:',
    )
  })

  test('the same place renders the same snapshot and a moved pane renders a new one', async () => {
    let output = 'main:2.1'
    const first = await snapshot({ env: TMUX_ENV, run: () => output })
    const second = await snapshot({ env: TMUX_ENV, run: () => output })

    output = 'main:2.2'
    const moved = await snapshot({ env: TMUX_ENV, run: () => output })

    expect(second).toBe(first)
    expect(moved).not.toBe(first)
    expect(moved).toContain('pane 2')
  })

  test('TMUX and TMUX_PANE must both be present', () => {
    expect(readTmuxLocation({ env: { TMUX: 'set' }, run: () => 'main:1.1' })).toBeUndefined()
    expect(readTmuxLocation({ env: { TMUX_PANE: '%1' }, run: () => 'main:1.1' })).toBeUndefined()
    expect(
      readTmuxLocation({
        env: { TMUX: '', TMUX_PANE: '%1' },
        run: () => 'main:1.1',
      }),
    ).toBeUndefined()
  })
})
