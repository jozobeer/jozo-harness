import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import {
  applyMeta,
  metaPathOf,
  readMeta,
  sessionActionOf,
  withMeta,
} from '../src/server/session-meta.ts'

/** A home whose sessions and artifacts sit beside each other, as the web server sees them. */
const rootOf = async (): Promise<string> => {
  const root = join(await mkdtemp(join(tmpdir(), 'jzh-session-meta-')), 'sessions')
  await mkdir(root, { recursive: true })
  return root
}

const summaryOf = (id: string, title: string) => ({
  id,
  cwd: '/work',
  createdAt: 1,
  updatedAt: 2,
  title,
})

describe('the session metadata beside the logs', () => {
  test('a rename is kept as one line, and read back over the first message', async () => {
    const root = await rootOf()
    await mkdir(join(root, 'aaaa'), { recursive: true })

    await Effect.runPromise(
      sessionActionOf(root, 'aaaa', { kind: 'rename', title: '  a better   name ' }),
    )

    const meta = await Effect.runPromise(readMeta(root))
    expect(meta).toEqual({ aaaa: { title: 'a better name' } })
    expect(withMeta(summaryOf('aaaa', 'first message'), meta.aaaa)).toMatchObject({
      title: 'a better name',
    })
  })

  test('pin and archive stand together, and a session nobody touched keeps its own name', async () => {
    const root = await rootOf()
    await mkdir(join(root, 'aaaa'), { recursive: true })
    await mkdir(join(root, 'bbbb'), { recursive: true })

    await Effect.runPromise(sessionActionOf(root, 'aaaa', { kind: 'pin', pinned: true }))
    await Effect.runPromise(sessionActionOf(root, 'aaaa', { kind: 'archive', archived: true }))

    const meta = await Effect.runPromise(readMeta(root))
    const summaries = applyMeta([summaryOf('aaaa', 'first'), summaryOf('bbbb', 'second')], meta)
    expect(summaries[0]).toMatchObject({ title: 'first', pinned: true, archived: true })
    expect(summaries[1]).toMatchObject({ title: 'second', pinned: false, archived: false })
  })

  test('a delete removes the session directory and the metadata that named it', async () => {
    const root = await rootOf()
    await mkdir(join(root, 'cccc'), { recursive: true })
    await writeFile(join(root, 'cccc', 'session.v1.jsonl'), '{}\n')
    const pages = join(dirname(root), 'artifacts', 'cccc')
    await mkdir(pages, { recursive: true })
    await writeFile(join(pages, 'report.html'), '<h1>report</h1>')
    await Effect.runPromise(sessionActionOf(root, 'cccc', { kind: 'rename', title: 'gone soon' }))

    await Effect.runPromise(sessionActionOf(root, 'cccc', { kind: 'delete' }))

    await expect(access(join(root, 'cccc'))).rejects.toThrow()
    await expect(access(pages)).rejects.toThrow()
    expect(await Effect.runPromise(readMeta(root))).toEqual({})
  })

  test('a name that would leave the session root is refused', async () => {
    const root = await rootOf()
    await expect(
      Effect.runPromise(sessionActionOf(root, '../outside', { kind: 'delete' })),
    ).rejects.toThrow(/session id/)
    expect(metaPathOf(root)).toBe(join(root, '.web-meta.json'))
  })
})
