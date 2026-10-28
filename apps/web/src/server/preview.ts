import { isUtf8 } from 'node:buffer'
import { readFile, stat } from 'node:fs/promises'
import { extname, relative, resolve } from 'node:path'
import { Effect, Result } from 'effect'
import type { WorkspacePreview } from '../shared/rpc.ts'
import { realOf, within } from './inside.ts'
import { officeToPdf, type OfficeConverter } from './office.ts'

/** The most bytes a text preview hands the page; the rest stays on disk. */
export const TEXT_HEAD = 256 * 1024

/** The most bytes any preview carries; a larger file is refused with its size. */
export const PREVIEW_LIMIT = 4 * 1024 * 1024

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
}

const OFFICE_TYPES: Readonly<Record<string, string>> = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

/** Formats with no text to show, so a run of valid bytes is not read as prose. */
const BINARY_TYPES = new Set([
  '.zip',
  '.gz',
  '.tar',
  '.7z',
  '.bz2',
  '.xz',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.wasm',
  '.mp3',
  '.mp4',
  '.mov',
  '.wav',
  '.ogg',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.ico',
  '.pdf',
])

/** What stat says about an existing path, or undefined when it went away. */
const statOf = (path: string): Effect.Effect<Awaited<ReturnType<typeof stat>> | undefined> =>
  Effect.tryPromise({
    try: () => stat(path),
    catch: () => undefined,
  }).pipe(Effect.orElseSucceed(() => undefined))

const bytesOf = (path: string): Effect.Effect<Buffer, Error> =>
  Effect.tryPromise({
    try: () => readFile(path),
    catch: () => new Error('cannot read this file'),
  })

/** The refusal a file of this size earns: the page says how big it is and stops. */
const tooLarge = (size: number): Error =>
  new Error(
    'this file is ' +
      String(size) +
      ' bytes, larger than the ' +
      String(PREVIEW_LIMIT) +
      ' byte preview limit',
  )

/** The bytes one UTF-8 sequence starting with this byte takes, from its lead byte. */
const widthOf = (lead: number): number => {
  if (lead >= 0xf0) return 4
  if (lead >= 0xe0) return 3
  if (lead >= 0xc0) return 2
  return 1
}

const isContinuation = (byte: number): boolean => (byte & 0xc0) === 0x80

/**
 * The head of a text file, cut where a character ends. A cut inside a UTF-8
 * sequence would draw a replacement glyph, so the partial bytes are dropped
 * rather than letting the page invent text.
 */
const headOf = (bytes: Buffer): { readonly text: string; readonly truncated: boolean } => {
  if (bytes.length <= TEXT_HEAD) return { text: bytes.toString('utf8'), truncated: false }
  let start = TEXT_HEAD - 1
  while (start > 0 && isContinuation(bytes[start]!)) start -= 1
  const end = start + widthOf(bytes[start]!) <= TEXT_HEAD ? TEXT_HEAD : start
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true }
}

const unsupported = (
  path: string,
  mediaType: string,
  size: number,
  reason: string,
): WorkspacePreview => ({
  path,
  kind: 'unsupported',
  mediaType,
  size,
  truncated: false,
  reason,
})

/** The image, PDF, Office, or binary answer, or undefined when the file is text. */
const binaryOf = (
  path: string,
  size: number,
  bytes: Buffer,
  extension: string,
): WorkspacePreview | undefined => {
  const imageType = IMAGE_TYPES[extension]
  if (imageType !== undefined) {
    return {
      path,
      kind: 'image',
      mediaType: imageType,
      size,
      data: bytes.toString('base64'),
      truncated: false,
    }
  }
  if (extension === '.pdf') {
    return {
      path,
      kind: 'pdf',
      mediaType: 'application/pdf',
      size,
      data: bytes.toString('base64'),
      truncated: false,
    }
  }
  if (BINARY_TYPES.has(extension)) {
    return unsupported(
      path,
      'application/octet-stream',
      size,
      'this file type has no preview on this page',
    )
  }
  return undefined
}

