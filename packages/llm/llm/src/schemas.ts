import { Schema } from 'effect'
import type { AssistantStreamRecord } from './assistant-stream.ts'
import {
  LLM_FAILURE_CODES,
  LlmFailure,
  type ContentBlock,
  type FinishKind,
  type LlmFailureCode,
  type LlmUsage,
  type StreamChunk,
} from './types.ts'

/** The durable form of {@link LlmFailure}. Failures reach the log in this shape. */
export interface LlmFailureData {
  readonly _tag: 'LlmFailure'
  readonly code: LlmFailureCode
  readonly message: string
}

export const LlmFailureSchema: Schema.Schema<LlmFailureData> = Schema.Struct({
  _tag: Schema.Literal('LlmFailure'),
  code: Schema.Literals(LLM_FAILURE_CODES),
  message: Schema.String,
})

/** Encodes a live failure for the session log. */
export const encodeLlmFailure = (failure: LlmFailure): LlmFailureData => ({
  _tag: 'LlmFailure',
  code: failure.code,
  message: failure.message,
})

export const LlmUsageSchema: Schema.Schema<LlmUsage> = Schema.Struct({
  inputTokens: Schema.Int,
  outputTokens: Schema.Int,
  reasoningTokens: Schema.optionalKey(Schema.Int),
  cacheReadTokens: Schema.optionalKey(Schema.Int),
  cacheWriteTokens: Schema.optionalKey(Schema.Int),
})

const FinishKindSchema: Schema.Schema<FinishKind> = Schema.Literals([
  'stop',
  'tool-calls',
  'length',
  'error',
])

export const ContentBlockSchema: Schema.Schema<ContentBlock> = Schema.Union([
  Schema.Struct({ type: Schema.Literal('text'), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal('reasoning'), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal('image'),
    mediaType: Schema.String,
    data: Schema.String,
    name: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal('tool-call'),
    id: Schema.String,
    name: Schema.String,
    arguments: Schema.String,
  }),
])

export const StreamChunkSchema: Schema.Schema<StreamChunk> = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('block-start'),
    index: Schema.Int,
    blockType: Schema.Literals(['text', 'reasoning', 'tool-call']),
  }),
  Schema.Struct({ type: Schema.Literal('text-delta'), index: Schema.Int, text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal('reasoning-delta'),
    index: Schema.Int,
    text: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal('tool-call-delta'),
    index: Schema.Int,
    id: Schema.String,
    name: Schema.optionalKey(Schema.String),
    argumentsDelta: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal('block-end'),
    index: Schema.Int,
    block: ContentBlockSchema,
  }),
  Schema.Struct({ type: Schema.Literal('usage'), usage: LlmUsageSchema }),
  Schema.Struct({ type: Schema.Literal('finish'), kind: FinishKindSchema }),
])

export const AssistantStreamRecordSchema: Schema.Schema<AssistantStreamRecord> = Schema.Union([
  Schema.Struct({ type: Schema.Literal('chunk'), time: Schema.Number, chunk: StreamChunkSchema }),
  Schema.Struct({
    type: Schema.Literal('text-chunks'),
    time0: Schema.Number,
    index: Schema.Int,
    dt: Schema.Array(Schema.Number),
    texts: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal('reasoning-chunks'),
    time0: Schema.Number,
    index: Schema.Int,
    dt: Schema.Array(Schema.Number),
    texts: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal('tool-call-chunks'),
    time0: Schema.Number,
    index: Schema.Int,
    dt: Schema.Array(Schema.Number),
    id: Schema.String,
    name: Schema.optionalKey(Schema.String),
    args: Schema.Array(Schema.String),
  }),
])
