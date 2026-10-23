import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'
import { kernelPlugin, loadProfile } from '@jozo-harness/kernel'
import { BlockAssembler, Llm } from '@jozo-harness/llm'
import { Context, Effect, Layer, Stream } from 'effect'
import { replayAdapter, replayPlugin } from '../src/index.ts'
import { normalizeLog } from '../src/scenario.ts'

const recording = async (): Promise<string> =>
  readFile(
    new URL('../../../llm/llm-openai/fixtures/ollama-cloud-tool-call.sse', import.meta.url),
    'utf8',
  )

describe('normalizeLog', () => {
  test('zeroes the moments that move and keeps a schema field named time', () => {
    const line = normalizeLog(
      [
        {
          seq: 1,
          time: 1728912345678,
          type: 'request/header',
          data: {
            createdAt: 1728912345678,
            params: { weekly: { time: { type: 'string', description: "like '08:30'" } } },
          },
        },
      ],
      [],
    )
    const parsed = JSON.parse(line)

    expect(parsed.time).toBe(0)
    expect(parsed.data.createdAt).toBe(0)
    expect(parsed.data.params.weekly.time).toEqual({
      type: 'string',
      description: "like '08:30'",
    })
  })

  test('zeroes the per-chunk delays of a stream record', () => {
    const line = normalizeLog(
      [
        {
          seq: 1,
          time: 1728912345678,
          type: 'assistant/message',
          data: {
            stream: [
              { type: 'text-chunks', time0: 12, index: 1, dt: [0, 1, 2], texts: ['a', 'b'] },
            ],
          },
        },
      ],
      [],
    )
    const parsed = JSON.parse(line) as {
      readonly data: {
        readonly stream: ReadonlyArray<{ dt: ReadonlyArray<number>; time0: number }>
      }
    }

    // A delay that moves by a millisecond must not decide whether a replay matches.
    expect(parsed.data.stream[0]?.dt).toEqual([0, 0, 0])
    expect(parsed.data.stream[0]?.time0).toBe(0)
  })

  test('writes the sandbox backend as a token so a recording replays on any platform', () => {
    const lines = ['seatbelt', 'bwrap'].map((backend) =>
      normalizeLog(
        [
          {
            seq: 1,
            time: 0,
            type: 'user/message',
            data: {
              text: '- sandbox: workspace-write (backend: ' + backend + '; enforcement: full;',
            },
          },
        ],
        [],
      ),
    )

    expect(lines[0]).toContain('backend: <native>;')
    expect(lines[1]).toBe(lines[0])
  })

  test('drops the seatbelt refusal so a recording replays inside and outside a sandbox', () => {
    const line = (suffix: string): string =>
      normalizeLog(
        [
          {
            seq: 1,
            time: 0,
            type: 'user/message',
            data: { text: '- sandbox: workspace-write' + suffix },
          },
        ],
        [],
      )
    const refused = '; the seatbelt cannot be applied here, so commands are refused'

    expect(line(refused)).toBe(line(''))
  })
})

describe('replayAdapter', () => {
  test('replays the recorded stream as assistant content', async () => {
    const adapter = replayAdapter(await recording())
    const assembler = new BlockAssembler()
    const chunks = await Effect.runPromise(
      Stream.runCollect(
        adapter.stream({
          provider: 'ollama-cloud',
          model: 'deepseek-v4.1-flash',
          messages: [],
          tools: undefined,
          params: {},
        }),
      ),
    )

    for (const chunk of chunks) assembler.push(chunk)
    const assembled = assembler.snapshot()
    const calls = assembled.content.flatMap((block) =>
      block.type === 'tool-call' ? [block.name] : [],
    )

    expect(assembled.content.some((block) => block.type === 'reasoning')).toBe(true)
    expect(calls).toEqual(['echo', 'count'])
    expect(assembled.finish).toBe('tool-calls')
  })

  test('serves Llm through the loader', async () => {
    const sse = await recording()
    const adapter = await Effect.runPromise(
      Effect.gen(function* () {
        const layer = yield* loadProfile({
          plugins: [kernelPlugin, replayPlugin(sse)],
          layers: [
            [
              { id: 'kernel', name: '@jozo-harness/kernel', config: {} },
              { id: 'llm', name: 'replay-llm', config: {} },
            ],
          ],
        })
        const context = yield* Layer.build(layer)
        return Context.get(context, Llm)
      }).pipe(Effect.scoped),
    )

    expect(adapter.name).toBe('replay')
  })
})
