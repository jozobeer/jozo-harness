import { Schema } from 'effect'

/**
 * One file the human attached from the composer. The bytes live in the store
 * under their sha256, so the same content is kept once however often it is
 * attached; the message carries only what a card and a request need.
 */
export interface Attachment {
  /** Lowercase hex sha256 of the bytes; also the file name in the store. */
  readonly hash: string
  readonly mediaType: string
  /** The name the human saw, with any directory part removed. */
  readonly name: string
  readonly bytes: number
}

/** The wire and log shape of one attachment; the transports and the decoder share it. */
export const AttachmentSchema = Schema.Struct({
  hash: Schema.String,
  mediaType: Schema.String,
  name: Schema.String,
  bytes: Schema.Int,
})

/**
 * The formats the composer may attach. An image becomes an image block for the
 * model; a text file becomes its body, or a head and a way to read the rest.
 */
export const ATTACHMENT_LIMITS = {
  maxAttachments: 8,
  maxImageBytes: 10 * 1024 * 1024,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
  /** The head of a text file that travels inline; the rest is left to read. */
  maxTextChars: 32_000,
} as const

/** The image formats both the model routes and the store accept. */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

const TEXT_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'application/toml',
])

/** The media type a file name implies, for a browser that sent no usable type. */
const EXTENSION_MEDIA: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  jsonl: 'application/x-ndjson',
  yml: 'application/yaml',
  yaml: 'application/yaml',
  toml: 'application/toml',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  xml: 'application/xml',
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  jsx: 'text/javascript',
  py: 'text/x-python',
  rs: 'text/rust',
  go: 'text/x-go',
  java: 'text/x-java',
  sh: 'text/x-sh',
  zsh: 'text/x-sh',
  bash: 'text/x-sh',
  sql: 'text/x-sql',
  log: 'text/plain',
  ini: 'text/plain',
  conf: 'text/plain',
  c: 'text/x-c',
  h: 'text/x-c',
  cpp: 'text/x-c++',
  hpp: 'text/x-c++',
}

/** True for the media types the model can receive as text. */
export const isTextMediaType = (mediaType: string): boolean =>
  mediaType.startsWith('text/') || TEXT_MEDIA_TYPES.has(mediaType)

/** True for a media type that travels as an image block. */
export const isImageMediaType = (mediaType: string): boolean =>
  (IMAGE_MEDIA_TYPES as ReadonlyArray<string>).includes(mediaType)

/** True for a type the composer may attach at all. */
export const isSupportedMediaType = (mediaType: string): boolean =>
  isImageMediaType(mediaType) || isTextMediaType(mediaType)

/**
 * The type a browser's File carries, or the one its name implies. A browser
 * often sends an empty type or octet-stream for a source file, so the name is
 * the fallback rather than a refusal.
 */
export const mediaTypeOf = (name: string, declared: string): string => {
  if (isSupportedMediaType(declared)) return declared
  const dot = name.lastIndexOf('.')
  const extension = dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
  return EXTENSION_MEDIA[extension] ?? declared
}

/**
 * The display name of an uploaded file: the last segment, so a name cannot
 * name a directory outside the store. Empty when nothing is left.
 */
export const displayNameOf = (name: string): string => {
  const parts = name.split(/[\\/]/)
  return (parts[parts.length - 1] ?? '').trim()
}

/**
 * Trims the attachments one message may carry to ATTACHMENT_LIMITS. The newest
 * content wins: an attachment past the count or byte budget is dropped rather
 * than accepted empty, and the function is idempotent.
 */
/** The per-file room a type gets: an image usually carries more bytes than a text file. */
const limitOf = (attachment: Attachment): number =>
  isImageAttachment(attachment) ? ATTACHMENT_LIMITS.maxImageBytes : ATTACHMENT_LIMITS.maxFileBytes

/** True when this attachment fits the room left in the message. */
const fits = (attachment: Attachment, used: number): boolean =>
  attachment.bytes <= limitOf(attachment) &&
  used + attachment.bytes <= ATTACHMENT_LIMITS.maxTotalBytes

export function clipAttachments(attachments: ReadonlyArray<Attachment>): ReadonlyArray<Attachment> {
  const kept: Array<Attachment> = []
  let used = 0
  for (const attachment of attachments) {
    if (kept.length >= ATTACHMENT_LIMITS.maxAttachments) break
    if (!fits(attachment, used)) continue
    kept.push(attachment)
    used += attachment.bytes
  }
  return kept
}

/** True when the attachment reaches the model as an image block. */
export const isImageAttachment = (attachment: Attachment): boolean =>
  isImageMediaType(attachment.mediaType)

/** The one-line label a model reads before an attachment's body. */
export const attachmentLabel = (attachment: Attachment): string =>
  'Attachment: ' +
  attachment.name +
  ' (' +
  attachment.mediaType +
  ', ' +
  String(attachment.bytes) +
  ' bytes)'
