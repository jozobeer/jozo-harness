import { describe, expect, test } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from '../src/index.ts'

const collected = async (stream: ReadableStream<Uint8Array>): Promise<string> =>
  await new Response(stream).text()

/** Waits for a child to create a marker file, or reports that it never did. */
const waitForFile = async (path: string, timeoutMs = 5_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return existsSync(path)
}

describe('spawn', () => {
  test('runs a command, reads its output, and reports the exit code', async () => {
    const child = spawn(['bash', '-lc', 'echo hi; echo err >&2'])
    expect(await collected(child.stdout)).toBe('hi\n')
    expect(await collected(child.stderr)).toBe('err\n')
    expect(await child.exited).toBe(0)
  })

  test('reports a non-zero exit code', async () => {
    const child = spawn(['bash', '-lc', 'exit 3'])
    expect(await child.exited).toBe(3)
  })

  test('runs in the directory it was given', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jozo-harness-process-'))
    try {
      const child = spawn(['bash', '-lc', 'pwd'], { cwd: directory })
      // The shell reports the path it resolved, and a temp directory on macOS
      // reaches the child through /private.
      expect((await collected(child.stdout)).trim()).toBe(await realpath(directory))
      expect(await child.exited).toBe(0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('writes to a piped stdin and closes it', async () => {
    const child = spawn(['bash', '-lc', 'cat'], { stdin: 'pipe' })
    child.stdin.write('one\ntwo\n')
    child.stdin.end()
    expect(await collected(child.stdout)).toBe('one\ntwo\n')
    expect(await child.exited).toBe(0)
  })

  test('a given environment replaces the inherited one', async () => {
    const child = spawn(['bash', '-lc', 'printf %s "$PROBE"'], {
      env: { PROBE: 'set' },
    })
    expect(await collected(child.stdout)).toBe('set')
  })

  test('kill ends the process and the exit is reported', async () => {
    const child = spawn(['bash', '-lc', 'sleep 30'])
    child.kill()
    expect(await child.exited).not.toBe(0)
  })

  test('kill ends the descendants the command started', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jozo-harness-process-'))
    const ready = join(directory, 'grandchild-ready')
    const stopped = join(directory, 'grandchild-stopped')
    try {
      const grandchild = `bash -c 'trap "touch ${stopped}" TERM; touch ${ready}; sleep 30'`
      const child = spawn(['bash', '-lc', `${grandchild} & wait`])
      // The marker proves the descendant installed its signal handler before the kill.
      expect(await waitForFile(ready)).toBe(true)
      child.kill()
      expect(await child.exited).not.toBe(0)
      expect(await waitForFile(stopped)).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 15_000)
})