/** How the page draws a text file: Markdown and HTML get their own renderer. */
const textKindOf = (extension: string): 'markdown' | 'html' | 'text' => {
  if (extension === '.md' || extension === '.markdown') return 'markdown'
  if (extension === '.html' || extension === '.htm') return 'html'
  return 'text'
}

const textOf = (path: string, size: number, bytes: Buffer, extension: string): WorkspacePreview => {
  if (!isUtf8(bytes)) {
    return unsupported(
      path,
      'application/octet-stream',
      size,
      'this file is not UTF-8 text, so it has no preview on this page',
    )
  }
  const head = headOf(bytes)
  const kind = textKindOf(extension)
  const mediaType =
    kind === 'markdown' ? 'text/markdown' : kind === 'html' ? 'text/html' : 'text/plain'
  return { path, kind, mediaType, size, text: head.text, truncated: head.truncated }
}

/**
 * One Office file as PDF when a converter can make one. A host without a
 * converter, or one that refuses this file, answers with the reason instead;
 * the workspace file is only read either way.
 */
const officePreview = (
  path: string,
  size: number,
  bytes: Buffer,
  extension: string,
  convert: OfficeConverter,
): Effect.Effect<WorkspacePreview, Error> =>
  Effect.gen(function* () {
    const converted = yield* Effect.result(convert(bytes, extension))
    const mediaType = OFFICE_TYPES[extension] ?? 'application/octet-stream'
    if (Result.isFailure(converted)) {
      return unsupported(path, mediaType, size, converted.failure.message)
    }
    const pdf = converted.success
    if (pdf === undefined) {
      return unsupported(
        path,
        mediaType,
        size,
        'this host has no converter for ' + extension.slice(1),
      )
    }
    return {
      path,
      kind: 'pdf',
      mediaType: 'application/pdf',
      size: pdf.length,
      data: pdf.toString('base64'),
      truncated: false,
    }
  })

/** The real path the workspace may read: both the typed name and its target land inside. */
const realInside = (root: string, typed: string): Effect.Effect<string, Error> =>
  Effect.gen(function* () {
    const target = resolve(root, typed)
    if (!within(root, target))
      return yield* Effect.fail(new Error('the file is outside the workspace'))
    const real = yield* realOf(target)
    if (real === undefined) return yield* Effect.fail(new Error('no such file'))
    if (!within(root, real))
      return yield* Effect.fail(new Error('the file is outside the workspace'))
    return real
  })

/** The size of a regular file the page may carry, or why it may not. */
const fileSize = (real: string): Effect.Effect<number, Error> =>
  Effect.gen(function* () {
    const info = yield* statOf(real)
    if (info === undefined) return yield* Effect.fail(new Error('no such file'))
    if (!info.isFile()) return yield* Effect.fail(new Error('the path is not a file'))
    const size = Number(info.size)
    if (size > PREVIEW_LIMIT) return yield* Effect.fail(tooLarge(size))
    return size
  })

/**
 * One file of the workspace, read through the tree's gate: the typed name and
 * the link's target must both land inside the workspace, and only a regular
 * file is shown. The bytes are read, never written, so a preview cannot change
 * what it shows.
 */
export const readWorkspaceFile = (
  cwd: string,
  typed: string,
  convert: OfficeConverter = officeToPdf,
): Effect.Effect<WorkspacePreview, Error> =>
  Effect.gen(function* () {
    const root = (yield* realOf(cwd)) ?? resolve(cwd)
    const real = yield* realInside(root, typed)
    const size = yield* fileSize(real)
    const bytes = yield* bytesOf(real)
    if (bytes.length > PREVIEW_LIMIT) return yield* Effect.fail(tooLarge(bytes.length))
    const path = relative(root, real).split(/[\\/]/u).join('/')
    const extension = extname(real).toLowerCase()
    if (OFFICE_TYPES[extension] !== undefined) {
      return yield* officePreview(path, size, bytes, extension, convert)
    }
    return binaryOf(path, size, bytes, extension) ?? textOf(path, size, bytes, extension)
  })
