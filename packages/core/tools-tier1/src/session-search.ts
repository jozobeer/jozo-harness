import { Context, Effect, Layer, Schema } from 'effect'
import type { Plugin } from '@jozo-harness/kernel'
import type { ContentBlock } from '@jozo-harness/llm'
import type { SessionEvent } from '@jozo-harness/session'
import { ToolError, type ToolDefinition } from '@jozo-harness/tools'

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50
/** A hit's text is cut here so one long transcript line cannot flood the context. */
export const SESSION_SEARCH_TEXT_CHARS = 200

const DEFAULT_TRACE_LIMIT = 20
const MAX_TRACE_LIMIT = 200
/** A trace line carries the start of the text; event_read reads the rest. */
export const SESSION_TRACE_SUMMARY_CHARS = 120

const DEFAULT_CONTEXT = 3
const MAX_CONTEXT = 20

const Parameters = Schema.Struct({
  query: Schema.String.annotate({ description: 'The words to search past sessions for.' }),
  limit: Schema.optionalKey(
    Schema.Int.annotate({ description: 'The most hits to return. Defaults to 10, at most 50.' }),
  ),
})

export type SessionSearchArgs = Schema.Schema.Type<typeof Parameters>

/** One line of a past session's transcript the search matched. */
export interface SessionSearchHit {
  readonly sessionId: string
  readonly seq: number
  readonly type: string
  readonly text: string
}

