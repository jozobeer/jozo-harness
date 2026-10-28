import {
  SessionError,
  decodeSessionEvent,
  type SessionEventSchemaMap,
  type OpenedSession,
  type SessionEvent,
  type SessionHeader,
  type SessionId,
  type SessionPersistence,
  type SessionSink,
  type SessionSummary,
} from '@jozo-harness/session'
import { Effect } from 'effect'
import type { Dirent } from 'node:fs'
import { appendFile, mkdir, open, readdir, readFile, stat as statFile } from 'node:fs/promises'
import { upgradeHeaderLine } from './upgrade.ts'
import { splitTornTail } from './repair.ts'
import { isMissing, notFound, persistenceError } from './errors.ts'
import { readFirstLine, readZstdFirstLine } from './first-line.ts'
import { readTitle, readZstdTitle } from './title.ts'
import { expandHome, newSessionLog, resolveSessionLog, type SessionLogFile } from './paths.ts'
import { encodeZstdFrame, splitZstdLog } from './zstd-frames.ts'
import { replaceFile } from './replace-file.ts'
import { acquireLock } from './lock.ts'
import { PROJECTION_FILE_NAME, readProjection, writeProjection } from './projection.ts'
import { dirname, join } from 'node:path'

export interface JsonlSessionsOptions {
  /** Directory that holds one subdirectory per session. */
  readonly root: string
  /** Event schemas beyond the core catalog, keyed by event type. */
  readonly schemas?: SessionEventSchemaMap
}

const parseLine = (
  id: SessionId,
  lineNumber: number,
  line: string,
): Effect.Effect<unknown, SessionError> =>
  Effect.try({
    try: () => JSON.parse(line) as unknown,
    catch: (cause) => persistenceError(`line ${lineNumber} of session ${id} is not JSON`, cause),
  })

/** What one read of a log gave back: its events, and how far it had to be carried forward. */
interface DecodedLog {
  readonly events: ReadonlyArray<SessionEvent>
  readonly from: number
  readonly changed: boolean
}

const decodeEvents = (
  id: SessionId,
  text: string,
  mtimeMs: number,
  schemas: SessionEventSchemaMap | undefined,
): Effect.Effect<DecodedLog, SessionError> =>
  Effect.gen(function* () {
    const lines = text.split('\n').filter((line) => line.trim() !== '')
    const firstLine = lines[0]
    if (firstLine === undefined) {
      return yield* Effect.fail(persistenceError(`session ${id} is empty`))
    }
    // The header is carried forward before it is decoded: a log written by an older
    // build must open, not read as a stranger.
    const upgraded = upgradeHeaderLine(yield* parseLine(id, 1, firstLine), { mtimeMs })
    if ('message' in upgraded) {
      return yield* Effect.fail(persistenceError(`session ${id}: ${upgraded.message}`))
    }
    const events: Array<SessionEvent> = []
    for (const [index, line] of lines.entries()) {
      const raw = index === 0 ? upgraded.line : yield* parseLine(id, index + 1, line)
      const event = yield* decodeSessionEvent(raw, schemas)
      if (event !== undefined) events.push(event)
    }
    yield* requireHeader(id, events)
    return { events, from: upgraded.from, changed: upgraded.changed }
  })

/** The log must open with a header, whatever generation it was written in. */
const requireHeader = (
  id: SessionId,
  events: ReadonlyArray<SessionEvent>,
): Effect.Effect<void, SessionError> => {
  const first = events[0]
  return first !== undefined && first.type === 'session/header'
    ? Effect.void
    : Effect.fail(persistenceError(`session ${id} does not start with session/header`))
}

/** The header of a log, carried forward to this build's shape. */
const upgradeFirstLine = (
  id: SessionId,
  line: string,
  mtimeMs: number,
  schemas: SessionEventSchemaMap | undefined,
): Effect.Effect<SessionHeader, SessionError> =>
  Effect.gen(function* () {
    const firstLine = line.trim() === '' ? undefined : line
    if (firstLine === undefined)
      return yield* Effect.fail(persistenceError(`session ${id} is empty`))
    const upgraded = upgradeHeaderLine(yield* parseLine(id, 1, firstLine), { mtimeMs })
    if ('message' in upgraded) {
      return yield* Effect.fail(persistenceError(`session ${id}: ${upgraded.message}`))
    }
    const event = yield* decodeSessionEvent(upgraded.line, schemas)
    if (event === undefined || event.type !== 'session/header') {
      return yield* Effect.fail(
        persistenceError(`session ${id} does not start with session/header`),
      )
    }
    return event.data
  })

/** What one read of a log gave back: the text it can serve, and the bytes a crash left. */
interface ReadLog {
  readonly text: string
  readonly tornBytes: number
  /** The complete bytes a repair rewrites; the torn tail is not among them. */
  readonly kept: Uint8Array
}

