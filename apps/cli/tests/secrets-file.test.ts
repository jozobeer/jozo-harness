import { statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'
import { listSecrets, removeSecret, writeSecret } from '../src/index.ts'
/** Writes a file, making the directories above it, because the file may not be there yet. */
const writeFileDeep = async (path: string, text: string | Uint8Array): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

const withFile = async (body?: string) => {
  const directory = await mkdtemp(join(tmpdir(), 'jozo-harness-secret-file-'))
  const path = join(directory, 'secrets.env')
  if (body !== undefined) await writeFileDeep(path, body)
  return { directory, path }
}

describe('writeSecret', () => {
  test('creates the file with 600 and one line', async () => {
    const { directory, path } = await withFile()

    writeSecret(path, 'OLLAMA_API_KEY', 'secret-value')

    expect(await readFile(path, 'utf8')).toBe('OLLAMA_API_KEY=secret-value\n')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    await rm(directory, { recursive: true, force: true })
  })

  test('replaces the file through a rename so a reader never sees a cut', async () => {
    const { directory, path } = await withFile('# my keys\nA=1\n')
    const before = statSync(path).ino

    writeSecret(path, 'B', '2')

    expect(await readFile(path, 'utf8')).toBe('# my keys\nA=1\nB=2\n')
    // The new inode is complete before the target names it; the old inode keeps
    // the complete old text for a reader that already opened it.
    expect(statSync(path).ino).not.toBe(before)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    await rm(directory, { recursive: true, force: true })
  })

  test('replaces a value in place and keeps comments', async () => {
    const { directory, path } = await withFile('# my keys\nA=1\nB=2\n')

    writeSecret(path, 'A', 'updated')

    expect(await readFile(path, 'utf8')).toBe('# my keys\nA=updated\nB=2\n')
    await rm(directory, { recursive: true, force: true })
  })
})

describe('listSecrets and removeSecret', () => {
  test('lists names only and removes one', async () => {
    const { directory, path } = await withFile('A=1\nB=2\n')

    expect(listSecrets(path)).toEqual(['A', 'B'])
    expect(removeSecret(path, 'A')).toBe(true)
    expect(listSecrets(path)).toEqual(['B'])
    expect(removeSecret(path, 'missing')).toBe(false)
    await rm(directory, { recursive: true, force: true })
  })
})
