import {
  LlmFailure,
  type LlmAdapter,
  type LlmCapabilities,
  type LlmRequest,
  type StreamChunk,
} from '@jozo-harness/llm'
import { Effect, Stream } from 'effect'
import { describe, expect, test } from 'vitest'
import {
  deriveMessages,
  makeSession,
  reasoningTranslationsOf,
  translateReasoning,
  type SessionEvent,
} from '../src/index.ts'

const capabilities: LlmCapabilities = {
  toolChoice: false,
  reasoningEffort: null,
  images: 'none',
  promptCacheControl: false,
}

const header: SessionEvent = {
  seq: 1,
  time: 0,
  type: 'session/header',
  data: { formatVersion: 1, createdAt: 0, cwd: '/work' },
}

const answer = (seq: number, reasoning = 'I will read the file first.'): SessionEvent => ({
  seq,
  time: seq,
  type: 'assistant/message',
  data: {
    provider: 'stub',
    model: 'stub',
    content: [
      { type: 'reasoning', text: reasoning },
      { type: 'text', text: 'Reading.' },
    ],
    stream: [],
  },
})

const build = (events: ReadonlyArray<SessionEvent> = [header, answer(2)]) =>
  Effect.runPromise(
    makeSession({
      id: 's-1',
      events,
      sink: { append: () => Effect.void, flush: () => Effect.void },
      now: () => 10,
    }),
  )

const adapter = (
  reply: () => Stream.Stream<StreamChunk, LlmFailure>,
  calls: Array<LlmRequest> = [],
): LlmAdapter => ({
  name: 'stub',
  capabilities,
  stream: (request) => {
    calls.push(request)
    return reply()
  },
})

const says = (text: string) =>
  Stream.fromIterable<StreamChunk>([
    { type: 'text-delta', index: 0, text },
    { type: 'finish', kind: 'stop' },
  ])

describe('translating reasoning', () => {
  test('appends the translation beside an original it leaves untouched', async () => {
    const session = await build()
    const before = JSON.stringify(session.events())
    const calls: Array<LlmRequest> = []
    const llm = adapter(() => says('まずファイルを読みます。'), calls)

    const translated = await Effect.runPromise(
      translateReasoning(session, llm, {
        target: 2,
        language: 'ja',
        provider: 'stub',
        model: 'stub',
      }),
    )

    expect(translated).toMatchObject({
      target: 2,
      language: 'ja',
      text: 'まずファイルを読みます。',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.tools).toEqual([])
    expect(JSON.stringify(calls[0]?.messages)).toContain('I will read the file first.')
    // The original event is still the one the log held: the translation is its own line.
    expect(JSON.stringify(session.events().slice(0, 2))).toBe(before)
    const logged = session.events().find((event) => event.type === 'reasoning/translation')
    expect(logged?.data).toMatchObject({
      target: 2,
      language: 'ja',
      text: 'まずファイルを読みます。',
    })
  })

  test('keeps the translation out of the next request the model reads', async () => {
    const session = await build()
    const before = deriveMessages(session.events())

    await Effect.runPromise(
      translateReasoning(
        session,
        adapter(() => says('translated')),
        {
          target: 2,
          language: 'en',
          provider: 'stub',
          model: 'stub',
        },
      ),
    )

    expect(deriveMessages(session.events())).toEqual(before)
  })

  test('reuses a saved translation without asking the model again', async () => {
    const saved: SessionEvent = {
      seq: 3,
      time: 3,
      type: 'reasoning/translation',
      data: { target: 2, language: 'ja', text: '保存済み', provider: 'stub', model: 'stub' },
    }
    const session = await build([header, answer(2), saved])
    const calls: Array<LlmRequest> = []
    const llm = adapter(() => says('another call'), calls)

    const translated = await Effect.runPromise(
      translateReasoning(session, llm, {
        target: 2,
        language: 'ja',
        provider: 'stub',
        model: 'stub',
      }),
    )

    expect(translated.text).toBe('保存済み')
    expect(calls).toHaveLength(0)
    expect(reasoningTranslationsOf(session.events()).size).toBe(1)
  })

  test('reports a provider failure and leaves the original in the log alone', async () => {
    const session = await build()
    const llm = adapter(() => Stream.fail(new LlmFailure({ code: 'TIMEOUT', message: 'slow' })))

    const outcome = await Effect.runPromise(
      translateReasoning(session, llm, {
        target: 2,
        language: 'ja',
        provider: 'stub',
        model: 'stub',
      }).pipe(Effect.flip),
    )

    expect(outcome).toMatchObject({ code: 'provider', message: 'TIMEOUT: slow' })
    expect(session.events().some((event) => event.type === 'reasoning/translation')).toBe(false)
    expect(session.events().find((event) => event.seq === 2)).toEqual(answer(2))
  })

  test('refuses an empty answer from the model without logging a translation', async () => {
    const session = await build()

    const outcome = await Effect.runPromise(
      translateReasoning(
        session,
        adapter(() => says('   ')),
        {
          target: 2,
          language: 'ja',
          provider: 'stub',
          model: 'stub',
        },
      ).pipe(Effect.flip),
    )

    expect(outcome.code).toBe('empty-translation')
    expect(session.events().some((event) => event.type === 'reasoning/translation')).toBe(false)
  })

  test('refuses a target that carries no reasoning', async () => {
    const quiet: SessionEvent = {
      seq: 2,
      time: 2,
      type: 'assistant/message',
      data: {
        provider: 'stub',
        model: 'stub',
        content: [{ type: 'text', text: 'done' }],
        stream: [],
      },
    }
    const session = await build([header, quiet])

    const outcome = await Effect.runPromise(
      translateReasoning(
        session,
        adapter(() => says('x')),
        {
          target: 2,
          language: 'ja',
          provider: 'stub',
          model: 'stub',
        },
      ).pipe(Effect.flip),
    )

    expect(outcome.code).toBe('no-reasoning')
  })

  test('refuses an event that is not a message and a language it does not know', async () => {
    const session = await build()
    const llm = adapter(() => says('x'))

    const badTarget = await Effect.runPromise(
      translateReasoning(session, llm, {
        target: 1,
        language: 'ja',
        provider: 'stub',
        model: 'stub',
      }).pipe(Effect.flip),
    )
    const badLanguage = await Effect.runPromise(
      translateReasoning(session, llm, {
        target: 2,
        language: 'fr',
        provider: 'stub',
        model: 'stub',
      }).pipe(Effect.flip),
    )

    expect(badTarget.code).toBe('bad-target')
    expect(badLanguage.code).toBe('bad-language')
  })
})
