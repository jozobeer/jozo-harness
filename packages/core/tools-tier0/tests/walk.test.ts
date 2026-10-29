import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { withFileSystem } from '@jozo-harness/filesystem'
import { nodeFileSystem } from '@jozo-harness/filesystem/node'
import {
  isBinary,
  makeIgnoredPaths,
  readIgnoreRules,
  walkFiles,
  type WalkRequest,
} from '../src/index.ts'

/** The walk against the disk, which is what every Node caller runs. */
const walkOnDisk = (request: WalkRequest): Effect.Effect<ReadonlyArray<string>> =>
  withFileSystem(nodeFileSystem, walkFiles(request))

/** The ignore rules against the disk, for the same reason. */
const rulesOnDisk = (cwd: string) => withFileSystem(nodeFileSystem, readIgnoreRules(cwd))
/** Writes a file, making the directories above it, because the file may not be there yet. */
const writeFileDeep = async (path: string, text: string | Uint8Array): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

const write = async (dir: string, path: string, body = 'x\n'): Promise<void> => {
  await mkdir(join(dir, path, '..'), { recursive: true })
  await writeFileDeep(join(dir, path), body)
}

describe('walkFiles', () => {
  test('never walks node_modules or .git, but does walk other dot-entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-walk-'))
    await write(dir, 'src/a.ts')
    await write(dir, 'node_modules/pkg/index.js')
    await write(dir, 'src/node_modules/pkg/index.js')
    await write(dir, '.git/config')
    await write(dir, '.hidden/file.txt')

    const found = await Effect.runPromise(walkOnDisk({ cwd: dir, limit: 100 }))

    expect(found).toEqual(['.hidden/file.txt', 'src/a.ts'])
    await rm(dir, { recursive: true, force: true })
  })

  test('honours the workspace ignore files, last rule winning', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-walk-'))
    await writeFileDeep(join(dir, '.gitignore'), ['logs/', '*.log', '!keep.log', ''].join('\n'))
    await write(dir, 'logs/debug.txt')
    await write(dir, 'debug.log')
    await write(dir, 'keep.log')
    await write(dir, 'src/a.ts')

    const found = await Effect.runPromise(walkOnDisk({ cwd: dir, limit: 100 }))

    expect(found).toEqual(['.gitignore', 'keep.log', 'src/a.ts'])
    await rm(dir, { recursive: true, force: true })
  })

  test('a nested pattern only matches where it points', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-walk-'))
    await writeFileDeep(join(dir, '.ignore'), ['src/generated/**', '*.tmp', ''].join('\n'))
    await write(dir, 'src/generated/a.ts')
    await write(dir, 'src/kept.ts')
    await write(dir, 'elsewhere/generated/b.ts')
    await write(dir, 'note.tmp')

    const found = await Effect.runPromise(walkOnDisk({ cwd: dir, limit: 100 }))

    expect(found).toEqual(['.ignore', 'elsewhere/generated/b.ts', 'src/kept.ts'])
    await rm(dir, { recursive: true, force: true })
  })

  test('a start directory walks only its subtree', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-walk-'))
    await write(dir, 'src/a.ts')
    await write(dir, 'src/sub/b.ts')
    await write(dir, 'other/c.ts')

    const found = await Effect.runPromise(walkOnDisk({ cwd: dir, limit: 100, start: 'src' }))

    expect(found).toEqual(['src/a.ts', 'src/sub/b.ts'])
    await rm(dir, { recursive: true, force: true })
  })

  test('stops at the limit and reports what it collected', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-walk-'))
    for (let index = 0; index < 5; index += 1) await write(dir, 'f' + String(index) + '.txt')

    const found = await Effect.runPromise(walkOnDisk({ cwd: dir, limit: 2 }))

    expect(found).toHaveLength(2)
    await rm(dir, { recursive: true, force: true })
  })
})

describe('isBinary', () => {
  test('a NUL byte in the head means binary', () => {
    expect(isBinary(new Uint8Array([0x41, 0x00, 0x42]))).toBe(true)
    expect(isBinary(new TextEncoder().encode('plain text\n'))).toBe(false)
  })
})

describe('the ignore rules themselves', () => {
  test('a directory rule does not speak for a file of the same name', async () => {
    const rules = makeIgnoredPaths([
      { negated: false, directoryOnly: true, anchored: false, pattern: 'build' },
    ])

    expect(rules.ignores('build', true)).toBe(true)
    expect(rules.ignores('build', false)).toBe(false)
  })

  test('a missing ignore file is no rules at all', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-walk-'))

    expect(await Effect.runPromise(rulesOnDisk(dir))).toEqual([])
    await rm(dir, { recursive: true, force: true })
  })
})
