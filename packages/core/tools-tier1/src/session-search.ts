import { Schema, Effect } from 'effect'
import { ToolError, type ToolDefinition } from '@jozo-harness/tools'

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50
/** A hit's text is cut here so one long transcript line cannot flood the context. */
export const SESSION_SEARCH_TEXT_CHARS = 200

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
  /** The workspace the caller is in; only its sessions are this agent's memory. */
  readonly cwd: string
}

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
      const limit = Math.min(Math.max(args.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
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
