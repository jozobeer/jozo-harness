import { HooksLive } from '@jozo-harness/kernel'
import {
  Tools,
  toolsLayer,
  type ToolDefinition,
  type ToolError,
  type ToolExecutionResult,
} from '@jozo-harness/tools'
import { Context, Effect, Layer } from 'effect'
import { describe, expect, test } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeEditTool, makeObservedFiles, makeReadTool } from '../src/index.ts'
/** Writes a file, making the directories above it, because the file may not be there yet. */
const writeFileDeep = async (path: string, text: string | Uint8Array): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

/** One session's tools share what they have observed about the workspace. */
const makeSession = (cwd: string) => {
  const observed = makeObservedFiles()
  const list: ReadonlyArray<ToolDefinition<any, any>> = [
    makeReadTool(observed),
    makeEditTool(observed),
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

/** A workspace with one file, read the way a careful model would read it. */
const withReadFile = async (body: string) => {
  const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-edit-'))
  await writeFileDeep(join(dir, 'a.txt'), body)
  const call = makeSession(dir)
  await Effect.runPromise(call('read', { path: 'a.txt' }))
  return { dir, call }
}

const textOf = (result: ToolExecutionResult | undefined): string =>
  JSON.stringify(result?.content ?? [])

describe('edit tool', () => {
  test('replaces a unique match', async () => {
    const { dir, call } = await withReadFile('one\ntwo\nthree\n')

    const result = await Effect.runPromise(
      call('edit', { path: 'a.txt', oldString: 'two', newString: 'TWO' }),
    )

    expect(result?.isError).toBe(false)
    expect(result?.value).toEqual({ path: join(dir, 'a.txt'), replacements: 1 })
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('one\nTWO\nthree\n')
    await rm(dir, { recursive: true, force: true })
  })

  test('records where each replacement stood, so the log carries the change itself', async () => {
    const { dir, call } = await withReadFile('one\ntwo\nthree\n')

    const result = await Effect.runPromise(
      call('edit', { path: 'a.txt', oldString: 'two', newString: 'TWO' }),
    )

    expect(result?.diffs).toEqual([
      {
        path: join(dir, 'a.txt'),
        oldStart: 2,
        newStart: 2,
        removed: ['two'],
        added: ['TWO'],
      },
    ])
    await rm(dir, { recursive: true, force: true })
  })

  test('records every occurrence of an all replacement as its own change', async () => {
    const { dir, call } = await withReadFile('a\na\n')

    const result = await Effect.runPromise(
      call('edit', { path: 'a.txt', oldString: 'a', newString: 'x\ny', all: true }),
    )

    expect(result?.diffs).toEqual([
      { path: join(dir, 'a.txt'), oldStart: 1, newStart: 1, removed: ['a'], added: ['x', 'y'] },
      { path: join(dir, 'a.txt'), oldStart: 2, newStart: 3, removed: ['a'], added: ['x', 'y'] },
    ])
    await rm(dir, { recursive: true, force: true })
  })

  test('refuses text that is missing or ambiguous, leaving the file alone', async () => {
    const { dir, call } = await withReadFile('a\na\n')

    const missing = await Effect.runPromise(
      call('edit', { path: 'a.txt', oldString: 'zzz', newString: 'x' }),
    )
    const ambiguous = await Effect.runPromise(
      call('edit', { path: 'a.txt', oldString: 'a', newString: 'x' }),
    )

    expect(missing?.isError).toBe(true)
    expect(textOf(missing)).toContain('no match')
    expect(ambiguous?.isError).toBe(true)
    expect(textOf(ambiguous)).toContain('2 matches')
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('a\na\n')
    await rm(dir, { recursive: true, force: true })
  })

  test('replaces every match when asked', async () => {
    const { dir, call } = await withReadFile('a\na\n')

    const result = await Effect.runPromise(
      call('edit', { path: 'a.txt', oldString: 'a', newString: 'x', all: true }),
    )

    expect(result?.value).toEqual({ path: join(dir, 'a.txt'), replacements: 2 })
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('x\nx\n')
    await rm(dir, { recursive: true, force: true })
  })

  test('refuses a file this session never read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-edit-'))
    await writeFileDeep(join(dir, 'a.txt'), 'untouched\n')
    const call = makeSession(dir)

    const result = await Effect.runPromise(
      call('edit', { path: 'a.txt', oldString: 'untouched', newString: 'changed' }),
    )

    expect(result?.isError).toBe(true)
    expect(textOf(result)).toContain('read')
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('untouched\n')
    await rm(dir, { recursive: true, force: true })
  })

  test('refuses a file that changed after it was read, and leaves it alone', async () => {
    const { dir, call } = await withReadFile('the original\n')
    await writeFileDeep(join(dir, 'a.txt'), 'someone else wrote this\n')

    const result = await Effect.runPromise(
      call('edit', { path: 'a.txt', oldString: 'someone', newString: 'nobody' }),
    )

    expect(result?.isError).toBe(true)
    expect(textOf(result)).toContain('changed')
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('someone else wrote this\n')
    await rm(dir, { recursive: true, force: true })
  })

  test('keeps the CRLF line endings of the file it edits', async () => {
    const { dir, call } = await withReadFile('one\r\ntwo\r\nthree\r\n')

    const result = await Effect.runPromise(
      call('edit', { path: 'a.txt', oldString: 'two', newString: 'TWO' }),
    )

    expect(result?.isError).toBe(false)
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('one\r\nTWO\r\nthree\r\n')
    await rm(dir, { recursive: true, force: true })
  })

  test('refuses a binary file before it changes anything', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-edit-'))
    const path = join(dir, 'bin.txt')
    await writeFileDeep(path, new Uint8Array([0x41, 0x00, 0x42]))
    const call = makeSession(dir)
    await Effect.runPromise(call('read', { path: 'bin.txt' }))

    const result = await Effect.runPromise(
      call('edit', { path: 'bin.txt', oldString: 'A', newString: 'Z' }),
    )

    expect(result?.isError).toBe(true)
    expect(textOf(result)).toContain('binary')
    expect((await readFile(path)).byteLength).toBe(3)
    await rm(dir, { recursive: true, force: true })
  })

  test('writes dollar patterns as literal text', async () => {
    const { dir, call } = await withReadFile('start MIDDLE end\n')
    const replacement = "cost $$ and $& and $' tail"

    const result = await Effect.runPromise(
      call('edit', { path: 'a.txt', oldString: 'MIDDLE', newString: replacement }),
    )

    expect(result?.isError).toBe(false)
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('start ' + replacement + ' end\n')
    await rm(dir, { recursive: true, force: true })
  })

  test('refuses an empty old string and leaves the file alone', async () => {
    const { dir, call } = await withReadFile('untouched\n')

    const result = await Effect.runPromise(
      call('edit', { path: 'a.txt', oldString: '', newString: 'inserted' }),
    )

    expect(result?.isError).toBe(true)
    expect(textOf(result)).toContain('empty')
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('untouched\n')
    await rm(dir, { recursive: true, force: true })
  })

  test('a file that is not UTF-8 cannot be read, so it cannot be edited', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-edit-'))
    const path = join(dir, 'a.txt')
    await writeFileDeep(path, new Uint8Array([0xff, 0xfe, 0x00, 0x41]))
    const call = makeSession(dir)

    const read = await Effect.runPromise(call('read', { path: 'a.txt' }))
    const edit = await Effect.runPromise(
      call('edit', { path: 'a.txt', oldString: 'A', newString: 'B' }),
    )

    expect(read?.isError).toBe(true)
    expect(textOf(read)).toContain('UTF-8')
    expect(edit?.isError).toBe(true)
    expect(textOf(edit)).toContain('read')
    expect((await readFile(path)).byteLength).toBe(4)
    await rm(dir, { recursive: true, force: true })
  })
})