const readLog = (id: SessionId, file: SessionLogFile): Effect.Effect<ReadLog, SessionError> =>
  Effect.tryPromise({
    try: async () => {
      const buffer = await readFile(file.path)
      if (file.format === 'zstd') {
        const split = splitZstdLog(buffer)
        return {
          text: split.text,
          tornBytes: split.tornBytes,
          kept: Buffer.concat(split.frames),
        }
      }
      const split = splitTornTail(buffer.toString('utf8'))
      return { text: split.keep, tornBytes: split.tornBytes, kept: Buffer.from(split.keep) }
    },
    catch: (cause) =>
      isMissing(cause) ? notFound(id) : persistenceError(`cannot read session ${id}`, cause),
  })

/** The bytes one appended line takes, in the log's own format. */
const lineBytes = (file: SessionLogFile, line: string): Uint8Array =>
  file.format === 'zstd' ? encodeZstdFrame(line) : Buffer.from(line)

const sinkFor = (file: SessionLogFile, id: SessionId, tornPrefix?: Uint8Array): SessionSink => {
  const projectionFile = join(dirname(file.path), PROJECTION_FILE_NAME)
  // Set when a repair could not be written. The next append rewrites this prefix
  // first: appending would glue the new line onto the torn tail, and that line
  // would then end in a newline, so the next open would parse it and refuse the log.
  let pending = tornPrefix
  return {
    append: (event) =>
      Effect.tryPromise({
        try: async () => {
          const line = lineBytes(file, JSON.stringify(event) + '\n')
          const prefix = pending
          if (prefix === undefined) {
            await appendFile(file.path, line)
            return
          }
          await replaceFile(file.path, Buffer.concat([prefix, line]))
          pending = undefined
        },
        catch: (cause) => persistenceError(`cannot append to session ${id}`, cause),
      }),
    // The log is the only memory of a run, so a checkpoint waits for what was
    // appended to reach the device. fsync covers the whole file, not one descriptor,
    // so syncing a fresh append handle flushes the writes `appendFile` already made.
    flush: () =>
      Effect.tryPromise({
        try: async () => {
          // Open for update rather than append: a log that was deleted under the
          // session must fail the checkpoint, not come back as an empty file.
          const handle = await open(file.path, 'r+')
          try {
            await handle.sync()
          } finally {
            await handle.close()
          }
        },
        catch: (cause) => persistenceError('cannot flush session ' + id, cause),
      }),
    loadProjection: () => readProjection(projectionFile, file.path),
    saveProjection: (seq, derived) => writeProjection(projectionFile, file.path, id, seq, derived),
  }
}

/** What a listing reads from a log: the first line, and the bytes its header took. */
interface HeaderRead {
  readonly line: string
  /** Bytes up to and including the header's line; a longer log holds more. */
  readonly bytes: number
}

/**
 * Stores each session as one log under `root/<id>/`. New sessions are
 * `session.v1.jsonl.zst`, one line per zstd frame. A session that still has
 * `session.v1.jsonl` opens and appends as plaintext: switching the format under a
 * session would make an older build append a frame into a plaintext file.
 */
