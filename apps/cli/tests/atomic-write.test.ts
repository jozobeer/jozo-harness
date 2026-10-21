import { readdirSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { writeFileAtomic } from '../src/atomic-write.ts'

const withDirectory = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jozo-harness-atomic-write-'))
  return { directory, path: join(directory, 'config.yaml') }
}

describe('writeFileAtomic', () => {
  test('replaces the file instead of truncating it in place', async () => {
    const { directory, path } = await withDirectory()
    await writeFile(path, 'old\n')
    const before = statSync(path).ino

    writeFileAtomic(path, 'new\n')

    expect(await readFile(path, 'utf8')).toBe('new\n')
    // A reader holding the old inode keeps the complete old text; the target
    // names a fresh inode only after the new text is whole.
    expect(statSync(path).ino).not.toBe(before)
    await rm(directory, { recursive: true, force: true })
  })

  test('creates the directories above a file that is not there', async () => {
    const { directory } = await withDirectory()
    const path = join(directory, 'jzh', 'config.yaml')

    writeFileAtomic(path, 'model: x\n', { mode: 0o600 })

    expect(await readFile(path, 'utf8')).toBe('model: x\n')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    await rm(directory, { recursive: true, force: true })
  })

  test('keeps the mode of the file it replaces when none is stated', async () => {
    const { directory, path } = await withDirectory()
    await writeFile(path, 'old\n', { mode: 0o640 })

    writeFileAtomic(path, 'new\n')

    expect(statSync(path).mode & 0o777).toBe(0o640)
    await rm(directory, { recursive: true, force: true })
  })

  test('removes its temporary sibling when the replacement fails', async () => {
    const { directory, path } = await withDirectory()
    // A directory cannot be replaced by a rename, so the commit fails after the
    // text was written; nothing of that attempt may stay behind.
    await writeFile(join(directory, 'keep'), '')
    await mkdir(path)

    expect(() => writeFileAtomic(path, 'lost\n')).toThrow()
    expect(readdirSync(directory).sort()).toEqual(['config.yaml', 'keep'])
    await rm(directory, { recursive: true, force: true })
  })
})
