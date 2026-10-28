import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { renderTranscriptMarkdown } from '@jozo-harness/session'
import type { SessionError, SessionEvent } from '@jozo-harness/ui-protocol'
import { Effect, Exit } from 'effect'
import { refusedBy, type CodeExchange, type PublicOrigin } from './auth.ts'
import type { TailnetAddresses } from './tailnet.ts'

/** A session id the route may hand to the filesystem. */
const safeSegment = (value: string): boolean =>
  /^[A-Za-z0-9._-]+$/.test(value) && !value.includes('..')

/** What one request under `/session/` names: a whole log, or its transcript. */
type ExportRoute =
  | { readonly kind: 'other' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'zip'; readonly sessionId: string }
  | { readonly kind: 'markdown'; readonly sessionId: string }

const routeOf = (path: string): ExportRoute => {
  if (!path.startsWith('/session/')) return { kind: 'other' }
  const [sessionId, file, ...extra] = path.slice('/session/'.length).split('/')
  if (
    sessionId === undefined ||
    file === undefined ||
    extra.length !== 0 ||
    !safeSegment(sessionId)
  ) {
    return { kind: 'invalid' }
  }
  if (file === 'log.zip') return { kind: 'zip', sessionId }
  if (file === 'transcript.md') return { kind: 'markdown', sessionId }
  return { kind: 'invalid' }
}

/** The sessions root, and the log read the transcript route folds. */
export interface SessionExportGate {
  /** Absent when the run could not read where its sessions live. */
  readonly root: string | undefined
  readonly events: (id: string) => Effect.Effect<ReadonlyArray<SessionEvent>, SessionError>
  readonly port: number
  readonly publicOrigin: PublicOrigin | undefined
  readonly tailnet: TailnetAddresses | undefined
  readonly token: string
  readonly codes: CodeExchange
}

const refuse = (response: ServerResponse, status: number, body: string): void => {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  response.end(body)
}

/**
 * True when the export shares the artifact route's gate: same host, same page
 * origin, and the cookie, token, or code the run issued.
 */
const admitted = (
  request: IncomingMessage,
  response: ServerResponse,
  gate: SessionExportGate,
): boolean => {
  if (request.method !== 'GET') {
    refuse(response, 405, 'method not allowed')
    return false
  }
  const refusal = refusedBy(request, gate)
  if (refusal === undefined) return true
  refuse(response, refusal.status, refusal.message)
  return false
}

/** The table every byte of a log is folded through, built once for the process. */
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

/** The ZIP CRC-32 of one file's bytes, as the central directory records it. */
const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** One file as the archive carries it: the path a reader extracts, and its bytes. */
interface ZipEntry {
  readonly name: string
  readonly data: Uint8Array
}

/** The local header and the name of one deflated entry, which precede its body. */
const localHeader = (name: Buffer, data: Uint8Array, deflated: Buffer, crc: number): Buffer => {
  const header = Buffer.alloc(30 + name.length)
  header.writeUInt32LE(0x04034b50, 0)
  header.writeUInt16LE(20, 4)
  // Bit 11 says the name is UTF-8; every other flag stays clear.
  header.writeUInt16LE(0x0800, 6)
  header.writeUInt16LE(8, 8)
  header.writeUInt32LE(crc, 14)
  header.writeUInt32LE(deflated.length, 18)
  header.writeUInt32LE(data.length, 22)
  header.writeUInt16LE(name.length, 26)
  name.copy(header, 30)
  return header
}

/** The directory entry pointing back at one local header. */
const centralHeader = (
  name: Buffer,
  data: Uint8Array,
  deflated: Buffer,
  crc: number,
  offset: number,
): Buffer => {
  const header = Buffer.alloc(46 + name.length)
  header.writeUInt32LE(0x02014b50, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(20, 6)
  header.writeUInt16LE(0x0800, 8)
  header.writeUInt16LE(8, 10)
  header.writeUInt32LE(crc, 16)
  header.writeUInt32LE(deflated.length, 20)
  header.writeUInt32LE(data.length, 24)
  header.writeUInt16LE(name.length, 28)
  header.writeUInt32LE(offset, 42)
  name.copy(header, 46)
  return header
}

/** The end of the central directory, which names where it starts and how long it is. */
const directoryEnd = (size: number, offset: number, entries: number): Buffer => {
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries, 8)
  end.writeUInt16LE(entries, 10)
  end.writeUInt32LE(size, 12)
  end.writeUInt32LE(offset, 16)
  return end
}

