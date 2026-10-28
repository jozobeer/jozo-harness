import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { Effect, Result } from 'effect'
import {
  ATTACHMENT_LIMITS,
  clipAttachments,
  displayNameOf,
  mediaTypeOf,
  type Attachment,
} from '../src/index.ts'
import {
  attachmentPathOf,
  attachmentRootOf,
  readAttachment,
  saveAttachment,
} from '../src/attachment-store.ts'

const roots: Array<string> = []

afterEach(() =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
)

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'jzh-attachments-'))
  roots.push(root)
  return join(root, 'attachments')
}

const store = (root: string, name: string, mediaType: string, data: Uint8Array) =>
  Effect.runPromise(Effect.result(saveAttachment(root, { name, mediaType, data })))

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

describe('the attachment store', () => {
  test('keeps the same content once however many times it is attached', async () => {
    const root = await makeRoot()
    const first = await store(
      root,
      'notes.md',
      'text/markdown',
      new TextEncoder().encode('same body'),
    )
    const second = await store(
      root,
      'copy.md',
      'text/markdown',
      new TextEncoder().encode('same body'),
    )

    expect(Result.isSuccess(first)).toBe(true)
    expect(Result.isSuccess(second)).toBe(true)
    const files = await readdir(root)
    expect(files).toHaveLength(1)
    const kept = Result.getOrThrow(first)
    expect(files[0]).toBe(kept.hash)
    expect(Result.getOrThrow(second).hash).toBe(kept.hash)
    expect(new TextDecoder().decode(await Effect.runPromise(readAttachment(root, kept)))).toBe(
      'same body',
    )
  })

  test('refuses a type the model cannot take, and says which one', async () => {
    const root = await makeRoot()
    const answer = await store(root, 'scan.pdf', 'application/pdf', new Uint8Array([1, 2, 3]))

    expect(Result.isFailure(answer)).toBe(true)
    if (Result.isFailure(answer)) expect(answer.failure.message).toContain('application/pdf')
  })

  test('refuses a file over its size limit', async () => {
    const root = await makeRoot()
    const answer = await store(
      root,
      'big.txt',
      'text/plain',
      new Uint8Array(ATTACHMENT_LIMITS.maxFileBytes + 1).fill(0x61),
    )

    expect(Result.isFailure(answer)).toBe(true)
    if (Result.isFailure(answer)) expect(answer.failure.code).toBe('too-large')
  })

  test('refuses binary bytes under a text type', async () => {
    const root = await makeRoot()
    const answer = await store(root, 'image.txt', 'text/plain', new Uint8Array([65, 0, 66]))

    expect(Result.isFailure(answer)).toBe(true)
    if (Result.isFailure(answer)) expect(answer.failure.code).toBe('unsupported')
  })

  test('stores an image under the type its bytes prove', async () => {
    const root = await makeRoot()
    const answer = await store(root, 'dot.png', 'image/png', PNG)

    expect(Result.isSuccess(answer)).toBe(true)
    if (Result.isSuccess(answer)) expect(answer.success.mediaType).toBe('image/png')
  })

  test('refuses bytes that do not match the image type', async () => {
    const root = await makeRoot()
    const answer = await store(root, 'dot.png', 'image/png', new TextEncoder().encode('not a png'))

    expect(Result.isFailure(answer)).toBe(true)
  })

  test('reads a missing object as a reason rather than empty bytes', async () => {
    const root = await makeRoot()
    const answer = await Effect.runPromise(
      Effect.result(
        readAttachment(root, {
          hash: 'a'.repeat(64),
          mediaType: 'text/plain',
          name: 'gone.txt',
          bytes: 1,
        }),
      ),
    )

    expect(Result.isFailure(answer)).toBe(true)
  })
})

describe('attachment metadata', () => {
  test('names the store beside the session logs and keeps the hash inside it', async () => {
    const root = await makeRoot()
    expect(attachmentRootOf('/home/me/.jzh/sessions')).toBe('/home/me/.jzh/attachments')
    expect(attachmentPathOf(root, 'b'.repeat(64))).toBe(join(root, 'b'.repeat(64)))
    await expect(stat(root)).rejects.toThrow()
  })

  test('takes the display name from the last path part', () => {
    expect(displayNameOf('../../etc/passwd')).toBe('passwd')
    expect(displayNameOf('dir\\note.md')).toBe('note.md')
    expect(displayNameOf('   ')).toBe('')
  })

  test('infers a type from the extension when the browser sends none', () => {
    expect(mediaTypeOf('notes.md', '')).toBe('text/markdown')
    expect(mediaTypeOf('shot.png', 'application/octet-stream')).toBe('image/png')
    expect(mediaTypeOf('thing.bin', 'application/octet-stream')).toBe('application/octet-stream')
  })

  test('drops attachments past the count or byte budget', () => {
    const one = (bytes: number, hash: string): Attachment => ({
      hash,
      mediaType: 'text/plain',
      name: hash + '.txt',
      bytes,
    })
    const many = Array.from({ length: 10 }, (_value, index) =>
      one(1, String(index).padStart(64, '0')),
    )
    expect(clipAttachments(many)).toHaveLength(ATTACHMENT_LIMITS.maxAttachments)
    expect(clipAttachments([one(ATTACHMENT_LIMITS.maxTotalBytes, 'c'.repeat(64))])).toHaveLength(0)
  })
})
