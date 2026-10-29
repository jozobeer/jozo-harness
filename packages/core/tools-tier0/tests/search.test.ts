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
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { findRipgrep, makeGlobTool, makeGrepTool, ripgrepAt, type Ripgrep } from '../src/index.ts'
import { nodeFileSystem } from '@jozo-harness/filesystem/node'

/** The tools as a Node run builds them: the disk underneath, ripgrep on PATH. */
const globTool = makeGlobTool(nodeFileSystem)
const grepTool = makeGrepTool(nodeFileSystem)

/** Writes a file, making the directories above it, because the file may not be there yet. */
const writeFileDeep = async (path: string, text: string | Uint8Array): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

const call = (
  tool: ToolDefinition<any, any>,
  args: unknown,
  cwd: string,
  extra: { readonly spill?: (callId: string, text: string) => Effect.Effect<string> } = {},
): Effect.Effect<ToolExecutionResult | undefined, ToolError, never> =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(Layer.provideMerge(toolsLayer, HooksLive))
      const tools = Context.get(context, Tools)
      yield* tools.register(tool)
      return yield* tools.call({
        callId: 'c1',
        tool: tool.name,
        arguments: JSON.stringify(args),
        context: { sessionId: 's1', cwd, callId: 'c1', ...extra },
      })
    }),
  )

/** A writer that keeps what it was asked to store, keyed by call. */
const spillTo = (files: Map<string, string>) => (callId: string, text: string) => {
  files.set(callId, text)
  return Effect.succeed('/spill/' + callId + '.txt')
}

const textOf = (result: ToolExecutionResult | undefined): string =>
  (result?.content ?? []).flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')

interface FakeAnswer {
  readonly stdout?: ReadonlyArray<string>
  readonly exitCode?: number
  readonly stderr?: string
}

/** A ripgrep seam that answers with canned lines, so no test needs a real rg. */
const fakeRipgrep = (
  executable: string | undefined,
  answer: FakeAnswer = {},
  calls: Array<ReadonlyArray<string>> = [],
): Ripgrep => ({
  executable,
  run: async (argv, _cwd, onLine) => {
    calls.push(argv)
    for (const line of answer.stdout ?? []) {
      if (!onLine(line)) return { exitCode: 0, stderr: '', stopped: true }
    }
    return {
      exitCode: answer.exitCode ?? 0,
      stderr: answer.stderr ?? '',
      stopped: false,
    }
  },
})

const workspace = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-search-'))
  await writeFileDeep(join(dir, 'a.ts'), 'const one = 1\n// needle\n')
  await writeFileDeep(join(dir, 'sub', 'b.ts'), 'const two = 2\n')
  await writeFileDeep(join(dir, 'c.md'), 'needle in markdown\n')
  return dir
}

