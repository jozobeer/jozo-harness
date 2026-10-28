import { describe, expect, test } from 'vitest'
import { Effect } from 'effect'
import {
  GUI_CONTEXT_ORDER,
  SystemPrompt,
  guiContextEntry,
  makeSystemPrompt,
  systemPromptLayerWith,
} from '../src/index.ts'

const snapshotOf = (read: () => string | undefined): Promise<string> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const prompt = makeSystemPrompt()
        yield* prompt.context(guiContextEntry(read))
        return yield* prompt.runtimeContext({ cwd: '/work' })
      }),
    ),
  )

const systemWithGui = (url: string): Promise<string> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const prompt = makeSystemPrompt()
        yield* prompt.context(guiContextEntry(() => url))
        return yield* prompt.render({ variables: {} })
      }),
    ),
  )

describe('the GUI runtime context', () => {
  test('names the page the session answers in', async () => {
    const text = await snapshotOf(() => 'http://127.0.0.1:3080')

    expect(text).toContain('- gui: http://127.0.0.1:3080')
    expect(GUI_CONTEXT_ORDER).toBeLessThan(30)
  })

  test('adds nothing before the server knows the address it bound', async () => {
    expect(await snapshotOf(() => undefined)).toBe('')
    expect(await snapshotOf(() => '')).toBe('')
  })

  test('a different address keeps the system prompt bytes and changes only the snapshot', async () => {
    const first = 'http://127.0.0.1:3080'
    const second = 'https://example.test/jzh'

    const systemFirst = await systemWithGui(first)
    const systemSecond = await systemWithGui(second)
    expect(systemSecond).toBe(systemFirst)
    expect(systemFirst).not.toContain('gui:')
    expect(await snapshotOf(() => first)).not.toBe(await snapshotOf(() => second))
  })

  test('the system-prompt row turns the fact off for every session', async () => {
    const enabled = await Effect.runPromise(
      Effect.gen(function* () {
        const prompt = yield* SystemPrompt
        return prompt.devContext
      }).pipe(Effect.provide(systemPromptLayerWith({}))),
    )
    const disabled = await Effect.runPromise(
      Effect.gen(function* () {
        const prompt = yield* SystemPrompt
        return prompt.devContext
      }).pipe(Effect.provide(systemPromptLayerWith({ devContext: false }))),
    )

    expect(enabled).toBe(true)
    expect(disabled).toBe(false)
  })
})
