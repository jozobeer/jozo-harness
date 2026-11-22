import { HooksLive } from '@jozo-harness/kernel'
import {
  makeImageSpillWriter,
  Tools,
  toolsLayer,
  type ToolDefinition,
  type ToolError,
  type ToolExecutionResult,
} from '@jozo-harness/tools'
import { Context, Effect, Layer } from 'effect'
import { describe, expect, test } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeReadImageTool, readImageTool } from '../src/index.ts'
/** Writes a file, making the directories above it, because the file may not be there yet. */
const writeFileDeep = async (path: string, text: string | Uint8Array): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

const call = (
  tool: ToolDefinition<any, any>,
  args: unknown,
  cwd: string,
  context: { readonly images?: 'base64' | 'none' } = {},
): Effect.Effect<ToolExecutionResult | undefined, ToolError, never> =>
  Effect.scoped(
    Effect.gen(function* () {
      const layerContext = yield* Layer.build(Layer.provideMerge(toolsLayer, HooksLive))
      const tools = Context.get(layerContext, Tools)
      yield* tools.register(tool)
      return yield* tools.call({
        callId: 'c1',
        tool: tool.name,
        arguments: JSON.stringify(args),
        context: { sessionId: 's1', cwd, callId: 'c1', ...context },
      })
    }),
  )

describe('read_image tool', () => {
  test('returns an image block for a png', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-image-'))
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    await writeFileDeep(join(dir, 'tiny.png'), bytes)

    const result = await Effect.runPromise(call(readImageTool, { path: 'tiny.png' }, dir))

    expect(result?.isError).toBe(false)
    const block = result?.content[0]
    expect(block?.type).toBe('image')
    expect(block?.type === 'image' ? block.mediaType : '').toBe('image/png')
    expect(block?.type === 'image' ? block.data.length : 0).toBeGreaterThan(0)
    expect(result?.value).toMatchObject({ mediaType: 'image/png', bytes: 8 })
    await rm(dir, { recursive: true, force: true })
  })

  test('an image spilled under the session opens again through its locator', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-image-'))
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    const write = makeImageSpillWriter({ root: join(dir, 'spill'), sessionId: 's1' })

    const path = await Effect.runPromise(
      write('c1', Buffer.from(bytes).toString('base64'), 'image/png'),
    )
    const result = await Effect.runPromise(call(readImageTool, { path }, dir))

    const block = result?.content[0]
    expect(block?.type).toBe('image')
    expect(block?.type === 'image' ? Buffer.from(block.data, 'base64') : undefined).toEqual(
      Buffer.from(bytes),
    )
    await rm(dir, { recursive: true, force: true })
  })

  test('refuses when the route cannot carry images', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-image-'))
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    await writeFileDeep(join(dir, 'tiny.png'), bytes)

    const result = await Effect.runPromise(
      call(readImageTool, { path: 'tiny.png' }, dir, { images: 'none' }),
    )

    expect(result?.isError).toBe(true)
    expect(JSON.stringify(result?.content)).toContain('cannot carry images')
    await rm(dir, { recursive: true, force: true })
  })

  test('refuses a file that is not a known image', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-image-'))
    await writeFileDeep(join(dir, 'notes.txt'), 'plain')

    const result = await Effect.runPromise(call(readImageTool, { path: 'notes.txt' }, dir))

    expect(result?.isError).toBe(true)
    expect(JSON.stringify(result?.content)).toContain('not a supported image')
    await rm(dir, { recursive: true, force: true })
  })

  test('may share a step with another read, since it only reads a file', () => {
    expect(readImageTool.isConcurrencySafe?.({ path: 'a.png' })).toBe(true)
  })

  test('reads through the reader it was given, so a host supplies its own bytes', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    const asked: Array<string> = []
    const tool = makeReadImageTool((path) => {
      asked.push(path)
      return Effect.succeed(bytes)
    })

    const result = await Effect.runPromise(call(tool, { path: 'photos/tiny.png' }, '/work'))

    // The path asked for is the workspace's, and nothing on this disk was read.
    expect(asked).toEqual(['/work/photos/tiny.png'])
    expect(result?.isError).toBe(false)
    expect(result?.value).toMatchObject({ bytes: 8, mediaType: 'image/png' })
  })

  test('a reader that cannot produce the bytes is an error that names the path', async () => {
    const tool = makeReadImageTool(() => Effect.fail(new Error('no host')))

    const result = await Effect.runPromise(call(tool, { path: 'tiny.png' }, '/work'))

    expect(result?.isError).toBe(true)
    expect(JSON.stringify(result?.content)).toContain('cannot read /work/tiny.png')
  })
})
