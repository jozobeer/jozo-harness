import {
  type SessionError,
  type SessionEvent,
  type SessionEventSchemaMap,
  type SessionHeader,
  type SessionId,
  type SessionPersistence,
} from '@jozo-harness/session'
import { DatabaseSync } from 'node:sqlite'
import { Effect } from 'effect'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isMissing, notFound, persistenceError } from './errors.ts'
import { expandHome, resolveSessionLog, type SessionLogFile } from './paths.ts'
import { readZstdText } from './zstd-log.ts'

/** How many hits one search returns unless the caller says otherwise. */
export const SEARCH_LIMIT = 20
/** The name of the full-text index the root keeps, beside the session directories. */
export const INDEX_FILE_NAME = 'index.v1.sqlite'

/** What one read of a log saw on disk; the observation is reused while it holds. */
export interface SessionRevision {
  readonly mtimeMs: number
  readonly size: number
}

/** One immutable cut of a session log, leased to every reader that holds it. */
export interface SessionObservation {
  readonly id: SessionId
  readonly header: SessionHeader
  readonly events: ReadonlyArray<SessionEvent>
  readonly revision: SessionRevision
  /** Hands the same cut to another reader. The caller disposes of its own lease. */
  retain(): SessionObservation
  /** Drops this reader's lease; the cut stays while another lease holds it. */
  dispose(): void
}

/** One indexed event that matched a search. */
export interface SearchHit {
  readonly sessionId: SessionId
  readonly seq: number
  readonly type: string
  /** The matching text, with the match marked by «». */
  readonly text: string
}

/** What one refresh of the index did. */
export interface IndexReport {
  readonly indexed: ReadonlyArray<SessionId>
  readonly removed: ReadonlyArray<SessionId>
  /** Sessions whose file had not changed since the last refresh. */
  readonly skipped: number
}

export interface SessionQueryOptions {
  readonly root: string
  /** Where logs are read from; the index reads the same files the store serves. */
  readonly sessions: SessionPersistence
  readonly schemas?: SessionEventSchemaMap
  /** The index file. Defaults to `<root>/index.v1.sqlite`. */
  readonly indexPath?: string
  /** How many hits a search returns unless the caller passes a limit. */
  readonly limit?: number
}

