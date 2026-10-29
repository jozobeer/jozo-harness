import { HooksLive } from '@jozo-harness/kernel'
import { Tools, toolsLayer, type ToolError, type ToolExecutionResult } from '@jozo-harness/tools'
import { Context, Effect, Layer } from 'effect'
import { describe, expect, test } from 'vitest'
import { nodeFileSystem } from '@jozo-harness/filesystem/node'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  READ_MAX_BYTES,
  READ_MAX_LINE_CHARS,
  makeObservedFiles,
  makeReadTool,
} from '../src/index.ts'
/** Writes a file, making the directories above it, because the file may not be there yet. */
const writeFileDeep = async (path: string, text: string | Uint8Array): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

const call = (
  args: unknown,
  cwd: string,
): Effect.Effect<ToolExecutionResult | undefined, ToolError, never> =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(Layer.provideMerge(toolsLayer, HooksLive))
      const tools = Context.get(context, Tools)
      yield* tools.register(makeReadTool(nodeFileSystem, makeObservedFiles()))
      return yield* tools.call({
        callId: 'c1',
        tool: 'read',
        arguments: JSON.stringify(args),
        context: { sessionId: 's1', cwd, callId: 'c1' },
      })
    }),
  )

const textOf = (result: ToolExecutionResult | undefined): string =>
  (result?.content ?? []).flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')

describe('read tool', () => {
  test('returns numbered lines and says where the file ends', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-read-'))
    await writeFileDeep(join(dir, 'a.txt'), 'alpha\nbeta\ngamma\n')

    const result = await Effect.runPromise(call({ path: 'a.txt' }, dir))

    expect(result?.isError).toBe(false)
    expect(textOf(result)).toBe('1\talpha\n2\tbeta\n3\tgamma\n\n(End of file - total 3 lines)')
    expect(result?.value).toMatchObject({ totalLines: 3, from: 1, to: 3, truncated: false })
    await rm(dir, { recursive: true, force: true })
  })

  test('a window that stops short tells the model how to continue', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-read-'))
    await writeFileDeep(join(dir, 'b.txt'), 'one\ntwo\nthree\nfour\n')

    const result = await Effect.runPromise(call({ path: 'b.txt', offset: 2, limit: 2 }, dir))

    expect(textOf(result)).toBe(
      '2\ttwo\n3\tthree\n\n(Showing lines 2-3 of 4. Continue with offset=4.)',
    )
    expect(result?.value).toMatchObject({ totalLines: 4, from: 2, to: 3, truncated: true })
    await rm(dir, { recursive: true, force: true })
  })

  test('a line over the cap is cut and named', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-read-'))
    const long = 'x'.repeat(READ_MAX_LINE_CHARS + 100)
    await writeFileDeep(join(dir, 'long.txt'), long + '\nshort\n')

    const result = await Effect.runPromise(call({ path: 'long.txt' }, dir))

    const text = textOf(result)
    expect(text).toContain('... (line truncated to ' + READ_MAX_LINE_CHARS + ' chars)')
    expect(text).toContain('1\t' + 'x'.repeat(READ_MAX_LINE_CHARS) + '... (line truncated')
    expect(result?.value).toMatchObject({ shortened: 1, totalLines: 2, truncated: false })
    await rm(dir, { recursive: true, force: true })
  })

  test('an offset past the end is an error that names the size', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-read-'))
    await writeFileDeep(join(dir, 'c.txt'), 'a\nb\n')

    const result = await Effect.runPromise(call({ path: 'c.txt', offset: 5 }, dir))

    expect(result?.isError).toBe(true)
    expect(JSON.stringify(result?.content)).toContain('offset 5')
    expect(JSON.stringify(result?.content)).toContain('2 lines')
    await rm(dir, { recursive: true, force: true })
  })

  test('an empty file reads as empty rather than as an error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-read-'))
    await writeFileDeep(join(dir, 'empty.txt'), '')

    const result = await Effect.runPromise(call({ path: 'empty.txt' }, dir))

    expect(result?.isError).toBe(false)
    expect(textOf(result)).toBe('(End of file - total 0 lines)')
    await rm(dir, { recursive: true, force: true })
  })

  test('a file that is not UTF-8 is refused before it reaches the model', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-read-'))
    await writeFileDeep(join(dir, 'binary.bin'), new Uint8Array([0xff, 0xfe, 0x00, 0x41, 0x42]))

    const result = await Effect.runPromise(call({ path: 'binary.bin' }, dir))

    expect(result?.isError).toBe(true)
    expect(JSON.stringify(result?.content)).toContain('UTF-8')
    await rm(dir, { recursive: true, force: true })
  })

  test('the byte cap stops the window and says the output was capped', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-read-'))
    await writeFileDeep(join(dir, 'big.txt'), ('y'.repeat(1000) + '\n').repeat(200))

    const result = await Effect.runPromise(call({ path: 'big.txt' }, dir))

    expect(textOf(result)).toContain('(Output capped.')
    expect(textOf(result)).toContain('Continue with offset=')
    const value = result?.value as { readonly text?: string } | undefined
    expect(Buffer.byteLength(value?.text ?? '', 'utf8')).toBeLessThanOrEqual(READ_MAX_BYTES)
    expect(result?.value).toMatchObject({ totalLines: 200, truncated: true })
    await rm(dir, { recursive: true, force: true })
  })

  test('a missing file is an error result', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-read-'))

    const result = await Effect.runPromise(call({ path: 'nope.txt' }, dir))

    expect(result?.isError).toBe(true)
    await rm(dir, { recursive: true, force: true })
  })
})
