import { agentPlugin } from '@jozo-harness/agent'
import { agentLoopPlugin } from '@jozo-harness/agent-loop'
import { kernelPlugin, type Plugin } from '@jozo-harness/kernel'
import { Llm, type LlmAdapter, type StreamChunk } from '@jozo-harness/llm'
import { safetyPlugin } from '@jozo-harness/safety'
import { sessionPlugin } from '@jozo-harness/session'
import { jsonlSessions, sessionJsonlPlugin } from '@jozo-harness/session-jsonl'
import { systemPromptPlugin } from '@jozo-harness/system-prompt'
import { toolsPlugin } from '@jozo-harness/tools'
import { Effect, Layer, Schema, Stream } from 'effect'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { runCommand } from '../src/index.ts'

const reply: ReadonlyArray<StreamChunk> = [
  { type: 'text-delta', index: 0, text: 'ok' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } },
  { type: 'finish', kind: 'stop' },
]

const stub: Plugin<{}, Llm, never> = {
  name: 'stub-llm',
  config: Schema.Struct({}),
  provides: [Llm],
  requires: [],
  layer: () =>
    Layer.succeed(Llm, {
      name: 'stub',
      capabilities: {
        toolChoice: false,
        reasoningEffort: null,
        images: 'none',
        promptCacheControl: false,
      },
      stream: () => Stream.fromIterable(reply),
    } satisfies LlmAdapter),
}

/** A profile whose configured default is read-only, with no sandbox probe of its own. */
const profile = (root: string): string =>
  [
    'name: test',
    'plugins:',
    '  - id: kernel',
    "    name: '@jozo-harness/kernel'",
    '  - id: sessions',
    "    name: '@jozo-harness/session'",
    '  - id: session-jsonl',
    "    name: '@jozo-harness/session-jsonl'",
    '    config:',
    '      root: ' + root,
    '  - id: tools',
    "    name: '@jozo-harness/tools'",
    '  - id: system-prompt',
    "    name: '@jozo-harness/system-prompt'",
    '  - id: safety',
    "    name: '@jozo-harness/safety'",
    '    config:',
    '      preset: read-only',
    '      sandbox: none',
    '  - id: llm',
    '    name: stub-llm',
    '  - id: agent',
    "    name: '@jozo-harness/agent'",
    '  - id: agent-loop',
    "    name: '@jozo-harness/agent-loop'",
  ].join('\n')

const runLines = async (
  root: string,
  lines: ReadonlyArray<string>,
  resume?: string,
): Promise<{ readonly code: number; readonly printed: string }> => {
  const out: Array<string> = []
  const code = await Effect.runPromise(
    runCommand({
      profiles: [profile(root)],
      plugins: [
        kernelPlugin,
        sessionJsonlPlugin,
        sessionPlugin,
        toolsPlugin,
        systemPromptPlugin,
        safetyPlugin,
        stub,
        agentPlugin,
        agentLoopPlugin,
      ] as ReadonlyArray<Plugin<any, any, any>>,
      cwd: '/work',
      route: 'stub/model',
      lines: Stream.fromIterable(lines),
      stdout: (text) => {
        out.push(text)
      },
      stderr: () => undefined,
      ...(resume === undefined ? {} : { resume }),
    }),
  )
  return { code, printed: out.join('') }
}

describe('permission preset across runs', () => {
  test('a switch is logged, a resumed session keeps it, and a new one starts from the profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-permission-'))
    const switched = await runLines(root, ['/permission danger-full-access'])

    const sessions = await Effect.runPromise(jsonlSessions({ root }).list())
    const id = sessions[0]?.id ?? ''
    const opened = await Effect.runPromise(jsonlSessions({ root }).open(id))
    const switches = opened.events.flatMap((event) =>
      event.type === 'permission/preset' ? [event.data] : [],
    )

    expect(switched.code).toBe(0)
    expect(switches).toHaveLength(1)
    expect(switches[0]?.preset).toBe('full')
    expect(switches[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(opened.events.some((event) => event.type === 'turn/start')).toBe(false)

    // The resumed process reads the log before any tool call, so /status reports
    // the boundary the human chose rather than the profile's read-only default.
    const resumed = await runLines(root, ['/status'], id)
    expect(resumed.printed).toContain('permission: danger-full-access')

    // A new session has no such event: the configured default still decides its start.
    const fresh = await runLines(root, ['/status'])
    expect(fresh.printed).toContain('permission: read-only')

    // The switch stayed in the session that made it; the new log has no event to inherit.
    const after = await Effect.runPromise(jsonlSessions({ root }).list())
    const newest = after.find((session) => session.id !== id)
    expect(newest).toBeDefined()
    const freshLog = await Effect.runPromise(jsonlSessions({ root }).open(newest?.id ?? ''))
    expect(freshLog.events.some((event) => event.type === 'permission/preset')).toBe(false)

    await rm(root, { recursive: true, force: true })
  })
})
