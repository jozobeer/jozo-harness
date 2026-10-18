import {
  AssistantStreamRecordSchema,
  ContentBlockSchema,
  LLM_FAILURE_CODES,
  LlmFailureSchema,
  LlmUsageSchema,
} from '@jozo-harness/llm'
import { Schema } from 'effect'
import { USER_MESSAGE_SOURCES, type TurnEndReason } from './events.ts'
import { registerLogOnlySessionEvents } from './projections.ts'

/** Event schemas a decoder accepts, keyed by event type. Plugins add their own. */
export type SessionEventSchemaMap = ReadonlyMap<string, Schema.Schema<unknown>>

const TurnEndReasonSchema: Schema.Schema<TurnEndReason> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('completed') }),
  Schema.Struct({
    kind: Schema.Literal('cancelled'),
    cause: Schema.Literals(['user', 'shutdown', 'parent-cancelled']),
  }),
  Schema.Struct({ kind: Schema.Literal('error'), failure: LlmFailureSchema }),
])

/**
 * Runtime schemas for the core events. This is a map, not an exhaustive record:
 * packages add event types to `SessionEventMap` by declaration merging and
 * supply their matching schemas where they construct a decoder.
 */
const catalog = new Map<string, Schema.Schema<unknown>>([
  [
    'session/header',
    Schema.Struct({ formatVersion: Schema.Int, createdAt: Schema.Number, cwd: Schema.String }),
  ],
  ['session/cwd/changed', Schema.Struct({ cwd: Schema.String }) as Schema.Schema<unknown>],
  ['session/repaired', Schema.Struct({ tornBytes: Schema.Int }) as Schema.Schema<unknown>],
  [
    'compaction/prune',
    Schema.Struct({
      shadowedSeqs: Schema.Array(Schema.Int),
      shadowedRange: Schema.Struct({ start: Schema.Int, end: Schema.Int }),
      shadowedBytes: Schema.Int,
      replacements: Schema.Array(
        Schema.Struct({ seq: Schema.Int, content: Schema.Array(ContentBlockSchema) }),
      ),
    }) as Schema.Schema<unknown>,
  ],
  [
    'compaction/checkpoint',
    Schema.Struct({
      shadowedSeqs: Schema.Array(Schema.Int),
      shadowedRange: Schema.Struct({ start: Schema.Int, end: Schema.Int }),
      summary: Schema.String,
      provider: Schema.String,
      model: Schema.String,
    }) as Schema.Schema<unknown>,
  ],
  ['turn/start', Schema.Struct({ turn: Schema.Int })],
  ['turn/end', Schema.Struct({ turn: Schema.Int, reason: TurnEndReasonSchema })],
  ['step/start', Schema.Struct({ step: Schema.Int })],
  ['step/end', Schema.Struct({ step: Schema.Int })],
  [
    'request/header',
    Schema.Struct({
      provider: Schema.String,
      model: Schema.String,
      params: Schema.Record(Schema.String, Schema.Unknown),
      tools: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          description: Schema.String,
          parameters: Schema.Record(Schema.String, Schema.Unknown),
        }),
      ),
      series: Schema.Int,
      reason: Schema.Literals(['opened', 'changed']),
    }),
  ],
  ['system/message', Schema.Struct({ text: Schema.String })],
  [
    'user/message',
    Schema.Struct({
      text: Schema.String,
      source: Schema.Literals(USER_MESSAGE_SOURCES),
    }),
  ],
  [
    'assistant/message',
    Schema.Struct({
      provider: Schema.String,
      model: Schema.String,
      content: Schema.Array(ContentBlockSchema),
      usage: Schema.optionalKey(LlmUsageSchema),
      replayState: Schema.optionalKey(Schema.Unknown),
      stream: Schema.Array(AssistantStreamRecordSchema),
    }),
  ],
  [
    'assistant/attempt',
    Schema.Struct({
      provider: Schema.String,
      model: Schema.String,
      failure: LlmFailureSchema,
      stream: Schema.Array(AssistantStreamRecordSchema),
    }),
  ],
  [
    'llm/retry',
    Schema.Struct({
      attempt: Schema.Int,
      code: Schema.Literals(LLM_FAILURE_CODES),
      delayMs: Schema.Number,
      cause: Schema.Literals(['transient', 'context-overflow']),
    }) as Schema.Schema<unknown>,
  ],
  [
    'tool/call',
    Schema.Struct({
      callId: Schema.String,
      name: Schema.String,
      arguments: Schema.String,
      summary: Schema.optionalKey(Schema.String),
    }),
  ],
  [
    'tool/result',
    Schema.Struct({
      callId: Schema.String,
      isError: Schema.Boolean,
      content: Schema.Array(ContentBlockSchema),
      summary: Schema.optionalKey(Schema.String),
    }),
  ],
])

// The core events that never become history. A type missing from this list, the
// message set, and the projection registry fails the fold instead of vanishing.
registerLogOnlySessionEvents([
  'session/header',
  'session/cwd/changed',
  'session/repaired',
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'request/header',
  'assistant/attempt',
  'llm/retry',
  'tool/call',
])

/** The catalog every decoder starts from. */
export const SessionEventSchemas: SessionEventSchemaMap = catalog
/**
 * Adds event schemas to the catalog every decoder starts from. A package that
 * extends \`SessionEventMap\` calls this once at module load so logs written by
 * that package stay readable without wiring the map through every provider.
 */
export function registerSessionEventSchemas(schemas: SessionEventSchemaMap): void {
  for (const [type, schema] of schemas) catalog.set(type, schema)
}

/** Merges event schema maps; a later map wins on the same event type. */
export function extendSessionEventSchemas(
  ...maps: ReadonlyArray<SessionEventSchemaMap>
): SessionEventSchemaMap {
  const merged = new Map<string, Schema.Schema<unknown>>()
  for (const map of maps) {
    for (const [type, schema] of map) merged.set(type, schema)
  }
  return merged
}
