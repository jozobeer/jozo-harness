import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'
import { BlockAssembler } from '@jozo-harness/llm'
import { decodeOpenAiStream } from '../src/index.ts'

const fixture = async (): Promise<ReadonlyArray<string>> =>
  (
    await readFile(new URL('../fixtures/ollama-cloud-tool-call.sse', import.meta.url), 'utf8')
  ).split('\n')

describe('OpenAiStreamDecoder', () => {
  test('decodes the recorded tool-call stream into reasoning, text, and parallel tool calls', async () => {
    const chunks = decodeOpenAiStream(await fixture())
    const assembler = new BlockAssembler()
    for (const chunk of chunks) assembler.push(chunk)
    const assembled = assembler.snapshot()

    expect(assembled.content.map((block) => block.type)).toEqual([
      'reasoning',
      'text',
      'tool-call',
      'tool-call',
    ])
    const calls = assembled.content.flatMap((block) => (block.type === 'tool-call' ? [block] : []))
    expect(calls.map((call) => call.name)).toEqual(['echo', 'count'])
    expect(calls.map((call) => call.arguments)).toEqual(['{"text":"a"}', '{"value":2}'])
    expect(assembled.finish).toBe('tool-calls')
    expect(assembled.usage?.inputTokens).toBeGreaterThan(0)
    // The recording reports a zero cache hit: that is data, not a missing bucket.
    expect(assembled.usage?.cacheReadTokens).toBe(0)
  })

  test('reads DeepSeek-style reasoning_content as the reasoning block, once per delta', () => {
    const chunks = decodeOpenAiStream([
      'data: {"choices":[{"delta":{"reasoning_content":"think"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"reasoning":"ing","reasoning_content":"ing","content":"hi"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    ])
    const reasoning = chunks.flatMap((chunk) =>
      chunk.type === 'reasoning-delta' ? [chunk.text] : [],
    )
    const text = chunks.flatMap((chunk) => (chunk.type === 'text-delta' ? [chunk.text] : []))

    // Console's chat-completions family (DeepSeek, GLM, Kimi) uses this spelling.
    expect(reasoning).toEqual(['think', 'ing'])
    expect(text).toEqual(['hi'])
    expect(
      chunks.flatMap((chunk) => (chunk.type === 'block-start' ? [chunk.blockType] : [])),
    ).toEqual(['reasoning', 'text'])
  })

  test('keeps cached prompt tokens out of the non-cache input', () => {
    const chunks = decodeOpenAiStream([
      'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":7}}}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    ])
    const usage = chunks.flatMap((chunk) => (chunk.type === 'usage' ? [chunk.usage] : []))

    expect(usage).toEqual([{ inputTokens: 3, outputTokens: 5, cacheReadTokens: 7 }])
  })

  test('a provider that reports no cache details leaves the bucket unknown', () => {
    const chunks = decodeOpenAiStream([
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    ])
    const usage = chunks.flatMap((chunk) => (chunk.type === 'usage' ? [chunk.usage] : []))

    expect(usage).toEqual([{ inputTokens: 10, outputTokens: 5 }])
    expect(usage[0]).not.toHaveProperty('cacheReadTokens')
  })

  test('emits usage before finish even though the provider sends it after', async () => {
    const chunks = decodeOpenAiStream(await fixture())
    const usage = chunks.findIndex((chunk) => chunk.type === 'usage')
    const finish = chunks.findIndex((chunk) => chunk.type === 'finish')

    expect(usage).toBeGreaterThanOrEqual(0)
    expect(finish).toBeGreaterThan(usage)
  })

  test('flushes a held finish when the stream ends without usage', () => {
    const chunks = decodeOpenAiStream([
      'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    ])

    expect(chunks.at(-1)).toEqual({ type: 'finish', kind: 'stop' })
  })

  test('ignores malformed and non-data lines', () => {
    const chunks = decodeOpenAiStream([': keep-alive', 'data: not json', 'data: [DONE]'])
    expect(chunks).toEqual([])
  })

  test('keeps each tool call id when later argument fragments omit it', () => {
    const line = (delta: unknown, finish: string | null = null): string =>
      'data: ' + JSON.stringify({ choices: [{ delta, finish_reason: finish }] })
    const chunks = decodeOpenAiStream([
      line({
        tool_calls: [
          {
            index: 0,
            id: 'call_a',
            type: 'function',
            function: { name: 'echo', arguments: '' },
          },
          {
            index: 1,
            id: 'call_b',
            type: 'function',
            function: { name: 'count', arguments: '' },
          },
        ],
      }),
      line({ tool_calls: [{ index: 0, function: { arguments: '{"text":"a"}' } }] }),
      line({ tool_calls: [{ index: 1, function: { arguments: '{"value":2}' } }] }),
      line({}, 'tool_calls'),
    ])
    const assembler = new BlockAssembler()
    for (const chunk of chunks) assembler.push(chunk)
    const calls = assembler
      .snapshot()
      .content.flatMap((block) => (block.type === 'tool-call' ? [block] : []))

    // OpenAI sends the id once. A later fragment that only extends arguments
    // must not replace that id, or the follow-up request cannot pair the result.
    expect(calls).toEqual([
      { type: 'tool-call', id: 'call_a', name: 'echo', arguments: '{"text":"a"}' },
      { type: 'tool-call', id: 'call_b', name: 'count', arguments: '{"value":2}' },
    ])
  })
})
