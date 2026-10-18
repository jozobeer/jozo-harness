import { HooksLive } from '@jozo-harness/kernel'
import {
  Tools,
  toolsLayer,
  type ToolDefinition,
  type ToolError,
  type ToolExecutionResult,
} from '@jozo-harness/tools'
import { Context, Effect, Layer } from 'effect'
import { describe, expect, test } from 'vitest'
import { makeWebSearchTool } from '../src/index.ts'

const call = (
  tool: ToolDefinition<any, any>,
  args: unknown,
): Effect.Effect<ToolExecutionResult | undefined, ToolError, never> =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(Layer.provideMerge(toolsLayer, HooksLive))
      const tools = Context.get(context, Tools)
      yield* tools.register(tool)
      return yield* tools.call({
        callId: 'c1',
        tool: tool.name,
        arguments: JSON.stringify(args),
        context: { sessionId: 's1', cwd: '/tmp', callId: 'c1' },
      })
    }),
  )

const hits = [
  { title: 'jozo-harness', url: 'https://example.com/jozo-harness', snippet: 'a harness' },
  { title: 'effect', url: 'https://example.com/effect', snippet: 'a library' },
]

describe('web_search tool', () => {
  test('returns the hits the provider gave and shows them', async () => {
    const seen: Array<{ query: string; limit: number }> = []
    const result = await Effect.runPromise(
      call(
        makeWebSearchTool({
          search: (query, limit) =>
            Effect.sync(() => {
              seen.push({ query, limit })
              return hits
            }),
        }),
        { query: 'jozo-harness harness', limit: 2 },
      ),
    )

    expect(seen).toEqual([{ query: 'jozo-harness harness', limit: 2 }])
    expect(result?.value).toEqual(hits)
    const text = result?.content[0]
    expect(text?.type === 'text' ? text.text : '').toContain('https://example.com/jozo-harness')
  })

  test('declares a timeout so a provider that never answers cannot hold the call', () => {
    const tool = makeWebSearchTool({ search: () => Effect.never })
    expect(tool.timeoutMs).toBeGreaterThan(0)
    expect(tool.timeoutMs).toBeLessThanOrEqual(60_000)
  })

  test('an empty query is refused before calling the provider', async () => {
    let called = 0
    const result = await Effect.runPromise(
      call(
        makeWebSearchTool({
          search: () =>
            Effect.sync(() => {
              called += 1
              return hits
            }),
        }),
        { query: '   ' },
      ),
    )

    expect(result?.isError).toBe(true)
    expect(called).toBe(0)
  })
})