describe('glob tool', () => {
  test('lists matching files sorted', async () => {
    const dir = await workspace()

    const result = await Effect.runPromise(call(globTool, { pattern: '**/*.ts' }, dir))

    expect(result?.value).toMatchObject({ files: ['a.ts', 'sub/b.ts'], seen: 2, truncated: false })
    await rm(dir, { recursive: true, force: true })
  })

  test('orders by modification time, oldest first', async () => {
    const dir = await workspace()
    await utimes(join(dir, 'a.ts'), new Date(2020, 0, 1), new Date(2020, 0, 1))
    await utimes(join(dir, 'sub', 'b.ts'), new Date(2000, 0, 1), new Date(2000, 0, 1))

    const result = await Effect.runPromise(call(globTool, { pattern: '**/*.ts' }, dir))

    expect(result?.value).toMatchObject({ files: ['sub/b.ts', 'a.ts'] })
    await rm(dir, { recursive: true, force: true })
  })

  test('an over-page listing spills the complete list and says where it is', async () => {
    const dir = await workspace()
    await writeFileDeep(join(dir, 'd.ts'), 'const four = 4\n')
    const written = new Map<string, string>()

    const result = await Effect.runPromise(
      call(globTool, { pattern: '**/*.ts', limit: 2 }, dir, { spill: spillTo(written) }),
    )

    expect(result?.value).toMatchObject({
      seen: 3,
      truncated: true,
      locator: '/spill/c1-glob.txt',
    })
    expect(written.get('c1-glob')?.split('\n').sort()).toEqual(['a.ts', 'd.ts', 'sub/b.ts'])
    expect(textOf(result)).toContain('full sorted result is stored at /spill/c1-glob.txt')
    await rm(dir, { recursive: true, force: true })
  })

  test('does not walk node_modules', async () => {
    const dir = await workspace()
    await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true })
    await writeFileDeep(join(dir, 'node_modules', 'pkg', 'index.ts'), 'export {}\n')

    const result = await Effect.runPromise(call(globTool, { pattern: '**/*.ts' }, dir))

    expect(result?.value).toMatchObject({ files: ['a.ts', 'sub/b.ts'], seen: 2, truncated: false })
    await rm(dir, { recursive: true, force: true })
  })

  test('finds files in dot-directories instead of hiding them', async () => {
    const dir = await workspace()
    await writeFileDeep(join(dir, '.github', 'workflows', 'ci.yml'), 'permissions: read-all\n')

    const result = await Effect.runPromise(call(globTool, { pattern: '.github/workflows/**' }, dir))

    expect(result?.value).toMatchObject({
      files: ['.github/workflows/ci.yml'],
      seen: 1,
      truncated: false,
    })
    await rm(dir, { recursive: true, force: true })
  })

  test('starts the walk at the given path', async () => {
    const dir = await workspace()

    const result = await Effect.runPromise(call(globTool, { pattern: '**/*.ts', path: 'sub' }, dir))

    expect(result?.value).toMatchObject({ files: ['sub/b.ts'], seen: 1, truncated: false })
    await rm(dir, { recursive: true, force: true })
  })

  test('refuses a path outside the workspace', async () => {
    const dir = await workspace()

    const result = await Effect.runPromise(
      call(globTool, { pattern: '**/*.ts', path: '../outside' }, dir),
    )

    expect(result?.isError).toBe(true)
    expect(JSON.stringify(result?.content)).toContain('escapes the workspace')
    await rm(dir, { recursive: true, force: true })
  })

  test('a capped listing says how to see the rest', async () => {
    const dir = await workspace()

    const result = await Effect.runPromise(call(globTool, { pattern: '**/*', limit: 1 }, dir))

    expect(result?.value).toMatchObject({ truncated: true })
    expect(textOf(result)).toContain('narrow the pattern')
    await rm(dir, { recursive: true, force: true })
  })
})

