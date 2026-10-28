import { describe, expect, test } from 'vitest'
import { Effect } from 'effect'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeImageSpillWriter, makeSpillWriter, pruneSpills } from '../src/index.ts'
/** Writes a file, making the directories above it, because the file may not be there yet. */
const writeFileDeep = async (path: string, text: string | Uint8Array): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

const DAY = 24 * 60 * 60 * 1000

const root = async (): Promise<string> => await mkdtemp(join(tmpdir(), 'jozo-harness-store-'))

describe('makeSpillWriter', () => {
  test('writes one file per call under the session directory and returns its path', async () => {
    const store = await root()
    const write = makeSpillWriter({ root: store, sessionId: 'session-1' })

    const path = await Effect.runPromise(write('call-1', 'the whole text'))

    expect(path).toBe(join(store, 'session-1', 'call-1.txt'))
    expect(await readFile(path, 'utf8')).toBe('the whole text')
    await rm(store, { recursive: true, force: true })
  })

  test('the session directory is readable only by its owner', async () => {
    const store = await root()
    const write = makeSpillWriter({ root: store, sessionId: 'session-1' })

    await Effect.runPromise(write('call-1', 'text'))

    const info = await stat(join(store, 'session-1'))
    expect(info.mode & 0o777).toBe(0o700)
    await rm(store, { recursive: true, force: true })
  })

  test('opening a store for a new session clears the sessions that went stale', async () => {
    const store = await root()
    const stale = join(store, 'old-session')
    const fresh = join(store, 'fresh-session')
    await mkdir(stale, { recursive: true })
    await mkdir(fresh, { recursive: true })
    const now = Date.now()
    await utimes(stale, new Date(now - 30 * DAY), new Date(now - 30 * DAY))
    const write = makeSpillWriter({ root: store, sessionId: 'new-session', now: () => now })

    await Effect.runPromise(write('call-1', 'text'))

    expect(await readdir(store)).toEqual(expect.arrayContaining(['fresh-session', 'new-session']))
    expect(await readdir(store)).not.toContain('old-session')
    await rm(store, { recursive: true, force: true })
  })
})

describe('makeImageSpillWriter', () => {
  test('writes the image bytes where read_image can open them', async () => {
    const store = await root()
    const write = makeImageSpillWriter({ root: store, sessionId: 'session-1' })
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])

    const path = await Effect.runPromise(
      write('call-1', bytes.toString('base64'), 'image/png'),
    )

    expect(path).toBe(join(store, 'session-1', 'call-1.png'))
    expect(await readFile(path)).toEqual(bytes)
    await rm(store, { recursive: true, force: true })
  })

  test('keeps a media type it does not know as bytes with a neutral extension', async () => {
    const store = await root()
    const write = makeImageSpillWriter({ root: store, sessionId: 'session-1' })

    const path = await Effect.runPromise(
      write('call-1', Buffer.from([1, 2]).toString('base64'), 'image/avif'),
    )

    expect(path).toBe(join(store, 'session-1', 'call-1.bin'))
    await rm(store, { recursive: true, force: true })
  })
})

describe('pruneSpills', () => {
  test('removes a stale session and keeps a fresh one', async () => {
    const store = await root()
    const stale = join(store, 'old-session')
    const fresh = join(store, 'fresh-session')
    await mkdir(stale, { recursive: true })
    await mkdir(fresh, { recursive: true })
    const now = Date.now()
    await utimes(stale, new Date(now - 30 * DAY), new Date(now - 30 * DAY))

    await Effect.runPromise(pruneSpills(store, 7 * DAY, () => now))

    expect(await readdir(store)).toEqual(['fresh-session'])
    await rm(store, { recursive: true, force: true })
  })

  test('a loose file at the root is not a session and stays', async () => {
    const store = await root()
    await writeFileDeep(join(store, 'notes.txt'), 'not mine')

    await Effect.runPromise(pruneSpills(store, 7 * DAY, () => Date.now()))

    expect(await readdir(store)).toEqual(['notes.txt'])
    await rm(store, { recursive: true, force: true })
  })

  test('a missing root has nothing to remove', async () => {
    const store = join(tmpdir(), 'jozo-harness-store-missing-' + crypto.randomUUID())

    await Effect.runPromise(pruneSpills(store, 7 * DAY, () => Date.now()))
  })
})