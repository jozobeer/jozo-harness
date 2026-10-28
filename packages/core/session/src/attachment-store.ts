import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Data, Effect } from 'effect'
import {
  ATTACHMENT_LIMITS,
  displayNameOf,
  isImageMediaType,
  isSupportedMediaType,
  mediaTypeOf,
  type Attachment,
} from './attachment.ts'

/** A refusal from the attachment store, with the reason the page or model reads. */
export class AttachmentError extends Data.TaggedError('AttachmentError')<{
  readonly code: 'unsupported' | 'too-large' | 'invalid'
  readonly message: string
}> {}

/** What the store needs to keep one file: its display name, declared type, and bytes. */
export interface SaveAttachmentInput {
  readonly name: string
  readonly mediaType: string
  readonly data: Uint8Array
}

/** The directory that holds attachments: beside the session logs, not inside one. */
export const attachmentRootOf = (sessionRoot: string): string =>
  join(dirname(sessionRoot), 'attachments')

/** The one path a hash names. The hash is hex, so it cannot leave the store. */
export const attachmentPathOf = (root: string, hash: string): string => join(root, hash)

const HASH = /^[0-9a-f]{64}$/

/** The media type the bytes themselves prove, for the formats an image block accepts. */
const sniffImage = (bytes: Uint8Array): string | undefined => {
  const starts = (...values: ReadonlyArray<number>): boolean =>
    values.every((value, index) => bytes[index] === value)
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif'
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp'
  return undefined
}

/** True when the bytes look like UTF-8 text rather than a binary a text type lied about. */
const looksLikeText = (bytes: Uint8Array): boolean => {
  for (const byte of bytes) if (byte === 0) return false
  return true
}

const mediaTypeFor = (input: SaveAttachmentInput): Effect.Effect<string, AttachmentError> =>
  Effect.gen(function* () {
    const sniffed = isImageMediaType(input.mediaType) ? sniffImage(input.data) : undefined
    if (isImageMediaType(input.mediaType) && sniffed !== input.mediaType) {
      return yield* Effect.fail(
        new AttachmentError({
          code: 'unsupported',
          message:
            'the bytes of ' +
            input.name +
            ' are not the image its type says (' +
            input.mediaType +
            ')',
        }),
      )
    }
    if (!isSupportedMediaType(input.mediaType)) {
      return yield* Effect.fail(
        new AttachmentError({
          code: 'unsupported',
          message:
            'cannot attach ' + input.name + ': ' + input.mediaType + ' is not a supported type',
        }),
      )
    }
    if (!isImageMediaType(input.mediaType) && !looksLikeText(input.data)) {
      return yield* Effect.fail(
        new AttachmentError({
          code: 'unsupported',
          message: 'cannot attach ' + input.name + ': it is binary, not text',
        }),
      )
    }
    return input.mediaType
  })

/**
 * Validates one upload and keeps it under the hash of its bytes. A second copy
 * of the same content reuses the object already there, so the store holds one
 * file per content and a message can name it without carrying it.
 */
export const saveAttachment = (
  root: string,
  input: SaveAttachmentInput,
): Effect.Effect<Attachment, AttachmentError> =>
  Effect.gen(function* () {
    const name = displayNameOf(input.name)
    if (name === '') {
      return yield* Effect.fail(
        new AttachmentError({ code: 'invalid', message: 'the attachment has no file name' }),
      )
    }
    const declared = mediaTypeOf(name, input.mediaType)
    // The size is checked before the content, so an oversized file is told it is
    // too large rather than that its first bytes look binary.
    const limit = isImageMediaType(declared)
      ? ATTACHMENT_LIMITS.maxImageBytes
      : ATTACHMENT_LIMITS.maxFileBytes
    if (input.data.byteLength > limit) {
      return yield* Effect.fail(
        new AttachmentError({
          code: 'too-large',
          message:
            'cannot attach ' +
            name +
            ': ' +
            String(input.data.byteLength) +
            ' bytes exceeds the ' +
            String(limit) +
            '-byte limit',
        }),
      )
    }
    const mediaType = yield* mediaTypeFor({ ...input, name, mediaType: declared })
    const hash = createHash('sha256').update(input.data).digest('hex')
    const path = attachmentPathOf(root, hash)
    const present = yield* Effect.promise(() =>
      stat(path).then(
        () => true,
        () => false,
      ),
    )
    if (!present) {
      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(root, { recursive: true, mode: 0o700 })
          const temporary = path + '.' + String(process.pid) + '.' + String(Date.now())
          await writeFile(temporary, input.data, { mode: 0o600 })
          await rename(temporary, path).catch(async (error: unknown) => {
            await unlink(temporary).catch(() => undefined)
            // Another writer named the same hash first; the bytes are identical.
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          })
        },
        catch: (cause) =>
          new AttachmentError({
            code: 'invalid',
            message:
              'cannot store ' +
              name +
              ': ' +
              (cause instanceof Error ? cause.message : String(cause)),
          }),
      })
    }
    return { hash, mediaType, name, bytes: input.data.byteLength }
  })

/**
 * Reads the bytes one attachment names. A message written on another machine
 * or after the store was cleaned up fails with the reason instead of arriving
 * as an empty file.
 */
export const readAttachment = (
  root: string,
  attachment: Attachment,
): Effect.Effect<Uint8Array, AttachmentError> => {
  if (!HASH.test(attachment.hash)) {
    return Effect.fail(
      new AttachmentError({ code: 'invalid', message: 'the attachment hash is not sha256' }),
    )
  }
  return Effect.tryPromise({
    try: () => readFile(attachmentPathOf(root, attachment.hash)),
    catch: () =>
      new AttachmentError({
        code: 'invalid',
        message: 'the stored bytes of ' + attachment.name + ' are missing',
      }),
  })
}
