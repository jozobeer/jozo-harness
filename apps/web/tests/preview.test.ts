import { describe, expect, test } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Effect } from 'effect'
import { PREVIEW_LIMIT, TEXT_HEAD, readWorkspaceFile } from '../src/server/preview.ts'

const read = async (root: string, path: string) => Effect.runPromise(readWorkspaceFile(root, path))

const refused = async (root: string, path: string): Promise<string> => {
  try {
    await read(root, path)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('the read should have been refused')
}

const workspace = async (): Promise<string> => mkdtemp(join(tmpdir(), 'jozo-harness-preview-'))

const writeFileDeep = async (path: string, data: string | Buffer): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, data)
}

describe('the workspace file preview', () => {
  test('source text arrives as text with the path the tree uses', async () => {
    const root = await workspace()
    try {
      await writeFileDeep(join(root, 'apps/web/answer.ts'), 'export const answer = 42\n')
      const view = await read(root, 'apps/web/answer.ts')
      expect(view).toMatchObject({
        path: 'apps/web/answer.ts',
        kind: 'text',
        mediaType: 'text/plain',
        text: 'export const answer = 42\n',
        truncated: false,
      })
      expect(view.size).toBe(Buffer.byteLength('export const answer = 42\n'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('Markdown and HTML keep their kind so the page can draw them', async () => {
    const root = await workspace()
    try {
      await writeFileDeep(join(root, 'README.md'), '# Title\n')
      await writeFileDeep(join(root, 'page.html'), '<h1>Title</h1>\n')
      expect(await read(root, 'README.md')).toMatchObject({
        kind: 'markdown',
        mediaType: 'text/markdown',
        text: '# Title\n',
      })
      expect(await read(root, 'page.html')).toMatchObject({
        kind: 'html',
        mediaType: 'text/html',
        text: '<h1>Title</h1>\n',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('an image arrives as base64 under its own type', async () => {
    const root = await workspace()
    try {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      await writeFileDeep(join(root, 'pixel.png'), png)
      const view = await read(root, 'pixel.png')
      expect(view.kind).toBe('image')
      expect(view.mediaType).toBe('image/png')
      expect(view.data).toBe(png.toString('base64'))
      expect(view.text).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a PDF arrives as base64 the page can hand to its viewer', async () => {
    const root = await workspace()
    try {
      const pdf = Buffer.from('%PDF-1.4\n')
      await writeFileDeep(join(root, 'notes.pdf'), pdf)
      const view = await read(root, 'notes.pdf')
      expect(view).toMatchObject({ kind: 'pdf', mediaType: 'application/pdf', truncated: false })
      expect(view.data).toBe(pdf.toString('base64'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a large text offers its head and says the rest stayed on disk', async () => {
    const root = await workspace()
    try {
      await writeFileDeep(join(root, 'log.txt'), 'a'.repeat(TEXT_HEAD + 100))
      const view = await read(root, 'log.txt')
      expect(view.truncated).toBe(true)
      expect(view.text).toHaveLength(TEXT_HEAD)
      expect(view.size).toBe(TEXT_HEAD + 100)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a character cut by the head is dropped instead of drawn as a replacement', async () => {
    const root = await workspace()
    try {
      // The last byte of the head is the first byte of a three-byte character.
      const body = 'a'.repeat(TEXT_HEAD - 1) + 'あ' + 'b'.repeat(10)
      await writeFileDeep(join(root, 'wide.txt'), body)
      const view = await read(root, 'wide.txt')
      expect(view.truncated).toBe(true)
      expect(view.text).toBe('a'.repeat(TEXT_HEAD - 1))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a file larger than the preview limit is refused with its size', async () => {
    const root = await workspace()
    try {
      await writeFileDeep(join(root, 'huge.bin'), Buffer.alloc(PREVIEW_LIMIT + 1))
      const message = await refused(root, 'huge.bin')
      expect(message).toContain(String(PREVIEW_LIMIT + 1))
      expect(message).toContain('preview limit')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a name that climbs out of the workspace is refused before the disk is touched', async () => {
    const root = await workspace()
    try {
      expect(await refused(root, '../secret.txt')).toContain('outside the workspace')
      expect(await refused(root, '/etc/passwd')).toContain('outside the workspace')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a link that lands outside the workspace is refused by its target', async () => {
    const root = await workspace()
    const outside = await workspace()
    try {
      await writeFile(join(outside, 'secret.txt'), 'secret')
      await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'))
      expect(await refused(root, 'escape.txt')).toContain('outside the workspace')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('a folder is not a file to preview', async () => {
    const root = await workspace()
    try {
      await mkdir(join(root, 'folder'))
      expect(await refused(root, 'folder')).toContain('not a file')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('Office files say why they have no preview and keep their bytes', async () => {
    const root = await workspace()
    try {
      const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00])
      await writeFileDeep(join(root, 'deck.pptx'), bytes)
      const view = await read(root, 'deck.pptx')
      expect(view.kind).toBe('unsupported')
      expect(view.reason).toContain('cannot convert pptx to PDF')
      expect(view.data).toBeUndefined()
      expect(await readFile(join(root, 'deck.pptx'))).toEqual(bytes)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a binary that is not UTF-8 is refused with a reason', async () => {
    const root = await workspace()
    try {
      await writeFileDeep(join(root, 'blob.bin'), Buffer.from([0xff, 0xfe, 0x00]))
      const view = await read(root, 'blob.bin')
      expect(view.kind).toBe('unsupported')
      expect(view.reason).toContain('not UTF-8 text')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