export interface SessionSearchHost {
  /** Runs one query against the session store. */
  readonly search: (
    text: string,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<SessionSearchHit>, unknown>
  /** The workspace a session belongs to, so hits from elsewhere can be left out. */
  readonly cwdOf: (sessionId: string) => string | undefined
  /** The events one session logged, in seq order. */
  readonly eventsOf: (sessionId: string) => Effect.Effect<ReadonlyArray<SessionEvent>, unknown>
  /** The workspace the caller is in; only its sessions are this agent's memory. */
  readonly cwd: string
}

const TraceParameters = Schema.Struct({
  sessionId: Schema.String.annotate({
    description: 'The session to list events from, as session_search returns it.',
  }),
  limit: Schema.optionalKey(
    Schema.Int.annotate({
      description: 'The most recent events to return. Defaults to 20, at most 200.',
    }),
  ),
})

const ReadParameters = Schema.Struct({
  sessionId: Schema.String.annotate({
    description: 'The session that holds the event, as session_search returns it.',
  }),
  seq: Schema.Int.annotate({ description: 'The seq of the event to read.' }),
  before: Schema.optionalKey(
    Schema.Int.annotate({
      description: 'How many earlier events to include. Defaults to 3, at most 20.',
    }),
  ),
  after: Schema.optionalKey(
    Schema.Int.annotate({
      description: 'How many later events to include. Defaults to 3, at most 20.',
    }),
  ),
})

export type SessionTraceArgs = Schema.Schema.Type<typeof TraceParameters>
export type SessionEventReadArgs = Schema.Schema.Type<typeof ReadParameters>

/** One event as a trace line: where it is, what it is, and what it says in short. */
export interface SessionTraceEntry {
  readonly seq: number
  readonly type: string
  readonly summary: string
}

/** One event with the text it carries, for reading a window around a seq. */
export interface SessionEventReadEntry {
  readonly seq: number
  readonly type: string
  readonly text: string
}

export interface SessionTraceValue {
  readonly sessionId: string
  readonly events: ReadonlyArray<SessionTraceEntry>
}

export interface SessionEventReadValue {
  readonly sessionId: string
  readonly target: SessionEventReadEntry
  readonly before: ReadonlyArray<SessionEventReadEntry>
  readonly after: ReadonlyArray<SessionEventReadEntry>
}

const TraceEntrySchema = Schema.Struct({
  seq: Schema.Int,
  type: Schema.String,
  summary: Schema.String,
})

const ReadEntrySchema = Schema.Struct({
  seq: Schema.Int,
  type: Schema.String,
  text: Schema.String,
})

const textOf = (content: ReadonlyArray<ContentBlock>): string =>
  content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')

const jsonOf = (value: unknown): string => JSON.stringify(value) ?? ''

/**
 * The text one event carries. Messages give their prose; the rest fall back to
 * their data, which keeps a structural event readable without a case per type.
 */
const bodyOf = (event: SessionEvent): string => {
  switch (event.type) {
    case 'session/header':
      return event.data.cwd
    case 'system/message':
    case 'user/message':
    case 'tool/context':
      return event.data.text
    case 'assistant/message':
    case 'tool/result':
      return textOf(event.data.content)
    case 'tool/call':
      return event.data.name + ' ' + event.data.arguments
    case 'turn/end':
      return 'turn ' + String(event.data.turn) + ' ended: ' + event.data.reason.kind
    case 'compaction/checkpoint':
      return event.data.summary
    default:
      return jsonOf(event.data)
  }
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

const traceEntryOf = (event: SessionEvent): SessionTraceEntry => ({
  seq: event.seq,
  type: event.type,
  summary: oneLine(bodyOf(event)).slice(0, SESSION_TRACE_SUMMARY_CHARS),
})

const traceLineOf = (entry: SessionTraceEntry): string =>
  entry.summary === ''
    ? 'seq ' + String(entry.seq) + ' ' + entry.type
    : 'seq ' + String(entry.seq) + ' ' + entry.type + ': ' + entry.summary

const readEntryOf = (event: SessionEvent): SessionEventReadEntry => ({
  seq: event.seq,
  type: event.type,
  text: bodyOf(event),
})

const bounded = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high)

const unknownSession = (sessionId: string): ToolError =>
  new ToolError({
    code: 'invalid-arguments',
    message: 'no session ' + sessionId + ' in this workspace',
  })

/**
 * Reads one session's events only when its header says it ran here. Another
 * workspace's log is never opened, so its contents cannot leak through a read.
 */
const eventsFor = (
  host: SessionSearchHost,
  sessionId: string,
): Effect.Effect<ReadonlyArray<SessionEvent>, ToolError> =>
  host.cwdOf(sessionId) === host.cwd
    ? host.eventsOf(sessionId).pipe(Effect.mapError(() => unknownSession(sessionId)))
    : Effect.fail(unknownSession(sessionId))

/**
 * Searches the transcripts of past sessions. A session's hits are only useful where
 * it ran, so another workspace's transcripts are left out rather than mixed in.
 */
export const makeSessionSearchTool = (
  host: SessionSearchHost,
): ToolDefinition<
  SessionSearchArgs,
  { hits: ReadonlyArray<{ sessionId: string; text: string }> }
> => ({
  name: 'session_search',
  description:
    'Searches the transcripts of earlier sessions in this workspace and returns matching session ids and text. Results from other workspaces are omitted.',
  parameters: Parameters,
  isConcurrencySafe: () => true,
  output: {
    schema: Schema.Struct({
      hits: Schema.Array(Schema.Struct({ sessionId: Schema.String, text: Schema.String })),
    }),
    render: (_args, value) =>
      value.hits.length === 0
        ? [{ type: 'text', text: 'no matching sessions' }]
        : value.hits.map((hit) => ({
            type: 'text' as const,
            text: hit.sessionId + ': ' + hit.text,
          })),
  },
  execute: (args) =>
    Effect.gen(function* () {
      if (args.query.trim() === '') {
        return yield* Effect.fail(
          new ToolError({ code: 'invalid-arguments', message: 'empty query' }),
        )
      }
      const limit = bounded(args.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT)
      const found = yield* host.search(args.query, limit).pipe(
        Effect.mapError(
          (cause) =>
            new ToolError({
              code: 'execution',
              message: 'session search failed: ' + String(cause),
            }),
        ),
      )
      const hits = found
        .filter((hit) => host.cwdOf(hit.sessionId) === host.cwd)
        .slice(0, limit)
        .map((hit) => ({
          sessionId: hit.sessionId,
          text: hit.text.slice(0, SESSION_SEARCH_TEXT_CHARS),
        }))
      return { hits }
    }),
})

/**
 * Shows the newest events of an earlier session as seq, type, and a short summary.
 * The tail is what a reader wants first; event_read opens any line in full.
 */
export const makeSessionTraceTool = (
  host: SessionSearchHost,
): ToolDefinition<SessionTraceArgs, SessionTraceValue> => ({
  name: 'session_trace',
  description:
    'Lists the most recent events of an earlier session in this workspace, with seq, type, and a short summary. Results from other workspaces are omitted.',
  parameters: TraceParameters,
  isConcurrencySafe: () => true,
  output: {
    schema: Schema.Struct({
      sessionId: Schema.String,
      events: Schema.Array(TraceEntrySchema),
    }),
    render: (_args, value) => [
      {
        type: 'text',
        text: ['session ' + value.sessionId, ...value.events.map(traceLineOf)].join('\n'),
      },
    ],
  },
  execute: (args) =>
    Effect.gen(function* () {
      const events = yield* eventsFor(host, args.sessionId)
      const limit = bounded(args.limit ?? DEFAULT_TRACE_LIMIT, 1, MAX_TRACE_LIMIT)
      return { sessionId: args.sessionId, events: events.slice(-limit).map(traceEntryOf) }
    }),
})

const readLines = (entries: ReadonlyArray<SessionEventReadEntry>, mark: string): Array<string> =>
  entries.flatMap((entry) => [
    mark + 'seq ' + String(entry.seq) + ' ' + entry.type,
    ...(entry.text === '' ? [] : entry.text.split('\n').map((line) => mark + '  ' + line)),
  ])

/**
 * Reads one event and its neighbors with their full text. The seq pins the place
 * in the log, and the window keeps a long transcript from arriving at once.
 */
export const makeSessionEventReadTool = (
  host: SessionSearchHost,
): ToolDefinition<SessionEventReadArgs, SessionEventReadValue> => ({
  name: 'session_event_read',
  description:
    'Reads one event of an earlier session in this workspace and its surrounding events with their full text. Results from other workspaces are omitted.',
  parameters: ReadParameters,
  isConcurrencySafe: () => true,
  output: {
    schema: Schema.Struct({
      sessionId: Schema.String,
      target: ReadEntrySchema,
      before: Schema.Array(ReadEntrySchema),
      after: Schema.Array(ReadEntrySchema),
    }),
    render: (_args, value) => [
      {
        type: 'text',
        text: [
          'session ' + value.sessionId,
          ...readLines([value.target], '> '),
          ...(value.before.length === 0 ? [] : ['', 'before:', ...readLines(value.before, '  ')]),
          ...(value.after.length === 0 ? [] : ['', 'after:', ...readLines(value.after, '  ')]),
        ].join('\n'),
      },
    ],
  },
  execute: (args) =>
    Effect.gen(function* () {
      const events = yield* eventsFor(host, args.sessionId)
      const index = events.findIndex((event) => event.seq === args.seq)
      const target = events[index]
      if (target === undefined) {
        return yield* Effect.fail(
          new ToolError({
            code: 'invalid-arguments',
            message: 'no event at seq ' + String(args.seq) + ' in session ' + args.sessionId,
          }),
        )
      }
      const before = bounded(args.before ?? DEFAULT_CONTEXT, 0, MAX_CONTEXT)
      const after = bounded(args.after ?? DEFAULT_CONTEXT, 0, MAX_CONTEXT)
      return {
        sessionId: args.sessionId,
        target: readEntryOf(target),
        before: events.slice(Math.max(index - before, 0), index).map(readEntryOf),
        after: events.slice(index + 1, index + 1 + after).map(readEntryOf),
      }
    }),
})

/** The tools the session-search row hands the model, built over the run's session store. */
export class SessionSearchTools extends Context.Service<
  SessionSearchTools,
  (host: SessionSearchHost) => ReadonlyArray<ToolDefinition<any, any>>
>()('jozo-harness/SessionSearchTools') {}

/** Loader definition for search over past sessions; only a profile naming the row opts in. */
export const sessionSearchPlugin: Plugin<{}, SessionSearchTools, never> = {
  name: '@jozo-harness/session-search',
  config: Schema.Struct({}),
  provides: [SessionSearchTools],
  requires: [],
  layer: () =>
    Layer.succeed(SessionSearchTools, (host) => [
      makeSessionSearchTool(host),
      makeSessionTraceTool(host),
      makeSessionEventReadTool(host),
    ]),
}
