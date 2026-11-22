import { HooksLive } from '@jozo-harness/kernel'
import { Tools, toolsLayer } from '@jozo-harness/tools'
import { Context, Effect, Layer } from 'effect'
import { describe, expect, test } from 'vitest'
import { nodeFileSystem } from '@jozo-harness/filesystem/node'
import { tier0Tools } from '../src/index.ts'

describe('tier0Tools', () => {
  test('adds the worktree tool when the session can move to one', () => {
    const tools = tier0Tools(nodeFileSystem, undefined, undefined, undefined, undefined, {
      rootOf: () => '/work',
      change: () => Effect.void,
    })

    expect(tools.map((tool) => tool.name)).toContain('create_worktree')
  })

  test('lists the six tools', () => {
    const tools = tier0Tools(nodeFileSystem)

    expect(tools.map((tool) => tool.name)).toEqual([
      'read',
      'write',
      'edit',
      'glob',
      'grep',
      'bash',
    ])
  })

  test('the read-only tools may share a step and the writing ones may not', async () => {
    const safety = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(Layer.provideMerge(toolsLayer, HooksLive))
          const tools = Context.get(context, Tools)
          for (const tool of tier0Tools(nodeFileSystem)) yield* tools.register(tool)
          const asks = (name: string, args: string): boolean => tools.isConcurrencySafe(name, args)
          return {
            read: asks('read', '{"path":"a.ts"}'),
            glob: asks('glob', '{"pattern":"**/*.ts"}'),
            grep: asks('grep', '{"pattern":"x"}'),
            write: asks('write', '{"path":"a.ts","content":"x"}'),
            edit: asks('edit', '{"path":"a.ts","oldString":"a","newString":"b"}'),
            bash: asks('bash', '{"command":"true"}'),
          }
        }),
      ),
    )

    // A step of reads is the round trip the loop can save; a write or a command
    // orders itself against everything else and stays in a batch of its own.
    expect(safety).toEqual({
      read: true,
      glob: true,
      grep: true,
      write: false,
      edit: false,
      bash: false,
    })
  })

  test('the sandbox the caller passes is the one bash uses', async () => {
    const tools = tier0Tools(nodeFileSystem, {
      name: 'test',
      confines: true,
      mode: 'workspace-write',
      wrap: (command) =>
        Effect.succeed({
          argv: ['bash', '-lc', 'echo wrapped'],
          cwd: command.cwd,
          mode: command.mode ?? 'workspace-write',
          denialSignatures: [],
        }),
    })
    const bash = tools.find((tool) => tool.name === 'bash')
    const value = await Effect.runPromise(
      bash?.execute({ command: 'echo raw' }, { sessionId: 's1', cwd: '/tmp', callId: 'c1' }) ??
        Effect.succeed({ exitCode: -1, stdout: '', stderr: '' }),
    )

    expect(value.stdout).toBe('wrapped\n')
  })
})
