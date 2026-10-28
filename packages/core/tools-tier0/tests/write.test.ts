import { HooksLive } from '@jozo-harness/kernel'
import { noneSandbox, type SandboxShape } from '@jozo-harness/safety'
import {
  Tools,
  toolsLayer,
  type ToolDefinition,
  type ToolError,
  type ToolExecutionResult,
} from '@jozo-harness/tools'
import { Context, Effect, Layer } from 'effect'
import { describe, expect, test } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeEditTool, makeObservedFiles, makeReadTool, makeWriteTool } from '../src/index.ts'
/** Writes a file, making the directories above it, because the file may not be there yet. */
const writeFileDeep = async (path: string, text: string | Uint8Array): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

/** A sandbox that confines writes to the workspace, the way the shipped profile does. */
const confined: SandboxShape = {
  name: 'test-confine',
  confines: true,
  mode: 'workspace-write',
  wrap: (command) =>
    Effect.succeed({ ...command, mode: command.mode ?? 'workspace-write', denialSignatures: [] }),
}

/** One session's tools share what they have observed about the workspace. */
const makeSession = (cwd: string, sandbox: SandboxShape = noneSandbox) => {
  const observed = makeObservedFiles()
  const list: ReadonlyArray<ToolDefinition<any, any>> = [
    makeReadTool(observed),
    makeWriteTool(observed, sandbox),
    makeEditTool(observed, sandbox),
  ]
  return (
    name: string,
    args: unknown,
  ): Effect.Effect<ToolExecutionResult | undefined, ToolError, never> =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(Layer.provideMerge(toolsLayer, HooksLive))
        const tools = Context.get(context, Tools)
        for (const tool of list) yield* tools.register(tool)
        return yield* tools.call({
          callId: 'c1',
          tool: name,
          arguments: JSON.stringify(args),
          context: { sessionId: 's1', cwd, callId: 'c1' },
        })
      }),
    )
}