describe('grep tool', () => {
  test('reports the file, line number, and text', async () => {
    const dir = await workspace()

    const result = await Effect.runPromise(
      call(grepTool, { pattern: 'needle', include: '**/*.ts' }, dir),
    )

    expect(result?.value).toMatchObject({
      matches: [{ file: 'a.ts', line: 2, text: '// needle' }],
      seen: 1,
      truncated: false,
    })
    await rm(dir, { recursive: true, force: true })
  })

  test('a bad pattern is rejected before scanning', async () => {
    const dir = await workspace()

    const result = await Effect.runPromise(call(grepTool, { pattern: '([' }, dir))

    expect(result?.isError).toBe(true)
    expect(JSON.stringify(result?.content)).toContain('bad pattern')
    await rm(dir, { recursive: true, force: true })
  })

  test('binary files and node_modules are not searched', async () => {
    const dir = await workspace()
    await writeFileDeep(
      join(dir, 'blob.bin'),
      new Uint8Array([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0x01]),
    )
    await mkdir(join(dir, 'node_modules'), { recursive: true })
    await writeFileDeep(join(dir, 'node_modules', 'dep.md'), 'needle from a dependency\n')

    const result = await Effect.runPromise(call(grepTool, { pattern: 'needle' }, dir))

    const value = result?.value as { readonly matches: ReadonlyArray<{ file: string }> }
    expect(value.matches.map((match) => match.file)).toEqual(['a.ts', 'c.md'])
    await rm(dir, { recursive: true, force: true })
  })

  test('an over-page search spills every match and says where they are', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-search-'))
    await writeFileDeep(join(dir, 'many.txt'), 'needle one\nneedle two\nneedle three\n')
    const written = new Map<string, string>()

    const result = await Effect.runPromise(
      call(grepTool, { pattern: 'needle', limit: 1 }, dir, { spill: spillTo(written) }),
    )

    expect(result?.value).toMatchObject({ seen: 3, truncated: true, locator: '/spill/c1-grep.txt' })
    expect(written.get('c1-grep')).toContain('many.txt:1: needle one')
    expect(written.get('c1-grep')).toContain('many.txt:3: needle three')
    expect(textOf(result)).toContain('full result is stored at /spill/c1-grep.txt')
    await rm(dir, { recursive: true, force: true })
  })

  test('searches only under the given path', async () => {
    const dir = await workspace()

    const result = await Effect.runPromise(call(grepTool, { pattern: 'const', path: 'sub' }, dir))

    expect(result?.value).toMatchObject({
      matches: [{ file: 'sub/b.ts', line: 1, text: 'const two = 2' }],
      seen: 1,
      truncated: false,
    })
    await rm(dir, { recursive: true, force: true })
  })

  test('searches dot-directories instead of hiding them', async () => {
    const dir = await workspace()
    await writeFileDeep(join(dir, '.github', 'workflows', 'ci.yml'), 'permissions: read-all\n')

    const result = await Effect.runPromise(call(grepTool, { pattern: 'permissions' }, dir))

    expect(result?.value).toMatchObject({
      matches: [{ file: '.github/workflows/ci.yml', line: 1, text: 'permissions: read-all' }],
      seen: 1,
      truncated: false,
    })
    await rm(dir, { recursive: true, force: true })
  })

  test('refuses a path outside the workspace', async () => {
    const dir = await workspace()

    const result = await Effect.runPromise(
      call(grepTool, { pattern: 'needle', path: '../outside' }, dir),
    )

    expect(result?.isError).toBe(true)
    expect(JSON.stringify(result?.content)).toContain('escapes the workspace')
    await rm(dir, { recursive: true, force: true })
  })

  test('a capped search says how to see the rest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-search-'))
    await writeFileDeep(join(dir, 'many.txt'), 'needle one\nneedle two\nneedle three\n')

    const result = await Effect.runPromise(call(grepTool, { pattern: 'needle', limit: 1 }, dir))

    expect(result?.value).toMatchObject({ truncated: true })
    expect(textOf(result)).toContain('narrow the pattern')
    await rm(dir, { recursive: true, force: true })
  })
})
describe('ripgrep search', () => {
  test('nested .gitignore files keep ignored files out of glob and grep', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-ripgrep-'))
    await writeFileDeep(join(dir, '.gitignore'), 'root-ignored.ts\n')
    await writeFileDeep(join(dir, 'root-ignored.ts'), 'needle from the root\n')
    await writeFileDeep(join(dir, 'sub', '.gitignore'), 'ignored.ts\n')
    await writeFileDeep(join(dir, 'sub', 'ignored.ts'), 'needle from a nested ignore\n')
    await writeFileDeep(join(dir, 'sub', 'kept.ts'), 'needle kept\n')
    await writeFileDeep(
      join(dir, 'blob.bin'),
      new Uint8Array([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00]),
    )

    if (findRipgrep() === undefined) {
      // Without rg the walker cannot read nested ignore files; the result must say so.
      const result = await Effect.runPromise(call(globTool, { pattern: '**/*.ts' }, dir))
      expect(result?.value).toMatchObject({ fallback: 'is not on PATH' })
      expect(textOf(result)).toContain('cannot honour nested ignore files')
      await rm(dir, { recursive: true, force: true })
      return
    }

    const listed = await Effect.runPromise(call(globTool, { pattern: '**/*.ts' }, dir))
    expect(listed?.value).toMatchObject({ files: ['sub/kept.ts'] })
    expect(listed?.value).not.toHaveProperty('fallback')

    const found = await Effect.runPromise(call(grepTool, { pattern: 'needle' }, dir))
    const value = found?.value as { readonly matches: ReadonlyArray<{ readonly file: string }> }
    expect(value.matches.map((match) => match.file)).toEqual(['sub/kept.ts'])
    await rm(dir, { recursive: true, force: true })
  })

  test('a binary file ripgrep matched is dropped from its result', async () => {
    const lines = [
      JSON.stringify({ type: 'begin', data: { path: { text: 'blob.bin' } } }),
      JSON.stringify({
        type: 'match',
        data: { path: { text: 'blob.bin' }, lines: { text: 'needle\n' }, line_number: 1 },
      }),
      JSON.stringify({
        type: 'end',
        data: { path: { text: 'blob.bin' }, binary_offset: 6 },
      }),
      JSON.stringify({ type: 'begin', data: { path: { text: 'a.ts' } } }),
      JSON.stringify({
        type: 'match',
        data: { path: { text: 'a.ts' }, lines: { text: 'needle\n' }, line_number: 2 },
      }),
      JSON.stringify({ type: 'end', data: { path: { text: 'a.ts' }, binary_offset: null } }),
    ]
    const tool = makeGrepTool(nodeFileSystem, fakeRipgrep('/fake/rg', { stdout: lines }))

    const result = await Effect.runPromise(call(tool, { pattern: 'needle' }, tmpdir()))

    expect(result?.value).toEqual({
      matches: [{ file: 'a.ts', line: 2, text: 'needle' }],
      seen: 1,
      truncated: false,
    })
  })

  test('a run without ripgrep falls back to the walker and says why', async () => {
    const dir = await workspace()
    const glob = makeGlobTool(nodeFileSystem, fakeRipgrep(undefined))
    const grep = makeGrepTool(nodeFileSystem, fakeRipgrep(undefined))

    const listed = await Effect.runPromise(call(glob, { pattern: '**/*.ts' }, dir))
    expect(listed?.value).toMatchObject({
      files: ['a.ts', 'sub/b.ts'],
      seen: 2,
      truncated: false,
      fallback: 'is not on PATH',
    })
    expect(textOf(listed)).toContain('cannot honour nested ignore files')

    const found = await Effect.runPromise(call(grep, { pattern: 'needle' }, dir))
    const value = found?.value as {
      readonly matches: ReadonlyArray<{ readonly file: string; readonly line: number }>
    }
    expect(value.matches).toEqual([
      { file: 'a.ts', line: 2, text: '// needle' },
      { file: 'c.md', line: 1, text: 'needle in markdown' },
    ])
    expect(textOf(found)).toContain('is not on PATH')
    await rm(dir, { recursive: true, force: true })
  })

  test('a failing ripgrep run falls back with its reason', async () => {
    const dir = await workspace()
    const tool = makeGrepTool(
      nodeFileSystem,
      fakeRipgrep('/fake/rg', { exitCode: 2, stderr: 'cannot read the tree' }),
    )

    const result = await Effect.runPromise(
      call(tool, { pattern: 'needle', include: '**/*.ts' }, dir),
    )

    expect(result?.value).toMatchObject({ fallback: 'failed: cannot read the tree' })
    expect(textOf(result)).toContain('failed: cannot read the tree')
    await rm(dir, { recursive: true, force: true })
  })

  test('asks ripgrep to honour ignore rules instead of disabling them', async () => {
    const calls: Array<ReadonlyArray<string>> = []
    const rg = fakeRipgrep('/fake/rg', { stdout: ['sub/kept.ts', ''] }, calls)
    await Effect.runPromise(
      call(makeGlobTool(nodeFileSystem, rg), { pattern: '**/*.ts', path: 'sub' }, tmpdir()),
    )
    await Effect.runPromise(
      call(
        makeGrepTool(nodeFileSystem, rg),
        { pattern: 'needle', include: '**/*.ts', path: 'sub' },
        tmpdir(),
      ),
    )

    expect(calls).toHaveLength(2)
    for (const argv of calls) {
      expect(argv).toContain('--no-require-git')
      expect(argv).toContain('--no-ignore-parent')
      expect(argv).not.toContain('--no-ignore')
    }
    const globCall = calls[0] ?? []
    const grepCall = calls[1] ?? []
    expect(globCall.slice(-2)).toEqual(['--', 'sub'])
    expect(grepCall).toContain('--json')
    expect(grepCall).not.toContain('**/*.ts')
    expect(grepCall.slice(-2)).toEqual(['--', 'sub'])
  })

  test('a search that found nothing does not fall back', async () => {
    const tool = makeGrepTool(nodeFileSystem, fakeRipgrep('/fake/rg', { exitCode: 1 }))

    const result = await Effect.runPromise(call(tool, { pattern: 'needle' }, tmpdir()))

    expect(result?.value).toEqual({ matches: [], seen: 0, truncated: false })
  })

  test('streams the lines of a program and stops it at the limit', async () => {
    const rg = ripgrepAt(process.execPath)
    const lines: Array<string> = []

    const script = String.raw`process.stdout.write('one\ntwo\nthree\n')`

    const run = await rg.run(['-e', script], tmpdir(), (line) => {
      lines.push(line)
      return lines.length < 2
    })

    expect(lines).toEqual(['one', 'two'])
    expect(run.stopped).toBe(true)
  })

  test('the seam without a program answers without spawning', async () => {
    const run = await ripgrepAt(undefined).run([], tmpdir(), () => true)

    expect(run).toEqual({ exitCode: 127, stderr: 'rg is not on PATH', stopped: false })
  })

  test('a seam that throws falls back with its message', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-ripgrep-'))
    await writeFileDeep(join(dir, 'a.txt'), 'needle\n')
    const broken: Ripgrep = {
      executable: '/fake/rg',
      run: async () => {
        throw new Error('boom')
      },
    }

    const result = await Effect.runPromise(
      call(makeGrepTool(nodeFileSystem, broken), { pattern: 'needle' }, dir),
    )

    expect(result?.value).toMatchObject({ fallback: 'failed: boom', seen: 1 })
    await rm(dir, { recursive: true, force: true })
  })
})
