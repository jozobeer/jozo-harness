import { spawn } from '@jozo-harness/process'
import { startStubServer } from '@jozo-harness/test-support-stub'
import { Effect } from 'effect'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'
import { main } from '../src/bin.ts'

const entry = join(import.meta.dirname, '../src/run.ts')

/** Reads a web byte stream as lines, which is what the protocol writes. */
const makeLineReader = (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const lines: Array<string> = []
  const waiters: Array<() => void> = []
  let buffer = ''
  let ended = false
  const wake = (): void => {
    for (const waiter of waiters.splice(0)) waiter()
  }
  const pump = async (): Promise<void> => {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        ended = true
        wake()
        return
      }
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        lines.push(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
      }
      wake()
    }
  }
  void pump()
  return {
    next: async (): Promise<Record<string, unknown>> => {
      while (lines.length === 0) {
        if (ended) throw new Error('the child closed stdout before answering')
        await new Promise<void>((resolve) => waiters.push(resolve))
      }
      return JSON.parse(lines.shift() ?? '{}') as Record<string, unknown>
    },
  }
}

const send = (child: ReturnType<typeof spawn>, message: unknown): void => {
  child.stdin.write(JSON.stringify(message) + '\n')
}

const sse = (payload: unknown): string => 'data: ' + JSON.stringify(payload) + '\n\n'

const chunk = (content: string, finish: string | null): unknown => ({
  id: 'chatcmpl-acp',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'mock',
  choices: [{ index: 0, delta: { content }, finish_reason: finish }],
})

describe('jzh acp through a real process', () => {
  test('runs one turn over stdio and leaves a session the store lists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jzh-acp-'))
    const sessionsRoot = join(dir, 'sessions')
    const promptText = 'hello from acp'
    const stub = await startStubServer((request) => {
      if (!new URL(request.url).pathname.endsWith('/chat/completions')) {
        return new Response('not found', { status: 404 })
      }
      return new Response(
        sse(chunk(promptText, null)) + sse(chunk('', 'stop')) + 'data: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const patch = join(dir, 'acp.yml')
    await writeFile(
      patch,
      [
        'name: acp-test',
        'plugins:',
        '  - id: llm',
        "    name: '@jozo-harness/llm-openai'",
        '    config:',
        '      baseUrl: ' + stub.origin + '/v1',
        '      localBaseUrl: ""',
        '      apiKeyEnv: ACP_TEST_KEY',
        '  - id: session-jsonl',
        "    name: '@jozo-harness/session-jsonl'",
        '    config:',
        '      root: ' + sessionsRoot,
        '  - id: safety',
        "    name: '@jozo-harness/safety'",
        '    config:',
        '      preset: workspace-write',
        '      sandbox: none',
      ].join('\n'),
    )
    const config = join(dir, 'config.yaml')
    const child = spawn(
      [
        process.execPath,
        entry,
        'acp',
        '--model',
        'mock/model',
        '--patch',
        patch,
        '--config',
        config,
      ],
      {
        cwd: dir,
        env: { ...process.env, XDG_CONFIG_HOME: dir, ACP_TEST_KEY: 'test-key' },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )

    try {
      const lines = makeLineReader(child.stdout)

      send(child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } })
      expect(await lines.next()).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: { protocolVersion: 1, agentName: 'jozo-harness' },
      })

      send(child, { jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: dir } })
      const opened = await lines.next()
      expect(opened).toMatchObject({
        jsonrpc: '2.0',
        id: 2,
        result: { sessionId: expect.any(String) },
      })
      const sessionId = (opened['result'] as { sessionId: string }).sessionId

      send(child, {
        jsonrpc: '2.0',
        id: 3,
        method: 'session/prompt',
        params: { sessionId, prompt: ['say hello'] },
      })
      const updates: Array<Record<string, unknown>> = []
      let answered: Record<string, unknown> = {}
      while (updated(updates, answered) === false) {
        const line = await lines.next()
        if (line['method'] === 'session/update') updates.push(line)
        if (line['id'] === 3) answered = line
      }

      expect(updates).toHaveLength(1)
      expect(updates[0]).toEqual({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: promptText },
          },
        },
      })
      expect(answered).toEqual({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end-turn' } })

      child.stdin.end()
      expect(await child.exited).toBe(0)

      // The turn wrote the JSONL the browser UI reads: the same store answers
      // the list the command prints after the process is gone.
      const out: Array<string> = []
      const code = await Effect.runPromise(
        main(['sessions', '--patch', patch, '--config', config], {
          stdout: (text) => out.push(text),
          stderr: () => undefined,
          cwd: dir,
        }),
      )
      expect(code).toBe(0)
      expect(out.join('')).toContain(sessionId)
    } finally {
      child.kill()
      await stub.stop()
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)
})

/** The loop above stops once the prompt is answered; a notification never is. */
const updated = (
  updates: ReadonlyArray<Record<string, unknown>>,
  answered: Record<string, unknown>,
): boolean => updates.length > 0 && answered['id'] === 3