describe('write tool', () => {
  test('creates parent directories and reports the size', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-write-'))
    const call = makeSession(dir)

    const result = await Effect.runPromise(call('write', { path: 'a/b.txt', content: 'hi\nthere' }))

    expect(result?.isError).toBe(false)
    expect(result?.value).toEqual({ path: join(dir, 'a', 'b.txt'), bytes: 8 })
    expect(await readFile(join(dir, 'a', 'b.txt'), 'utf8')).toBe('hi\nthere')
    await rm(dir, { recursive: true, force: true })
  })

  test('a confined composition refuses a path outside the workspace', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-write-'))
    const call = makeSession(dir, confined)

    const result = await Effect.runPromise(call('write', { path: '../escape.txt', content: 'x' }))

    expect(result?.isError).toBe(true)
    expect(JSON.stringify(result?.content)).toContain('escapes the workspace')
    await rm(dir, { recursive: true, force: true })
  })

  test('a composition that confines nothing writes it: the mode is the boundary', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-write-'))
    const escape = join(dir, '..', 'escape.txt')
    const call = makeSession(dir)

    const result = await Effect.runPromise(call('write', { path: 'escape.txt', content: 'x' }))

    expect(result?.isError).toBe(false)
    await rm(escape, { force: true })
    await rm(dir, { recursive: true, force: true })
  })

  test('refuses to overwrite a file this session never read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-write-'))
    await writeFileDeep(join(dir, 'notes.txt'), 'the original\n')
    const call = makeSession(dir)

    const result = await Effect.runPromise(
      call('write', { path: 'notes.txt', content: 'clobbered\n' }),
    )

    expect(result?.isError).toBe(true)
    expect(JSON.stringify(result?.content)).toContain('read')
    expect(await readFile(join(dir, 'notes.txt'), 'utf8')).toBe('the original\n')
    await rm(dir, { recursive: true, force: true })
  })

  test('overwrites a file that was read and has not changed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-write-'))
    await writeFileDeep(join(dir, 'notes.txt'), 'the original\n')
    const call = makeSession(dir)

    await Effect.runPromise(call('read', { path: 'notes.txt' }))
    const result = await Effect.runPromise(
      call('write', { path: 'notes.txt', content: 'replaced\n' }),
    )

    expect(result?.isError).toBe(false)
    expect(await readFile(join(dir, 'notes.txt'), 'utf8')).toBe('replaced\n')
    await rm(dir, { recursive: true, force: true })
  })

  test('records the old lines an overwrite replaced', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-write-'))
    await writeFileDeep(join(dir, 'notes.txt'), 'one\ntwo\nthree\n')
    const call = makeSession(dir)

    await Effect.runPromise(call('read', { path: 'notes.txt' }))
    const result = await Effect.runPromise(
      call('write', { path: 'notes.txt', content: 'one\nTWO\nthree\n' }),
    )

    expect(result?.diffs).toEqual([
      {
        path: join(dir, 'notes.txt'),
        oldStart: 2,
        newStart: 2,
        removed: ['two'],
        added: ['TWO'],
      },
    ])
    await rm(dir, { recursive: true, force: true })
  })

  test('records a new file as lines added to an empty old side', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-write-'))
    const call = makeSession(dir)

    const result = await Effect.runPromise(
      call('write', { path: 'fresh.txt', content: 'one\ntwo\n' }),
    )

    expect(result?.diffs).toEqual([
      {
        path: join(dir, 'fresh.txt'),
        oldStart: 1,
        newStart: 1,
        removed: [],
        added: ['one', 'two'],
      },
    ])
    await rm(dir, { recursive: true, force: true })
  })

  test('records nothing when an overwrite leaves the file as it was', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-write-'))
    await writeFileDeep(join(dir, 'notes.txt'), 'same\n')
    const call = makeSession(dir)

    await Effect.runPromise(call('read', { path: 'notes.txt' }))
    const result = await Effect.runPromise(call('write', { path: 'notes.txt', content: 'same\n' }))

    expect(result?.isError).toBe(false)
    expect(result?.diffs).toBeUndefined()
    await rm(dir, { recursive: true, force: true })
  })

  test('refuses a file that changed after it was read, and leaves it alone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-write-'))
    await writeFileDeep(join(dir, 'notes.txt'), 'the original\n')
    const call = makeSession(dir)

    await Effect.runPromise(call('read', { path: 'notes.txt' }))
    await writeFileDeep(join(dir, 'notes.txt'), 'someone else wrote this\n')
    const result = await Effect.runPromise(
      call('write', { path: 'notes.txt', content: 'clobbered\n' }),
    )

    expect(result?.isError).toBe(true)
    expect(JSON.stringify(result?.content)).toContain('changed')
    expect(await readFile(join(dir, 'notes.txt'), 'utf8')).toBe('someone else wrote this\n')
    await rm(dir, { recursive: true, force: true })
  })

  test('writes CRLF as LF', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-write-'))
    const call = makeSession(dir)

    await Effect.runPromise(call('write', { path: 'crlf.txt', content: 'one\r\ntwo\r\n' }))

    expect(await readFile(join(dir, 'crlf.txt'), 'utf8')).toBe('one\ntwo\n')
    await rm(dir, { recursive: true, force: true })
  })

  test('replaces the file by renaming a staged one, leaving no temporary file behind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-write-'))
    const path = join(dir, 'notes.txt')
    await writeFileDeep(path, 'the original\n')
    const call = makeSession(dir)
    const before = await stat(path)

    await Effect.runPromise(call('read', { path: 'notes.txt' }))
    const result = await Effect.runPromise(
      call('write', { path: 'notes.txt', content: 'replaced\n' }),
    )

    expect(result?.isError).toBe(false)
    expect(await readFile(path, 'utf8')).toBe('replaced\n')
    expect((await stat(path)).ino).not.toBe(before.ino)
    expect((await readdir(dir)).filter((name) => name.startsWith('.tmp-'))).toEqual([])
    await rm(dir, { recursive: true, force: true })
  })

  test('refuses a file whose mtime alone changed, even when the text is the same', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-write-'))
    const path = join(dir, 'notes.txt')
    await writeFileDeep(path, 'same\n')
    const call = makeSession(dir)

    await Effect.runPromise(call('read', { path: 'notes.txt' }))
    await utimes(path, new Date(), new Date(Date.now() + 5_000))
    const result = await Effect.runPromise(call('write', { path: 'notes.txt', content: 'next\n' }))

    expect(result?.isError).toBe(true)
    expect(JSON.stringify(result?.content)).toContain('changed')
    expect(await readFile(path, 'utf8')).toBe('same\n')
    expect((await readdir(dir)).filter((name) => name.startsWith('.tmp-'))).toEqual([])
    await rm(dir, { recursive: true, force: true })
  })

  test('refuses a same-size rewrite that restored the mtime after the read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-write-'))
    const path = join(dir, 'notes.txt')
    const stamp = new Date(1_700_000_000_000)
    await writeFileDeep(path, 'original\n')
    await utimes(path, stamp, stamp)
    const call = makeSession(dir)

    await Effect.runPromise(call('read', { path: 'notes.txt' }))
    await writeFileDeep(path, 'tampered\n')
    await utimes(path, stamp, stamp)
    const result = await Effect.runPromise(
      call('write', { path: 'notes.txt', content: 'clobber!\n' }),
    )

    expect(result?.isError).toBe(true)
    expect(JSON.stringify(result?.content)).toContain('changed')
    expect(await readFile(path, 'utf8')).toBe('tampered\n')
    expect((await readdir(dir)).filter((name) => name.startsWith('.tmp-'))).toEqual([])
    await rm(dir, { recursive: true, force: true })
  })

  test('leaves the old path and no temporary file when the rename cannot happen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-write-'))
    await mkdir(join(dir, 'blocked'))
    const call = makeSession(dir)

    const result = await Effect.runPromise(call('write', { path: 'blocked', content: 'x' }))

    expect(result?.isError).toBe(true)
    expect((await stat(join(dir, 'blocked'))).isDirectory()).toBe(true)
    expect((await readdir(dir)).filter((name) => name.startsWith('.tmp-'))).toEqual([])
    await rm(dir, { recursive: true, force: true })
  })
})
