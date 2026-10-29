import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import { makeMemoryFileSystem } from '@jozo-harness/filesystem/memory'
import { ripgrepAt } from '../src/ripgrep.ts'
import { makeGlobTool } from '../src/glob.ts'
import { makeGrepTool } from '../src/grep.ts'
import { makeReadTool } from '../src/read.ts'
import { makeWriteTool } from '../src/write.ts'
import { makeObservedFiles } from '../src/observed-files.ts'
import type { ToolDefinition, ToolRunContext } from '@jozo-harness/tools'

/** A directory that exists only in this call: the workspace a browser run would hold. */
const CWD = '/work'

const context: ToolRunContext = { sessionId: 's1', cwd: CWD, callId: 'c1' }

/** Runs one tool body the way the page would, with no hooks and no pipeline. */
const run = <A, V>(tool: ToolDefinition<A, V>, args: A): Effect.Effect<V, unknown> =>
  tool.execute(args, context)

/** The tools a browser run would offer: the walker instead of a ripgrep it cannot have. */
const toolsInMemory = () => {
  const fileSystem = makeMemoryFileSystem()
  const walker = ripgrepAt(undefined)
  return {
    fileSystem,
    read: makeReadTool(fileSystem, makeObservedFiles()),
    write: makeWriteTool(fileSystem, makeObservedFiles()),
    glob: makeGlobTool(fileSystem, walker),
    grep: makeGrepTool(fileSystem, walker),
  }
}

describe('the file tools against a workspace in memory', () => {
  test('writes, reads, lists, and searches one round trip without touching the disk', async () => {
    const tools = toolsInMemory()

    const written = await Effect.runPromise(
      run(tools.write, { path: 'notes/todo.md', content: 'buy milk\n' }),
    )
    expect(written).toEqual({ path: '/work/notes/todo.md', bytes: 9 })

    const read = await Effect.runPromise(run(tools.read, { path: 'notes/todo.md' }))
    expect(read.text).toBe('1\tbuy milk')
    expect(read.totalLines).toBe(1)

    await Effect.runPromise(run(tools.write, { path: 'src/a.ts', content: 'const x = 1\n' }))
    const listed = await Effect.runPromise(run(tools.glob, { pattern: '**/*.ts' }))
    expect(listed.files).toEqual(['src/a.ts'])

    const found = await Effect.runPromise(run(tools.grep, { pattern: 'milk' }))
    expect(found.matches).toEqual([{ file: 'notes/todo.md', line: 1, text: 'buy milk' }])
  })

  test('keeps each workspace to its own call, so closing the page ends the files', async () => {
    const first = toolsInMemory()
    const second = toolsInMemory()
    await Effect.runPromise(run(first.write, { path: 'a.txt', content: 'x\n' }))

    const again = await Effect.runPromise(run(first.read, { path: 'a.txt' }))
    expect(again.text).toBe('1\tx')

    const gone = await Effect.runPromise(Effect.flip(run(second.read, { path: 'a.txt' })))
    expect(gone).toMatchObject({ code: 'execution', message: 'cannot read /work/a.txt' })
  })

  test('reads a file written before the run started from the files it was given', async () => {
    const fileSystem = makeMemoryFileSystem({ '/work/README.md': '# Hello\n' })
    const read = makeReadTool(fileSystem, makeObservedFiles())

    const value = await Effect.runPromise(run(read, { path: '/work/README.md' }))

    expect(value.text).toBe('1\t# Hello')
  })
})
