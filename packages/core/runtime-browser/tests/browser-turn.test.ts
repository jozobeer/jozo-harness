import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { Effect } from 'effect'
import type { LlmTransport } from '@jozo-harness/llm'
import { makeMemoryFileSystem } from '@jozo-harness/filesystem/memory'
import { makeSystemPrompt } from '@jozo-harness/system-prompt'
import { memoryPersistence } from '@jozo-harness/session'
import { browserRuntime, runBrowserTurn } from '../src/index.ts'

const sse = (events: ReadonlyArray<readonly [string, unknown]>): string =>
  events.map(([name, body]) => `event: ${name}\ndata: ${JSON.stringify(body)}\n\n`).join('')

const response = (events: ReadonlyArray<readonly [string, unknown]>): Response =>
  new Response(sse(events), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })

const toolCallTurn = (name: string, argumentsJson: string) =>
  response([
    ['message_start', { type: 'message_start', message: { usage: { input_tokens: 10 } } }],
    [
      'content_block_start',
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'call-1', name },
      },
    ],
    [
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: argumentsJson },
      },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
    ],
    ['message_stop', { type: 'message_stop' }],
  ])

const textTurn = (text: string) =>
  response([
    ['message_start', { type: 'message_start', message: { usage: { input_tokens: 10 } } }],
    [
      'content_block_start',
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    ],
    [
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
    ],
    ['message_stop', { type: 'message_stop' }],
  ])

/** A transport that answers in the order a test wrote the turns and keeps what it was sent. */
const stubTransport = (turns: ReadonlyArray<Response>) => {
  const sent: Array<{ readonly url: string; readonly body: Record<string, unknown> }> = []
  const transport: LlmTransport = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const raw = init?.body
    const body = typeof raw === 'string' ? raw : '{}'
    sent.push({ url, body: JSON.parse(body) as Record<string, unknown> })
    const next = turns[sent.length - 1]
    if (next === undefined)
      throw new Error('the turn asked for more model calls than the stub wrote')
    return next
  }
  return { transport, sent }
}

const optionsOf = (
  cwd: string,
  transport: LlmTransport,
  fileSystem = makeMemoryFileSystem({ [`${cwd}/note.txt`]: 'hello from the memory workspace\n' }),
) => ({
  cwd,
  route: 'stub/model',
  baseUrl: 'https://model.test/anthropic',
  apiKey: () => 'test-key',
  transport,
  fileSystem,
  now: () => 1_000,
})

describe('browser runtime', () => {
  test('runs one turn through a stub transport over a memory workspace without touching the disk', async () => {
    const cwd = join(tmpdir(), `jzh-browser-turn-${crypto.randomUUID()}`)
    const { transport, sent } = stubTransport([
      toolCallTurn('read', JSON.stringify({ path: 'note.txt' })),
      textTurn('I read the note.'),
    ])
    const fileSystem = makeMemoryFileSystem({
      [`${cwd}/note.txt`]: 'hello from the memory workspace\n',
    })

    const result = await Effect.runPromise(
      runBrowserTurn(optionsOf(cwd, transport, fileSystem), 'read the note'),
    )

    // The model was reached only through the injected transport, twice: the tool
    // call and the answer that follows its result.
    expect(sent).toHaveLength(2)
    expect(sent.every((entry) => entry.url === 'https://model.test/anthropic/v1/messages')).toBe(
      true,
    )
    expect(sent[0]?.body['model']).toBe('model')

    // The turn carried a tool call and its result, in that order.
    const types = result.events.map((event) => event.type)
    const call = result.events.find((event) => event.type === 'tool/call')
    const toolResult = result.events.find((event) => event.type === 'tool/result')
    expect(call).toMatchObject({ data: { name: 'read', arguments: '{"path":"note.txt"}' } })
    expect(types.indexOf('tool/call')).toBeLessThan(types.indexOf('tool/result'))
    expect(
      toolResult?.type === 'tool/result'
        ? toolResult.data.content.flatMap((block) => (block.type === 'text' ? [block.text] : []))
        : [],
    ).toEqual([expect.stringContaining('hello from the memory workspace')])

    // The workspace was the memory store and the host path never appeared.
    expect(existsSync(cwd)).toBe(false)
    const bytes = await Effect.runPromise(fileSystem.readBytes(`${cwd}/note.txt`))
    expect(new TextDecoder().decode(bytes)).toBe('hello from the memory workspace\n')

    // The same log is readable from the store the next open would use.
    const reopened = await Effect.runPromise(result.persistence.open(result.sessionId))
    expect(reopened.events).toEqual(result.events)
    const summaries = await Effect.runPromise(result.persistence.list())
    expect(summaries.map((summary) => summary.id)).toEqual([result.sessionId])
  })

  test('offers only the tools a page can honour, and no shell or process', async () => {
    const { transport } = stubTransport([textTurn('done')])
    const result = await Effect.runPromise(
      runBrowserTurn(
        {
          ...optionsOf('/workspace', transport),
          fileSystem: makeMemoryFileSystem({ '/workspace/note.txt': 'hi\n' }),
        },
        'say done',
      ),
    )

    expect(result.tools).toEqual(['read', 'write', 'edit', 'glob', 'grep'])
    expect(result.tools).not.toContain('bash')
    expect(result.tools).not.toContain('run_code')
  })

  test('builds one runtime from an injected workspace, log, and prompt', async () => {
    const prompt = makeSystemPrompt()
    const persistence = memoryPersistence({ id: () => 'session-1' })
    const fileSystem = makeMemoryFileSystem({ '/work/a.txt': 'a\n' })
    const { transport } = stubTransport([textTurn('fine')])

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* browserRuntime({
            cwd: '/work',
            route: 'stub/model',
            baseUrl: 'https://model.test/anthropic',
            apiKey: () => undefined,
            transport,
            fileSystem,
            persistence,
            systemPrompt: prompt,
          })
          expect(runtime.session.id).toBe('session-1')
          expect(runtime.persistence).toBe(persistence)
          expect(runtime.fileSystem).toBe(fileSystem)
          yield* runtime.run('hello')
        }),
      ),
    )
  })
})
