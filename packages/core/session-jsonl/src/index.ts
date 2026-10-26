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
import { splitTornTail, type SplitLog } from './repair.ts'
import { isMissing, notFound, persistenceError } from './errors.ts'
import { readFirstLine } from './first-line.ts'
import { readTitle } from './title.ts'
import { expandHome, SESSION_FILE_NAME } from './paths.ts'
import { replaceFile } from './replace-file.ts'
import { join } from 'node:path'

export interface JsonlSessionsOptions {
  /** Directory that holds one subdirectory per session. */
  readonly root: string
  /** Event schemas beyond the core catalog, keyed by event type. */
  readonly schemas?: SessionEventSchemaMap
}

const FILE_NAME = SESSION_FILE_NAME

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

const sinkFor = (path: string, id: SessionId, tornPrefix?: string): SessionSink => {
  // Set when a repair could not be written. The next append rewrites this prefix
  // first: appending would glue the new line onto the torn tail, and that line
  // would then end in a newline, so the next open would parse it and refuse the log.
  let pending = tornPrefix
  return {
    append: (event) =>
      Effect.tryPromise({
        try: async () => {
          const line = JSON.stringify(event) + '\n'
          const prefix = pending
          if (prefix === undefined) {
            await appendFile(path, line)
            return
          }
          await replaceFile(path, prefix + line)
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
          const handle = await open(path, 'r+')
          try {
            await handle.sync()
          } finally {
            await handle.close()
          }
        },
        catch: (cause) => persistenceError('cannot flush session ' + id, cause),
      }),
  }
}

/** Stores each session as one JSONL file under `root/<id>/session.v1.jsonl`. */
export function jsonlSessions(options: JsonlSessionsOptions): SessionPersistence {
  const root = expandHome(options.root)
  const directoryOf = (id: SessionId): string => join(root, id)
  const fileOf = (id: SessionId): string => join(directoryOf(id), FILE_NAME)

  const readText = (id: SessionId): Effect.Effect<string, SessionError> =>
    Effect.tryPromise({
      try: () => readFile(fileOf(id), 'utf8'),
      catch: (cause) =>
        isMissing(cause) ? notFound(id) : persistenceError(`cannot read session ${id}`, cause),
    })

  const create = (header: SessionHeader): Effect.Effect<OpenedSession, SessionError> =>
    Effect.gen(function* () {
      const id = crypto.randomUUID()
      yield* Effect.tryPromise({
        try: () => mkdir(directoryOf(id), { recursive: true }),
        catch: (cause) => persistenceError(`cannot create session ${id}`, cause),
      })
      const first: SessionEvent = {
        seq: 1,
        time: header.createdAt,
        type: 'session/header',
        data: header,
      }
      const sink = sinkFor(fileOf(id), id)
      yield* sink.append(first)
      return { id, events: [first], sink }
    })

  /** The file's time and size: what a listing needs to tell an empty log from one with events. */
  const fileInfoOf = (
    id: SessionId,
  ): Effect.Effect<{ mtimeMs: number; size: number }, SessionError> =>
    Effect.tryPromise({
      try: async () => {
        const info = await statFile(fileOf(id))
        return { mtimeMs: info.mtimeMs, size: info.size }
      },
      catch: (cause) =>
        isMissing(cause) ? notFound(id) : persistenceError(`cannot look at session ${id}`, cause),
    })

  const openRepaired = (
    id: SessionId,
    split: SplitLog,
    events: ReadonlyArray<SessionEvent>,
  ): Effect.Effect<OpenedSession, SessionError> =>
    Effect.gen(function* () {
      const lastSeq = events.reduce((most, event) => Math.max(most, event.seq), 0)
      const note: SessionEvent = {
        seq: lastSeq + 1,
        time: Date.now(),
        type: 'session/repaired',
        data: { tornBytes: split.tornBytes },
      }
      const prefix = split.keep + JSON.stringify(note) + '\n'
      const wrote = yield* Effect.tryPromise({
        try: () => replaceFile(fileOf(id), prefix),
        catch: (cause) => persistenceError(`cannot repair session ${id}`, cause),
      }).pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }))
      // The note stays in the session when the disk write fails, so a later line
      // does not reuse its seq. The sink then rewrites the kept prefix: appending
      // onto the torn tail would hide every earlier line from the next open.
      return {
        id,
        events: [...events, note],
        sink: wrote ? sinkFor(fileOf(id), id) : sinkFor(fileOf(id), id, prefix),
      }
    })

  const open = (id: SessionId): Effect.Effect<OpenedSession, SessionError> =>
    Effect.gen(function* () {
      const { mtimeMs } = yield* fileInfoOf(id)
      const split = splitTornTail(yield* readText(id))
      if (split.keep === '' && split.tornBytes > 0) {
        return yield* Effect.fail(
          persistenceError(`session ${id} was cut off before its header was written`),
        )
      }
      const decoded = yield* decodeEvents(id, split.keep, mtimeMs, options.schemas)
      if (split.tornBytes === 0) {
        return { id, events: decoded.events, sink: sinkFor(fileOf(id), id) }
      }
      return yield* openRepaired(id, split, decoded.events)
    })

  const stat = (id: SessionId): Effect.Effect<SessionSummary, SessionError> =>
    Effect.gen(function* () {
      const { mtimeMs, size } = yield* fileInfoOf(id)
      // Listing reads the first line only and never repairs, so a look at the
      // sessions leaves them alone however long the log behind the header is.
      const firstLine = yield* readFirstLine(fileOf(id))
      const header = yield* upgradeFirstLine(id, firstLine, mtimeMs, options.schemas)
      // The name is read from the head of the same file, under the same budget.
      const title = yield* readTitle(fileOf(id))
      // The header line and its newline are the whole file exactly when nothing
      // was ever said: a repair note or any event makes the log longer than that.
      const empty = size <= Buffer.byteLength(firstLine) + 1
      return {
        id,
        cwd: header.cwd,
        createdAt: header.createdAt,
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

  return { create, open, stat, list }
}
export * from './plugin.ts'
export * from './upgrade.ts'
export * from './repair.ts'
export * from './errors.ts'
export * from './first-line.ts'
export * from './title.ts'
export * from './paths.ts'
export * from './query.ts'
