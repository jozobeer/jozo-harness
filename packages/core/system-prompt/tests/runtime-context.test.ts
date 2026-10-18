import { describe, expect, test } from 'vitest'
import { Effect } from 'effect'
import {
  RUNTIME_CONTEXT_HEADER,
  RUNTIME_CONTEXT_SUPERSEDES,
  SystemPrompt,
  makeSystemPrompt,
  systemPromptLayer,
  timeLine,
  type RuntimeContextEntry,
} from '../src/index.ts'

const render = (entries: ReadonlyArray<RuntimeContextEntry>): Promise<string> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const prompt = makeSystemPrompt()
        for (const entry of entries) yield* prompt.context(entry)
        return yield* prompt.runtimeContext({ cwd: '/work' })
      }),
    ),
  )

describe('runtimeContext', () => {
  test('renders the facts in order and skips the empty ones', async () => {
    const text = await render([
      { name: 'b', order: 2, text: () => Effect.succeed('b: 2') },
      { name: 'a', order: 1, text: () => Effect.succeed('a: 1') },
      { name: 'gone', order: 3, text: () => Effect.succeed(undefined) },
      { name: 'blank', order: 4, text: () => Effect.succeed('') },
    ])

    expect(text).toBe(
      RUNTIME_CONTEXT_HEADER + '\n' + RUNTIME_CONTEXT_SUPERSEDES + '\n- a: 1\n- b: 2',
    )
  })

  test('the snapshot says it supersedes the earlier ones', async () => {
    const text = await render([{ name: 'a', order: 1, text: () => Effect.succeed('a: 1') }])

    expect(text).toBe(RUNTIME_CONTEXT_HEADER + '\n' + RUNTIME_CONTEXT_SUPERSEDES + '\n- a: 1')
  })

  test('a fact reads the subject of the assembly', async () => {
    const text = await render([
      { name: 'cwd', order: 1, text: (subject) => Effect.succeed('cwd: ' + subject.cwd) },
    ])

    expect(text).toContain('- cwd: /work')
  })

  test('no fact with a value means no snapshot text', async () => {
    expect(await render([])).toBe('')
  })

  test('a duplicate name fails with duplicate-context', async () => {
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const prompt = makeSystemPrompt()
          yield* prompt.context({ name: 'cwd', order: 1, text: () => Effect.succeed('one') })
          return yield* Effect.flip(
            prompt.context({ name: 'cwd', order: 2, text: () => Effect.succeed('two') }),
          )
        }),
      ),
    )

    expect(error.code).toBe('duplicate-context')
  })

  test('a fact disappears when its scope closes', async () => {
    const prompt = makeSystemPrompt()
    await Effect.runPromise(
      Effect.scoped(
        prompt.context({ name: 'cwd', order: 1, text: () => Effect.succeed('cwd: /work') }),
      ),
    )

    expect(await Effect.runPromise(prompt.runtimeContext({ cwd: '/work' }))).toBe('')
    expect(prompt.contexts()).toEqual([])
  })
})

describe('built-in runtime facts', () => {
  test('the layer names the workspace and the sampled time', async () => {
    const text = await Effect.runPromise(
      Effect.gen(function* () {
        const prompt = yield* SystemPrompt
        return yield* prompt.runtimeContext({ cwd: '/work' })
      }).pipe(Effect.provide(systemPromptLayer)),
    )

    expect(
      text.startsWith(
        RUNTIME_CONTEXT_HEADER + '\n' + RUNTIME_CONTEXT_SUPERSEDES + '\n- cwd: /work\n- time: ',
      ),
    ).toBe(true)
    expect(text).toMatch(/- time: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z/)
  })

  test('the clock moves in ten minute buckets', () => {
    const start = Date.UTC(2026, 9, 14, 12, 0, 0)

    expect(timeLine(start)).toBe(timeLine(start + 60_000))
    expect(timeLine(start + 600_000)).not.toBe(timeLine(start))
  })
})
