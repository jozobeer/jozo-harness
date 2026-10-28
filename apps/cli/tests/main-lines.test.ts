import { describe, expect, test } from 'vitest'
import { Effect, Stream } from 'effect'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { main } from '../src/bin.ts'
/** Writes a file, making the directories above it, because the file may not be there yet. */
const writeFileDeep = async (path: string, text: string | Uint8Array): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

const patchWithRoot = async (dir: string): Promise<string> => {
  const path = join(dir, 'sessions.yml')
  await writeFileDeep(
    path,
    [
      'name: sessions',
      'plugins:',
      '  - id: session-jsonl',
      "    name: '@jozo-harness/session-jsonl'",
      '    config:',
      '      root: ' + join(dir, 'sessions'),
      // The run under test is about input and error handling; a naming call would be a
      // provider request nobody stubbed.
      '  - id: agent-loop',
      "    name: '@jozo-harness/agent-loop'",
      '    config:',
      '      title:',
      '        enabled: false',
      // The test process may itself be sandboxed; commands are not what this run tests.
      '  - id: safety',
      "    name: '@jozo-harness/safety'",
      '    config:',
      '      sandbox: none',
    ].join('\n'),
  )
  return path
}

describe('main with a line stream', () => {
  test('an empty line stream ends the repl with 0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-main-'))
    const err: Array<string> = []
    const code = await Effect.runPromise(
      main(['--model', 'test/model', '--patch', await patchWithRoot(dir)], {
        stdout: () => undefined,
        stderr: (text) => err.push(text),
        cwd: '/work',
        lines: Stream.make(),
      }),
    )

    expect(code).toBe(0)
    expect(err).toEqual([])
    await rm(dir, { recursive: true, force: true })
  })

  test('without a task and without input there is nothing to do', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-main-'))
    const err: Array<string> = []
    const code = await Effect.runPromise(
      main(['--patch', await patchWithRoot(dir)], {
        stdout: () => undefined,
        stderr: (text) => err.push(text),
        cwd: '/work',
      }),
    )

    expect(code).toBe(2)
    expect(err.join('')).toContain('nothing to do')
    await rm(dir, { recursive: true, force: true })
  })
})
