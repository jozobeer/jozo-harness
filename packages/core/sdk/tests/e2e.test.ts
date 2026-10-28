import { startStubServer } from '@jozo-harness/test-support-stub'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { HarnessClient, spawnHarness } from '../src/index.ts'

const entry = join(import.meta.dirname, '../../../../apps/cli/src/run.ts')

const sse = (payload: unknown): string => 'data: ' + JSON.stringify(payload) + '\n\n'

const textChunk = (content: string, finish: string | null): unknown => ({
  id: 'chatcmpl-sdk',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'mock',
  choices: [{ index: 0, delta: { content }, finish_reason: finish }],
})

const toolCallChunk: unknown = {
  id: 'chatcmpl-sdk',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'mock',
  choices: [
    {
      index: 0,
      delta: {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'call-sdk-1',
            type: 'function',
            function: { name: 'bash', arguments: '{"command":"printf sdk-tool-ok"}' },
          },
        ],
      },
      finish_reason: null,
    },
  ],
}

const finishChunk = (reason: string): unknown => ({
  id: 'chatcmpl-sdk',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'mock',
  choices: [{ index: 0, delta: {}, finish_reason: reason }],
})

/** True once the process id names nothing, the way a shell checks for an orphan. */
const gone = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}

describe('@jozo-harness/sdk against a real jzh acp process', () => {
  test('runs one turn and returns the final text and the tool result', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jzh-sdk-'))
    const sessionsRoot = join(dir, 'sessions')
    let requests = 0
    const stub = await startStubServer((request) => {
      if (!new URL(request.url).pathname.endsWith('/chat/completions')) {
        return new Response('not found', { status: 404 })
      }
      requests += 1
      if (requests === 1) {
        return new Response(
          sse(toolCallChunk) + sse(finishChunk('tool_calls')) + 'data: [DONE]\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      }
      return new Response(
        sse(textChunk('sdk final', null)) + sse(finishChunk('stop')) + 'data: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const patch = join(dir, 'sdk.yml')
    await writeFile(
      patch,
      [
        'name: sdk-test',
        'plugins:',
        '  - id: llm',
        "    name: '@jozo-harness/llm-openai'",
        '    config:',
        '      baseUrl: ' + stub.origin + '/v1',
        '      localBaseUrl: ""',
        '      apiKeyEnv: SDK_TEST_KEY',
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
    const child = spawnHarness(
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
      { cwd: dir, env: { ...process.env, XDG_CONFIG_HOME: dir, SDK_TEST_KEY: 'test-key' } },
    )
    const client = new HarnessClient({
      spawn: () => child,
      answerPermission: () => ({
        outcome: { outcome: 'selected', optionId: 'allow-once' },
      }),
    })

    try {
      const initialized = await client.initialize()
      expect(initialized).toMatchObject({ protocolVersion: 1 })

      const session = await client.newSession(dir)
      const turn = await client.prompt(session.sessionId, 'run a tool')

      expect(turn.stopReason).toBe('end-turn')
      expect(turn.text).toBe('sdk final')
      expect(turn.toolCalls).toHaveLength(1)
      expect(turn.toolCalls[0]).toMatchObject({
        toolCallId: 'call-sdk-1',
        name: 'bash',
        status: 'completed',
        failed: false,
      })
      expect(turn.toolCalls[0]?.output).toContain('sdk-tool-ok')

      const pid = child.pid
      await client.close()
      expect(pid === undefined ? false : gone(pid)).toBe(true)
    } finally {
      await client.close()
      await stub.stop()
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
