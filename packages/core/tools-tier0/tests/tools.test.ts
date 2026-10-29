import { Effect } from 'effect'
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