export interface SessionQuery {
  /** The immutable cut of one session, reused while its file does not change. */
  observe(id: SessionId): Effect.Effect<SessionObservation, SessionError>
  /** Brings the full-text index up to date with the files on disk. */
  sync(): Effect.Effect<IndexReport, SessionError>
  /** Indexes first, then answers from the index rather than from the logs. */
  search(text: string, limit?: number): Effect.Effect<ReadonlyArray<SearchHit>, SessionError>
  close(): void
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const stringOf = (value: unknown): string => (typeof value === 'string' ? value : '')

const blockText = (value: unknown): string => {
  if (!Array.isArray(value)) return ''
  return value
    .flatMap((block) => {
      const record = asRecord(block)
      return record?.['type'] === 'text' ? [stringOf(record['text'])] : []
    })
    .join('\n')
}

/** What one logged event contributes to the search index. */
const searchableText = (type: string, data: Record<string, unknown>): string => {
  if (type === 'system/message' || type === 'user/message') return stringOf(data['text'])
  if (type === 'assistant/message' || type === 'tool/result') return blockText(data['content'])
  if (type === 'tool/call') return stringOf(data['name']) + ' ' + stringOf(data['arguments'])
  return ''
}

interface IndexRow {
  readonly seq: number
  readonly type: string
  readonly text: string
}

/**
 * One log line as an index row, or nothing when it is not an event or carries
 * no text. Reading the raw line keeps indexing independent of the event schemas:
 * a line a build cannot decode still searches, and a torn tail is skipped.
 */
const indexRowOf = (line: string): IndexRow | undefined => {
  if (line.trim() === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(line) as unknown
  } catch {
    return undefined
  }
  const event = asRecord(parsed)
  const data = asRecord(event?.['data'])
  const type = event?.['type']
  const seq = event?.['seq']
  if (data === undefined || typeof type !== 'string' || typeof seq !== 'number') return undefined
  const text = searchableText(type, data)
  return text === '' ? undefined : { seq, type, text }
}

/** Runs `work` in one transaction, rolling back when it throws. */
const transaction = (database: DatabaseSync, work: () => void): void => {
  database.exec('BEGIN')
  try {
    work()
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS file_revisions (session_id TEXT PRIMARY KEY, mtime_ms REAL NOT NULL, size INTEGER NOT NULL)',
  "CREATE VIRTUAL TABLE IF NOT EXISTS event_text USING fts5(session_id UNINDEXED, seq UNINDEXED, type UNINDEXED, text, tokenize = 'unicode61')",
].join('; ')

/** The hits one phrase query returns; a phrase no tokenizer can read finds nothing. */
const SEARCH_SQL =
  'SELECT session_id, seq, type, snippet(event_text, 3, char(171), char(187), char(8230), 12) AS text ' +
  'FROM event_text WHERE event_text MATCH ? ORDER BY rank LIMIT ?'

const hitOf = (row: unknown): SearchHit | undefined => {
  const record = asRecord(row)
  const sessionId = record?.['session_id']
  const seq = record?.['seq']
  const type = record?.['type']
  const text = record?.['text']
  if (
    typeof sessionId !== 'string' ||
    typeof seq !== 'number' ||
    typeof type !== 'string' ||
    typeof text !== 'string'
  ) {
    return undefined
  }
  return { sessionId, seq, type, text }
}

/** The phrase a search runs: the caller's words as one literal phrase. */
const phraseOf = (text: string): string => '"' + text.replace(/"/g, '""') + '"'

/** The cut a lease hands out, before the lease methods are attached. */
interface ObservedCut {
  readonly id: SessionId
  readonly header: SessionHeader
  readonly events: ReadonlyArray<SessionEvent>
  readonly revision: SessionRevision
}

interface CacheEntry {
  readonly cut: ObservedCut
  refs: number
}

/**
 * The read side of the JSONL store: immutable cuts of a session log, leased to
 * every reader that retains them, and a full-text index that answers searches
 * without reading the logs again.
 */
export function makeSessionQuery(options: SessionQueryOptions): SessionQuery {
  const root = expandHome(options.root)
  const logFileOf = (id: SessionId): Effect.Effect<SessionLogFile, SessionError> =>
    Effect.gen(function* () {
      const file = yield* Effect.tryPromise({
        try: () => resolveSessionLog(join(root, id)),
        catch: (cause) => persistenceError(`cannot look at session ${id}`, cause),
      })
      if (file === undefined) return yield* Effect.fail(notFound(id))
      return file
    })
  // The index opens on the first search or sync: reading a session never
  // creates the file, and a run that only browses leaves the root as it was.
  let database: DatabaseSync | undefined
  const db = (): DatabaseSync => {
    if (database === undefined) {
      database = new DatabaseSync(options.indexPath ?? join(root, INDEX_FILE_NAME))
      database.exec(SCHEMA)
    }
    return database
  }
  const cached = new Map<SessionId, CacheEntry>()

  const revisionOf = (id: SessionId): Effect.Effect<SessionRevision, SessionError> =>
    Effect.gen(function* () {
      const file = yield* logFileOf(id)
      return yield* Effect.tryPromise({
        try: async () => {
          const info = await stat(file.path)
          return { mtimeMs: info.mtimeMs, size: info.size }
        },
        catch: (cause) =>
          isMissing(cause) ? notFound(id) : persistenceError(`cannot look at session ${id}`, cause),
      })
    })

  const leaseOf = (entry: CacheEntry): SessionObservation => ({
    ...entry.cut,
    retain: () => {
      entry.refs += 1
      return leaseOf(entry)
    },
    dispose: () => {
      entry.refs -= 1
      if (entry.refs <= 0 && cached.get(entry.cut.id) === entry) {
        cached.delete(entry.cut.id)
      }
    },
  })

  const observe = (id: SessionId): Effect.Effect<SessionObservation, SessionError> =>
    Effect.gen(function* () {
      const revision = yield* revisionOf(id)
      const known = cached.get(id)
      if (
        known !== undefined &&
        known.cut.revision.mtimeMs === revision.mtimeMs &&
        known.cut.revision.size === revision.size
      ) {
        known.refs += 1
        return leaseOf(known)
      }
      const events =
        options.sessions.read === undefined
          ? (yield* options.sessions.open(id)).events
          : yield* options.sessions.read(id)
      const header = events[0]
      if (header === undefined || header.type !== 'session/header') {
        return yield* Effect.fail(
          persistenceError(`session ${id} does not start with session/header`),
        )
      }
      const entry: CacheEntry = {
        cut: { id, header: header.data, events, revision },
        refs: 1,
      }
      cached.set(id, entry)
      return leaseOf(entry)
    })

  const writeIndex = (
    id: SessionId,
    rows: ReadonlyArray<IndexRow>,
    revision: SessionRevision,
  ): void => {
    const store = db()
    transaction(store, () => {
      store.prepare('DELETE FROM event_text WHERE session_id = ?').run(id)
      const insert = store.prepare(
        'INSERT INTO event_text (session_id, seq, type, text) VALUES (?, ?, ?, ?)',
      )
      for (const row of rows) insert.run(id, row.seq, row.type, row.text)
      store
        .prepare(
          'INSERT INTO file_revisions (session_id, mtime_ms, size) VALUES (?, ?, ?) ' +
            'ON CONFLICT(session_id) DO UPDATE SET mtime_ms = excluded.mtime_ms, size = excluded.size',
        )
        .run(id, revision.mtimeMs, revision.size)
    })
  }

  const readIndexRows = (id: SessionId): Effect.Effect<ReadonlyArray<IndexRow>, SessionError> =>
    Effect.gen(function* () {
      const file = yield* logFileOf(id)
      const text = yield* Effect.tryPromise({
        try: () => (file.format === 'zstd' ? readZstdText(file.path) : readFile(file.path, 'utf8')),
        catch: (cause) => persistenceError(`cannot read session ${id}`, cause),
      })
      return text.split('\n').flatMap((line) => {
        const row = indexRowOf(line)
        return row === undefined ? [] : [row]
      })
    })

  const knownRevision = (id: SessionId): SessionRevision | undefined => {
    const row = asRecord(
      db().prepare('SELECT mtime_ms, size FROM file_revisions WHERE session_id = ?').get(id),
    )
    const mtimeMs = row?.['mtime_ms']
    const size = row?.['size']
    return typeof mtimeMs === 'number' && typeof size === 'number' ? { mtimeMs, size } : undefined
  }

  const unchanged = (id: SessionId, revision: SessionRevision): boolean => {
    const known = knownRevision(id)
    return known !== undefined && known.mtimeMs === revision.mtimeMs && known.size === revision.size
  }

  const sync = (): Effect.Effect<IndexReport, SessionError> =>
    Effect.gen(function* () {
      const summaries = yield* options.sessions.list()
      const indexed: Array<SessionId> = []
      let skipped = 0
      for (const summary of summaries) {
        const revision = yield* revisionOf(summary.id)
        if (unchanged(summary.id, revision)) {
          skipped += 1
          continue
        }
        writeIndex(summary.id, yield* readIndexRows(summary.id), revision)
        indexed.push(summary.id)
      }
      const present = new Set(summaries.map((summary) => summary.id))
      const store = db()
      const stored = store
        .prepare('SELECT session_id FROM file_revisions')
        .all()
        .flatMap((row) => {
          const id = asRecord(row)?.['session_id']
          return typeof id === 'string' ? [id] : []
        })
      const removed = stored.filter((id) => !present.has(id))
      for (const id of removed) {
        store.prepare('DELETE FROM event_text WHERE session_id = ?').run(id)
        store.prepare('DELETE FROM file_revisions WHERE session_id = ?').run(id)
      }
      return { indexed, removed, skipped }
    })

  const search = (
    text: string,
    limit?: number,
  ): Effect.Effect<ReadonlyArray<SearchHit>, SessionError> =>
    Effect.gen(function* () {
      if (text.trim() === '') return []
      yield* sync()
      const rows = yield* Effect.try({
        try: () =>
          db()
            .prepare(SEARCH_SQL)
            .all(phraseOf(text), limit ?? options.limit ?? SEARCH_LIMIT),
        catch: (cause) => persistenceError('cannot search the session index', cause),
      }).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<unknown>))
      return rows.flatMap((row) => {
        const hit = hitOf(row)
        return hit === undefined ? [] : [hit]
      })
    })

  return { observe, sync, search, close: () => database?.close() }
}
