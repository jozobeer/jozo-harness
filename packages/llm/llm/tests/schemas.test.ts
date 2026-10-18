import { describe, expect, test } from 'vitest'
import { Effect, Exit, Schema } from 'effect'
import {
  AssistantStreamRecordSchema,
  ContentBlockSchema,
  LlmFailure,
  LlmFailureSchema,
  LlmUsageSchema,
  StreamChunkSchema,
  encodeLlmFailure,
  type AssistantStreamRecord,
  type ContentBlock,
  type StreamChunk,
} from '../src/index.ts'

const run = <A, E>(effect: Effect.Effect<A, E, unknown>): Promise<A> =>
  Effect.runPromise(effect as Effect.Effect<A, E, never>)

const decode = <A>(schema: Schema.Schema<A>, value: unknown): Promise<A> =>
  run(Schema.decodeUnknownEffect(schema)(value))

const decodeExit = <A>(schema: Schema.Schema<A>, value: unknown): Promise<Exit.Exit<A, unknown>> =>
  run(Effect.exit(Schema.decodeUnknownEffect(schema)(value)))

const throughJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

describe('schema round trips', () => {
  test('content blocks', async () => {
    const blocks: ReadonlyArray<ContentBlock> = [
      { type: 'text', text: crypto.randomUUID() },
      { type: 'reasoning', text: 'think' },
      {
        type: 'tool-call',
        id: crypto.randomUUID(),
        name: 'read',
        arguments: JSON.stringify({ path: 'a' }),
      },
    ]

    const encoded = await run(Schema.encodeEffect(Schema.Array(ContentBlockSchema))(blocks))

    expect(await decode(Schema.Array(ContentBlockSchema), throughJson(encoded))).toEqual(blocks)
  })

  test('stream chunks, including a generated sequence', async () => {
    const chunks = randomChunks(7)

    const encoded = await run(Schema.encodeEffect(Schema.Array(StreamChunkSchema))(chunks))

    expect(await decode(Schema.Array(StreamChunkSchema), throughJson(encoded))).toEqual(chunks)
  })

  test('compact stream records', async () => {
    const records: ReadonlyArray<AssistantStreamRecord> = [
      { type: 'chunk', time: 5, chunk: { type: 'finish', kind: 'stop' } },
      { type: 'text-chunks', time0: 1, index: 0, dt: [2, 3], texts: ['a', 'b', 'c'] },
      {
        type: 'tool-call-chunks',
        time0: 4,
        index: 1,
        dt: [1],
        id: 'call-1',
        name: 'read',
        args: ['{', '}'],
      },
    ]

    const encoded = await run(
      Schema.encodeEffect(Schema.Array(AssistantStreamRecordSchema))(records),
    )

    expect(await decode(Schema.Array(AssistantStreamRecordSchema), throughJson(encoded))).toEqual(
      records,
    )
  })

  test('usage keeps the cache buckets the provider reported', async () => {
    const usage = {
      inputTokens: 3,
      outputTokens: 5,
      reasoningTokens: 2,
      cacheReadTokens: 7,
      cacheWriteTokens: 1,
    }

    const encoded = await run(Schema.encodeEffect(LlmUsageSchema)(usage))

    expect(await decode(LlmUsageSchema, throughJson(encoded))).toEqual(usage)
  })

  test('a failure is stored in its data shape', async () => {
    const data = encodeLlmFailure(new LlmFailure({ code: 'TIMEOUT', message: 'no response' }))

    expect(data).toEqual({ _tag: 'LlmFailure', code: 'TIMEOUT', message: 'no response' })
    expect(await decode(LlmFailureSchema, throughJson(data))).toEqual(data)
  })
})

describe('schema rejection', () => {
  test('rejects a chunk with a missing field', async () => {
    const exit = await decodeExit(StreamChunkSchema, { type: 'text-delta', index: 0 })
    expect(Exit.isFailure(exit)).toBe(true)
  })

  test('rejects an unknown failure code', async () => {
    const exit = await decodeExit(LlmFailureSchema, {
      _tag: 'LlmFailure',
      code: 'NOPE',
      message: 'x',
    })
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

/** Deterministic chunk generator; values come from the runtime, not the source. */
function randomChunks(seed: number): ReadonlyArray<StreamChunk> {
  let state = seed
  const next = (): number => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state
  }
  const word = (): string => next().toString(36).slice(0, 5)
  const chunks: Array<StreamChunk> = []
  const callId = crypto.randomUUID()
  for (let index = 0; index < 24; index += 1) {
    switch (next() % 7) {
      case 0:
        chunks.push({ type: 'block-start', index: 0, blockType: 'text' })
        break
      case 1:
        chunks.push({ type: 'text-delta', index: 0, text: word() })
        break
      case 2:
        chunks.push({ type: 'reasoning-delta', index: 1, text: word() })
        break
      case 3:
        chunks.push({ type: 'tool-call-delta', index: 2, id: callId, argumentsDelta: word() })
        break
      case 4:
        chunks.push({
          type: 'tool-call-delta',
          index: 2,
          id: callId,
          name: 'read',
          argumentsDelta: word(),
        })
        break
      case 5:
        chunks.push({
          type: 'usage',
          usage: { inputTokens: next() % 100, outputTokens: next() % 100 },
        })
        break
      default:
        chunks.push({ type: 'finish', kind: 'stop' })
        break
    }
  }
  return chunks
}
