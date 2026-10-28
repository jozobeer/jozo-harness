import { open, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import {
  REFERENCE_LIMITS,
  clipReferences,
  type Reference,
  type SessionEvent,
  type SessionSummary,
} from '@jozo-harness/ui-protocol'
import { Effect } from 'effect'
import { realOf, within } from './inside.ts'

/** Where a reference may read another session: the store's list, and one session's log. */
export interface SessionDigestSource {
  readonly list: () => Effect.Effect<ReadonlyArray<SessionSummary>, unknown>
  readonly events: (id: string) => Effect.Effect<ReadonlyArray<SessionEvent>, unknown>
}

/** The most sessions one reference query offers beside the workspace paths. */
const SESSION_CANDIDATES = 10

/** How many of a session's newest messages a digest without a range keeps. */
const DIGEST_LINES = 40

/** Bytes per character a long file's first characters may need, so the cut lands on one. */
const BYTES_PER_CHAR = 4

/** A range of a session log, as `session:<id>#<from>-<to>` names it. */
interface SessionRange {
  readonly from: number
  readonly to: number
}

/** One session a target names, and the part of its log the human asked for. */
interface SessionTarget {
  readonly id: string
  readonly range?: SessionRange
}

/**
 * The @words a message holds, in typing order and without repeats: an @ opens a
 * reference at the start or after whitespace, so an address in a sentence stays
 * text. The cap is the one the message budget states, not a second one.
 */
export const referenceTargetsOf = (text: string): ReadonlyArray<string> => {
  const seen = new Set<string>()
  const targets: Array<string> = []
  for (const match of text.matchAll(/(?:^|\s)@(\S+)/gu)) {
    const target = match[1]
    if (target === undefined || seen.has(target)) continue
    seen.add(target)
    targets.push(target)
    if (targets.length >= REFERENCE_LIMITS.maxReferences) break
  }
  return targets
}

/** What stat says about something that must exist, or undefined when it does not. */
const statOf = (path: string): Effect.Effect<Awaited<ReturnType<typeof stat>> | undefined> =>
  Effect.tryPromise({
    try: () => stat(path),
    catch: () => undefined,
  }).pipe(Effect.orElseSucceed(() => undefined))

/** A note in place of a body, so the model learns the human pointed at something it cannot see. */
const noteReference = (path: string, note: string): Reference => ({
  kind: 'file',
  path,
  text: note,
})

/** The first `bytes` of a file, decoded, without reading the rest of a huge one. */
const readHead = (path: string, bytes: number): Effect.Effect<string, Error> =>
  Effect.tryPromise({
    try: async () => {
      const handle = await open(path, 'r')
      try {
        const buffer = Buffer.alloc(bytes)
        const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
        return buffer.subarray(0, bytesRead).toString('utf8')
      } finally {
        await handle.close()
      }
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  })

/** One file reference, cut to the budget with the size it held before the cut kept. */
const fileReferenceOf = (path: string, body: string, size: number): Reference => {
  if (body.length <= REFERENCE_LIMITS.maxFileChars) return { kind: 'file', path, text: body }
  return {
    kind: 'file',
    path,
    text: body.slice(0, REFERENCE_LIMITS.maxFileChars) + '…',
    cut: Math.max(size, body.length),
  }
}

/** Where a typed path lands: a readable file, a note worth writing, or a refusal. */
type FileTarget =
  | { readonly kind: 'outside' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'other' }
  | { readonly kind: 'file'; readonly real: string; readonly size: number }

/**
 * Where one typed path lands inside the workspace. Both the typed name and the
 * symlink target must resolve inside the tree: a link is a way out whatever the
 * word looks like, so the check reads the real path.
 */
const locateFile = (root: string, typed: string): Effect.Effect<FileTarget> =>
  Effect.gen(function* () {
    const target = resolve(root, typed)
    if (!within(root, target)) return { kind: 'outside' }
    const resolved = yield* realOf(target)
    if (resolved === undefined) return { kind: 'missing' }
    if (!within(root, resolved)) return { kind: 'outside' }
    const info = yield* statOf(resolved)
    if (info === undefined || !info.isFile()) return { kind: 'other' }
    return { kind: 'file', real: resolved, size: Number(info.size) }
  })

/** The body of a file the workspace may read, or the note that says why it is not there. */
const bodyOrNote = (real: string, typed: string, size: number): Effect.Effect<Reference> =>
  Effect.gen(function* () {
    const bytes = Math.min(size, (REFERENCE_LIMITS.maxFileChars + 1) * BYTES_PER_CHAR)
    const body = yield* readHead(real, bytes).pipe(Effect.orElseSucceed(() => undefined))
    if (body === undefined) return noteReference(typed, 'the file could not be read')
    if (body.includes('\u0000'))
      return noteReference(typed, 'the file is binary, so its body is not attached')
    return fileReferenceOf(typed, body, size)
  })

/**
 * One @path resolved inside the workspace. A path that leaves the tree by `..`, by
 * an absolute name, or by a symlink's target is refused, not read; one that cannot
 * be read or is too large arrives as a note that says so.
 */
export const readFileReference = (
  cwd: string,
  typed: string,
): Effect.Effect<Reference | undefined> =>
  Effect.gen(function* () {
    if (typed === '' || isAbsolute(typed)) return undefined
    const root = yield* realOf(cwd)
    if (root === undefined) return undefined
    const found = yield* locateFile(root, typed)
    switch (found.kind) {
      case 'outside':
        return undefined
      case 'missing':
        return noteReference(typed, 'the file could not be read: it is missing')
      case 'other':
        return noteReference(typed, 'the file could not be read')
      case 'file':
        return yield* bodyOrNote(found.real, typed, found.size)
    }
  })

/** One line a digest may quote: what the human typed, or what the model answered. */
const digestLineOf = (event: SessionEvent): string | undefined => {
  if (event.type === 'user/message') {
    return event.data.source === 'user' ? 'human: ' + event.data.text : undefined
  }
  if (event.type !== 'assistant/message') return undefined
  const text = event.data.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('')
  return text.trim() === '' ? undefined : 'assistant: ' + text
}

/** True when an event falls in the range the human named; everything does without one. */
const inRange = (event: SessionEvent, range: SessionRange | undefined): boolean =>
  range === undefined || (event.seq >= range.from && event.seq <= range.to)

/** The part of a session log a reference carries: the named range, or the newest messages. */
const digestOf = (
  summary: SessionSummary,
  events: ReadonlyArray<SessionEvent>,
  range: SessionRange | undefined,
): string => {
  const lines = events
    .filter((event) => inRange(event, range))
    .flatMap((event) => {
      const line = digestLineOf(event)
      return line === undefined ? [] : ['#' + event.seq + ' ' + line]
    })
  const kept = range === undefined ? lines.slice(-DIGEST_LINES) : lines
  const head = 'Session ' + summary.id + (summary.title === '' ? '' : ' (' + summary.title + ')')
  return [head, ...kept].join('\n\n')
}

/**
 * The session one target names: `session:<id>`, or `session:<id>#<from>-<to>` for
 * one range of its log. A target that names no id is not a session at all.
 */
export const sessionTargetOf = (target: string): SessionTarget | undefined => {
  if (!target.startsWith('session:')) return undefined
  const [id, range] = target.slice('session:'.length).split('#', 2)
  if (id === undefined || id === '') return undefined
  if (range === undefined) return { id }
  const [fromText, toText] = range.split('-', 2)
  const from = Number(fromText)
  const to = Number(toText)
  if (!Number.isInteger(from) || !Number.isInteger(to)) return { id }
  return { id, range: { from, to } }
}

/**
 * Whether a session's workspace is this one: a log from another tree is another
 * device's work, and its body is neither offered nor attached.
 */
const sharesWorkspace = (cwd: string, sessionCwd: string): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const root = (yield* realOf(cwd)) ?? resolve(cwd)
    const other = (yield* realOf(sessionCwd)) ?? resolve(sessionCwd)
    return within(root, other)
  })