export function jsonlSessions(options: JsonlSessionsOptions): SessionPersistence {
  const root = expandHome(options.root)
  const directoryOf = (id: SessionId): string => join(root, id)

  const logFileOf = (id: SessionId): Effect.Effect<SessionLogFile, SessionError> =>
    Effect.gen(function* () {
      const file = yield* Effect.tryPromise({
        try: () => resolveSessionLog(directoryOf(id)),
        catch: (cause) => persistenceError(`cannot look at session ${id}`, cause),
      })
      if (file === undefined) return yield* Effect.fail(notFound(id))
      return file
    })

  const infoOf = (
    file: SessionLogFile,
    id: SessionId,
  ): Effect.Effect<{ mtimeMs: number; size: number }, SessionError> =>
    Effect.tryPromise({
      try: async () => {
        const info = await statFile(file.path)
        return { mtimeMs: info.mtimeMs, size: info.size }
      },
      catch: (cause) =>
        isMissing(cause) ? notFound(id) : persistenceError(`cannot look at session ${id}`, cause),
    })

  const create = (header: SessionHeader): Effect.Effect<OpenedSession, SessionError> =>
    Effect.gen(function* () {
      const id = crypto.randomUUID()
      const directory = directoryOf(id)
      const file = newSessionLog(directory)
      yield* Effect.tryPromise({
        try: () => mkdir(directory, { recursive: true }),
        catch: (cause) => persistenceError(`cannot create session ${id}`, cause),
      })
      const first: SessionEvent = {
        seq: 1,
        time: header.createdAt,
        type: 'session/header',
        data: header,
      }
      const lock = yield* acquireLock(file.path, id)
      const sink = sinkFor(file, id)
      yield* sink.append(first).pipe(Effect.onError(() => lock.release))
      return { id, events: [first], sink }
    })

  const openRepaired = (
    id: SessionId,
    file: SessionLogFile,
    read: ReadLog,
    events: ReadonlyArray<SessionEvent>,
  ): Effect.Effect<OpenedSession, SessionError> =>
    Effect.gen(function* () {
      const lastSeq = events.reduce((most, event) => Math.max(most, event.seq), 0)
      const note: SessionEvent = {
        seq: lastSeq + 1,
        time: Date.now(),
        type: 'session/repaired',
        data: { tornBytes: read.tornBytes },
      }
      const prefix = Buffer.concat([read.kept, lineBytes(file, JSON.stringify(note) + '\n')])
      const wrote = yield* Effect.tryPromise({
        try: () => replaceFile(file.path, prefix),
        catch: (cause) => persistenceError(`cannot repair session ${id}`, cause),
      }).pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }))
      // The note stays in the session when the disk write fails, so a later line
      // does not reuse its seq. The sink then rewrites the kept prefix: appending
      // onto the torn tail would hide every earlier line from the next open.
      return {
        id,
        events: [...events, note],
        sink: wrote ? sinkFor(file, id) : sinkFor(file, id, prefix),
      }
    })

  /** Reads and decodes a log. The caller holds the write lock unless it only reads. */
  const load = (id: SessionId, file: SessionLogFile): Effect.Effect<OpenedSession, SessionError> =>
    Effect.gen(function* () {
      const { mtimeMs } = yield* infoOf(file, id)
      const read = yield* readLog(id, file)
      if (read.text === '' && read.tornBytes > 0) {
        return yield* Effect.fail(
          persistenceError(`session ${id} was cut off before its header was written`),
        )
      }
      const decoded = yield* decodeEvents(id, read.text, mtimeMs, options.schemas)
      if (read.tornBytes === 0) {
        return { id, events: decoded.events, sink: sinkFor(file, id) }
      }
      return yield* openRepaired(id, file, read, decoded.events)
    })

  const open = (id: SessionId): Effect.Effect<OpenedSession, SessionError> =>
    Effect.gen(function* () {
      const file = yield* logFileOf(id)
      const lock = yield* acquireLock(file.path, id)
      // The lock is held until the process ends; a failed open hands it back so a
      // later attempt is not refused by a session that never started.
      return yield* load(id, file).pipe(Effect.onError(() => lock.release))
    })

  /**
   * Reads a log without taking the write lock. A reader may look at a session
   * another process is writing, so a torn tail is skipped rather than repaired:
   * the repair belongs to the writer that holds the lock.
   */
  const read = (id: SessionId): Effect.Effect<ReadonlyArray<SessionEvent>, SessionError> =>
    Effect.gen(function* () {
      const file = yield* logFileOf(id)
      const { mtimeMs } = yield* infoOf(file, id)
      const log = yield* readLog(id, file)
      return (yield* decodeEvents(id, log.text, mtimeMs, options.schemas)).events
    })

  const readHeader = (file: SessionLogFile): Effect.Effect<HeaderRead, SessionError> =>
    file.format === 'zstd'
      ? readZstdFirstLine(file.path).pipe(
          Effect.map((read) => ({ line: read.line, bytes: read.firstFrameEnd })),
        )
      : readFirstLine(file.path).pipe(
          Effect.map((line) => ({ line, bytes: Buffer.byteLength(line) + 1 })),
        )

  const stat = (id: SessionId): Effect.Effect<SessionSummary, SessionError> =>
    Effect.gen(function* () {
      const file = yield* logFileOf(id)
      const { mtimeMs, size } = yield* infoOf(file, id)
      // Listing reads the head only and never repairs, so a look at the
      // sessions leaves them alone however long the log behind the header is.
      const header = yield* readHeader(file)
      const head = yield* upgradeFirstLine(id, header.line, mtimeMs, options.schemas)
      // The name is read from the head of the same file, under the same budget.
      const title =
        file.format === 'zstd' ? yield* readZstdTitle(file.path) : yield* readTitle(file.path)
      // The header bytes are the whole file exactly when nothing was ever said: a
      // repair note or any event makes the log longer than its first frame.
      const empty = size <= header.bytes
      return {
        id,
        cwd: head.cwd,
        createdAt: head.createdAt,
        updatedAt: mtimeMs,
        title,
        empty,
      }
    })

  const list = (): Effect.Effect<ReadonlyArray<SessionSummary>, SessionError> =>
    Effect.gen(function* () {
      const entries = yield* Effect.tryPromise({
        try: () => readdir(root, { withFileTypes: true }),
        catch: (cause) =>
          isMissing(cause) ? notFound(root) : persistenceError('cannot list sessions', cause),
      }).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            error.code === 'not-found'
              ? Effect.succeed<ReadonlyArray<Dirent>>([])
              : Effect.fail(error),
          onSuccess: (found) => Effect.succeed(found),
        }),
      )
      const summaries: Array<SessionSummary> = []
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const summary = yield* stat(entry.name).pipe(
          Effect.match({ onFailure: () => undefined, onSuccess: (value) => value }),
        )
        if (summary !== undefined) summaries.push(summary)
      }
      return summaries
    })

  return { create, open, read, stat, list }
}
export * from './plugin.ts'
export * from './upgrade.ts'
export * from './repair.ts'
export * from './errors.ts'
export * from './first-line.ts'
export * from './title.ts'
export * from './paths.ts'
export * from './query.ts'
export * from './zstd-frames.ts'
export * from './zstd-log.ts'
export * from './lock.ts'
export * from './projection.ts'