/**
 * A ZIP holding the entries as they are. The store writes deflate frames, so the
 * archive re-deflates nothing: the bytes a jzh reads are the bytes it wrote, and
 * no dependency is needed for the container the browser saves.
 */
const zipOf = (entries: ReadonlyArray<ZipEntry>): Buffer => {
  const locals: Array<Buffer> = []
  const centrals: Array<Buffer> = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const deflated = deflateRawSync(entry.data)
    const crc = crc32(entry.data)
    const local = localHeader(name, entry.data, deflated, crc)
    centrals.push(centralHeader(name, entry.data, deflated, crc, offset))
    locals.push(local, deflated)
    offset += local.length + deflated.length
  }
  const directory = Buffer.concat(centrals)
  return Buffer.concat([
    ...locals,
    directory,
    directoryEnd(directory.length, offset, entries.length),
  ])
}

/** The plaintext log older sessions keep; a new session writes the zstd one. */
const PLAIN_LOG = 'session.v1.jsonl'
const ZSTD_LOG = 'session.v1.jsonl.zst'

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  )

/** The log a directory holds; a plaintext log wins, as it does for the store. */
const logPathOf = async (directory: string): Promise<string | undefined> => {
  const plain = join(directory, PLAIN_LOG)
  if (await exists(plain)) return plain
  const compressed = join(directory, ZSTD_LOG)
  return (await exists(compressed)) ? compressed : undefined
}

/** One session's log, under the id that names its directory so it extracts in place. */
const logEntryOf = async (root: string, sessionId: string): Promise<ZipEntry | undefined> => {
  const path = await logPathOf(join(root, sessionId)).catch(() => undefined)
  if (path === undefined) return undefined
  const data = await readFile(path).catch(() => undefined)
  return data === undefined ? undefined : { name: sessionId + '/' + basename(path), data }
}

const answerZip = async (
  response: ServerResponse,
  root: string | undefined,
  sessionId: string,
): Promise<void> => {
  const entry = root === undefined ? undefined : await logEntryOf(root, sessionId)
  if (entry === undefined) {
    refuse(response, 404, 'not found')
    return
  }
  const body = zipOf([entry])
  response.writeHead(200, {
    'content-type': 'application/zip',
    'content-disposition': 'attachment; filename="' + sessionId + '.zip"',
    'cache-control': 'no-store',
  })
  response.end(body)
}

/**
 * The session's transcript as Markdown. It folds the log it already has; opening
 * the store to read is not opening a session, so no turn starts behind the page.
 */
const answerTranscript = async (
  response: ServerResponse,
  gate: SessionExportGate,
  sessionId: string,
): Promise<void> => {
  const read = await Effect.runPromiseExit(gate.events(sessionId))
  if (Exit.isFailure(read)) {
    refuse(response, 404, 'not found')
    return
  }
  response.writeHead(200, {
    'content-type': 'text/markdown; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end('# Session ' + sessionId + '\n\n' + renderTranscriptMarkdown(read.value))
}

/**
 * Answers the two session exports and reports whether it did. Both are reads:
 * the log route copies the file the store wrote, and the transcript route folds
 * the same events a browse reads, so neither starts a model turn.
 */
export const answerSessionExport = async (
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  gate: SessionExportGate,
): Promise<boolean> => {
  const route = routeOf(path)
  if (route.kind === 'other') return false
  if (route.kind === 'invalid') {
    refuse(response, 400, 'invalid session export path')
    return true
  }
  if (!admitted(request, response, gate)) return true
  if (route.kind === 'zip') await answerZip(response, gate.root, route.sessionId)
  else await answerTranscript(response, gate, route.sessionId)
  return true
}
