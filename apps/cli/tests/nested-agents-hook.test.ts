import { makeHooks } from '@jozo-harness/kernel'
import type { Agent } from '@jozo-harness/agent'
import type { ToolExecution, ToolExecutionResult } from '@jozo-harness/tools'
import { Effect } from 'effect'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'
import { installNestedAgentsMd } from '../src/index.ts'

const NESTED_MARKER = 'NESTED-AGENTS-HOOK-MARKER-7301'

const result: ToolExecutionResult = {
  isError: false,
  content: [{ type: 'text', text: 'ok' }],
}

describe('the nested AGENTS.md listener', () => {
  test('a listener registered after it still runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-nested-hook-'))
    try {
      await mkdir(join(root, 'nested'), { recursive: true })
      await writeFile(join(root, 'nested', 'AGENTS.md'), NESTED_MARKER + '\n')
      await writeFile(join(root, 'nested', 'file.txt'), 'body\n')

      const injected: Array<string> = []
      const downstream: Array<string> = []
      const agent = {
        id: 's1',
        session: {
          events: () => [],
          header: { formatVersion: 1, createdAt: 0, cwd: root },
        },
        inject: (message: { readonly text: string }) =>
          Effect.sync(() => {
            injected.push(message.text)
          }),
      } as unknown as Agent
      const exec = {
        callId: 'c1',
        tool: 'read',
        arguments: JSON.stringify({ path: join(root, 'nested', 'file.txt') }),
        args: { path: join(root, 'nested', 'file.txt') },
        context: { sessionId: 's1', cwd: root, callId: 'c1' },
      } as unknown as ToolExecution

      const hooks = makeHooks()
      const posted = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* installNestedAgentsMd({ hooks, agent, root, loaded: new Map() })
            // Downstream listeners must run even though the installer is before them.
            yield* hooks.on('tools/post-execute', (_exec, previous, next) =>
              Effect.gen(function* () {
                downstream.push('ran')
                yield* next()
                return {
                  ...previous,
                  content: [{ type: 'text' as const, text: 'downstream' }],
                }
              }),
            )
            return yield* hooks.waterfall('tools/post-execute', exec, result)
          }),
        ),
      )

      expect(injected.some((text) => text.includes(NESTED_MARKER))).toBe(true)
      expect(downstream).toEqual(['ran'])
      expect(posted?.content).toEqual([{ type: 'text', text: 'downstream' }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