/** One @session resolved to the part of its log the human named, or refused. */
export const readSessionReference = (
  cwd: string,
  target: SessionTarget,
  source: SessionDigestSource,
): Effect.Effect<Reference | undefined> =>
  Effect.gen(function* () {
    const summaries = yield* source
      .list()
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<SessionSummary>))
    const summary = summaries.find((one) => one.id === target.id)
    if (summary === undefined) return undefined
    if (!(yield* sharesWorkspace(cwd, summary.cwd))) return undefined
    const events = yield* source
      .events(summary.id)
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<SessionEvent>))
    return { kind: 'session', sessionId: summary.id, text: digestOf(summary, events, target.range) }
  })

/**
 * Everything one message attaches: the @paths in its text and the @sessions it
 * names, read inside the workspace and cut to the message budget. A reference
 * that cannot be read or lies outside the tree contributes nothing.
 */
export const resolveReferences = (
  cwd: string,
  text: string,
  source: SessionDigestSource,
): Effect.Effect<ReadonlyArray<Reference>> =>
  Effect.forEach(
    referenceTargetsOf(text),
    (target) => {
      const session = sessionTargetOf(target)
      return session === undefined
        ? readFileReference(cwd, target)
        : readSessionReference(cwd, session, source)
    },
    { concurrency: 1 },
  ).pipe(
    Effect.map((found) =>
      clipReferences(found.filter((one): one is Reference => one !== undefined)),
    ),
  )

/**
 * The other sessions a page may offer under an @word: the store's sessions whose
 * workspace is this one, matched by id or title. A session from another workspace
 * is not a candidate, so it cannot be attached either.
 */
export const sessionCandidateTargets = (
  cwd: string,
  query: string,
  source: SessionDigestSource,
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function* () {
    const typed = query.trim().toLowerCase()
    // `@session:` is the word that asks for sessions, so the prefix itself is not
    // matched against ids and titles; what follows it narrows them.
    const word = typed.startsWith('session:') ? typed.slice('session:'.length) : typed
    if (typed === '') return []
    const summaries = yield* source
      .list()
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<SessionSummary>))
    const marked = yield* Effect.forEach(
      summaries,
      (summary) =>
        sharesWorkspace(cwd, summary.cwd).pipe(Effect.map((readable) => ({ summary, readable }))),
      { concurrency: 1 },
    )
    return marked
      .filter(
        (one) =>
          one.readable &&
          (word === '' ||
            one.summary.id.toLowerCase().includes(word) ||
            one.summary.title.toLowerCase().includes(word)),
      )
      .map((one) => one.summary)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, SESSION_CANDIDATES)
      .map((one) => 'session:' + one.id)
  })
