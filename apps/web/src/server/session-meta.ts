import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect } from 'effect'
import type { SessionAction, SessionSummary } from '../shared/rpc.ts'
import { WebError } from './errors.ts'

/** What the row menu keeps about one session beyond the log itself. */
export interface SessionMeta {
  readonly title?: string
  readonly pinned?: boolean
  readonly archived?: boolean
}

/** Every session the reader touched, keyed by the id the rail lists. */
export type SessionMetaFile = Readonly<Record<string, SessionMeta>>

/** The one file the web UI keeps beside the logs: names and the two flags. */
export const META_FILE_NAME = '.web-meta.json'

export const metaPathOf = (root: string): string => join(root, META_FILE_NAME)

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

/** How long a row name may be, in code units: the same line the log's title keeps. */
const TITLE_MAX_CHARS = 120

/** One line, trimmed, and no longer than a title should be. */
const shortenTitle = (text: string): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= TITLE_MAX_CHARS ? line : line.slice(0, TITLE_MAX_CHARS - 1) + '…'
}

const isMissing = (cause: unknown): boolean =>
  typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT'

/**
 * A session id names one directory under the log root. The rail only sends ids it
 * read there, but a request is a request: nothing that could climb out is taken.
 */
const checkId = (id: string): Effect.Effect<string, WebError> =>
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && !id.includes('..')
    ? Effect.succeed(id)
    : Effect.fail(new WebError({ message: 'that is not a session id: ' + id }))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const metaOfValue = (value: unknown): SessionMeta | undefined => {
  if (!isRecord(value)) return undefined
  const meta: { title?: string; pinned?: boolean; archived?: boolean } = {}
  if (typeof value.title === 'string' && value.title !== '') meta.title = value.title
  if (typeof value.pinned === 'boolean') meta.pinned = value.pinned
  if (typeof value.archived === 'boolean') meta.archived = value.archived
  return meta
}

/**
 * The metadata the web UI keeps for the sessions in one log root, read whole:
 * the file is small, one entry per session the reader renamed or moved.
 */
export const readMeta = (root: string): Effect.Effect<SessionMetaFile, WebError> =>
  Effect.gen(function* () {
    const path = metaPathOf(root)
    const text = yield* Effect.tryPromise({
      try: async () => {
        try {
          return await readFile(path, 'utf8')
        } catch (cause) {
          if (isMissing(cause)) return ''
          throw cause
        }
      },
      catch: (cause) => new WebError({ message: 'cannot read ' + path + ': ' + messageOf(cause) }),
    })
    if (text.trim() === '') return {}
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return {} // a torn file is no reason to lose the rail; the next write replaces it
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const meta: Record<string, SessionMeta> = {}
    for (const [id, value] of Object.entries(parsed)) {
      const one = metaOfValue(value)
      if (one !== undefined) meta[id] = one
    }
    return meta
  })

const writeMeta = (root: string, meta: SessionMetaFile): Effect.Effect<void, WebError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(root, { recursive: true })
      const path = metaPathOf(root)
      const temporary =
        path + '.' + String(process.pid) + '.' + Math.random().toString(36).slice(2, 8) + '.tmp'
      await writeFile(temporary, JSON.stringify(meta, null, 2) + '\n')
      await rename(temporary, path)
    },
    catch: (cause) =>
      new WebError({ message: 'cannot write the session metadata: ' + messageOf(cause) }),
  })

const patchMeta = (root: string, id: string, patch: SessionMeta): Effect.Effect<void, WebError> =>
  Effect.gen(function* () {
    const meta = yield* readMeta(root)
    yield* writeMeta(root, { ...meta, [id]: { ...meta[id], ...patch } })
  })

const ensureSession = (root: string, id: string): Effect.Effect<void, WebError> =>
  Effect.tryPromise({
    try: () => stat(join(root, id)),
    catch: (cause) =>
      isMissing(cause)
        ? new WebError({ message: 'no such session: ' + id })
        : new WebError({ message: 'cannot look at session ' + id + ': ' + messageOf(cause) }),
  }).pipe(Effect.asVoid)

/** The summary a rail draws: the reader's name when there is one, and the two flags. */
export const withMeta = (
  summary: SessionSummary,
  meta: SessionMeta | undefined,
): SessionSummary => ({
  ...summary,
  title: meta?.title ?? summary.title,
  pinned: meta?.pinned === true,
  archived: meta?.archived === true,
})

/** Every summary in the list, wearing what the reader last said about it. */
export const applyMeta = (
  summaries: ReadonlyArray<SessionSummary>,
  meta: SessionMetaFile,
): ReadonlyArray<SessionSummary> => summaries.map((summary) => withMeta(summary, meta[summary.id]))

/**
 * One row-menu action: the name changes in the metadata, the flags toggle, and a
 * delete removes the log directory the id names along with its entry.
 */
export const sessionActionOf = (
  root: string,
  id: string,
  action: SessionAction,
): Effect.Effect<void, WebError> =>
  Effect.gen(function* () {
    const safe = yield* checkId(id)
    yield* ensureSession(root, safe)
    if (action.kind === 'rename') {
      const title = shortenTitle(action.title)
      if (title === '') {
        return yield* Effect.fail(new WebError({ message: 'a session name cannot be empty' }))
      }
      yield* patchMeta(root, safe, { title })
      return
    }
    if (action.kind === 'pin') {
      yield* patchMeta(root, safe, { pinned: action.pinned })
      return
    }
    if (action.kind === 'archive') {
      yield* patchMeta(root, safe, { archived: action.archived })
      return
    }
    yield* Effect.tryPromise({
      try: () => rm(join(root, safe), { recursive: true, force: false }),
      catch: (cause) =>
        new WebError({ message: 'cannot delete session ' + safe + ': ' + messageOf(cause) }),
    })
    const meta = yield* readMeta(root)
    const { [safe]: _deleted, ...rest } = meta
    yield* writeMeta(root, rest)
  })
