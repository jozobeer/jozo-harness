import type { LlmAdapter, StreamChunk } from '@jozo-harness/llm'
import { Data, Effect, Schema, Stream } from 'effect'
import type { SessionEvent, SessionSeq } from './events.ts'
import type { SessionError } from './errors.ts'
import { registerLogOnlySessionEvents } from './projections.ts'
import { registerSessionEventSchemas, type SessionEventSchemaMap } from './schemas.ts'
import type { Session } from './session.ts'

/** The languages a reader may ask for; the page sends its own locale code. */
export const REASONING_TRANSLATION_LANGUAGES = ['en', 'ja'] as const

export type ReasoningTranslationLanguage = (typeof REASONING_TRANSLATION_LANGUAGES)[number]

/** What the prompt calls each language; the log keeps the code, not the name. */
const LANGUAGE_NAMES: Readonly<Record<ReasoningTranslationLanguage, string>> = {
  en: 'English',
  ja: 'Japanese',
}

/**
 * One translation of one assistant message's reasoning. The target is the seq of
 * that message, and the original event is never touched: the log keeps the
 * translation as a line of its own.
 */
export interface ReasoningTranslationData {
  readonly target: SessionSeq
  readonly language: ReasoningTranslationLanguage
  readonly text: string
  readonly provider: string
  readonly model: string
}

declare module './events.ts' {
  interface SessionEventMap {
    'reasoning/translation': ReasoningTranslationData
  }
}

/** Schemas for the events this module adds. */
export const reasoningTranslationEventSchemas: SessionEventSchemaMap = new Map<
  string,
  Schema.Schema<unknown>
>([
  [
    'reasoning/translation',
    Schema.Struct({
      target: Schema.Int,
      language: Schema.Literals(REASONING_TRANSLATION_LANGUAGES),
      text: Schema.String,
      provider: Schema.String,
      model: Schema.String,
    }),
  ],
])

registerSessionEventSchemas(reasoningTranslationEventSchemas)
// A translation is for the reader, not the next request: the original reasoning
// is what the model already answered with, and the translation must not join it.
registerLogOnlySessionEvents(['reasoning/translation'])

/** Why a translation could not be written. */
export type ReasoningTranslationErrorCode =
  | 'bad-target'
  | 'no-reasoning'
  | 'bad-language'
  | 'empty-translation'
  | 'provider'

export class ReasoningTranslationError extends Data.TaggedError('ReasoningTranslationError')<{
  readonly code: ReasoningTranslationErrorCode
  readonly message: string
}> {}

/** What one assistant message thought, or undefined when it thought nothing. */
const reasoningOf = (event: SessionEvent): string | undefined => {
  if (event.type !== 'assistant/message') return undefined
  const text = event.data.content
    .filter((block) => block.type === 'reasoning')
    .map((block) => block.text)
    .join('\n')
  return text.trim() === '' ? undefined : text
}

/**
 * The newest translation of each target. A second translation of the same target
 * wins, the way a later rating does; a log written by an older run still reads.
 */
export const reasoningTranslationsOf = (
  events: ReadonlyArray<SessionEvent>,
): ReadonlyMap<SessionSeq, ReasoningTranslationData> => {
  const byTarget = new Map<SessionSeq, ReasoningTranslationData>()
  for (const event of events) {
    if (event.type !== 'reasoning/translation') continue
    byTarget.set(event.data.target, event.data)
  }
  return byTarget
}

/**
 * What the model reads for one translation. The reasoning is quoted between two
 * markers so the instruction and the text cannot be confused for each other.
 */
const promptOf = (text: string, language: ReasoningTranslationLanguage): string =>
  'Translate the reasoning below into ' +
  LANGUAGE_NAMES[language] +
  '. Keep code, commands, file paths, identifiers, and Markdown unchanged. Reply with the translation only, without a preamble or a note.\n\n<reasoning>\n' +
  text +
  '\n</reasoning>'

export interface ReasoningTranslationRequest {
  /** The seq of the assistant message whose reasoning is translated. */
  readonly target: SessionSeq
  readonly language: string
  readonly provider: string
  readonly model: string
}

/**
 * Translates one logged reasoning in a single model call and appends the result
 * as its own event. A translation already saved for the target is returned
 * without another call, so reopening a session costs nothing. A failed call
 * leaves the log exactly as it was; the caller shows the original and the reason.
 */
export const translateReasoning = (
  session: Session,
  llm: LlmAdapter,
  request: ReasoningTranslationRequest,
): Effect.Effect<ReasoningTranslationData, ReasoningTranslationError | SessionError> =>
  Effect.gen(function* () {
    const language = REASONING_TRANSLATION_LANGUAGES.find((one) => one === request.language)
    if (language === undefined) {
      return yield* Effect.fail(
        new ReasoningTranslationError({
          code: 'bad-language',
          message: 'reasoning is not translated into "' + request.language + '"',
        }),
      )
    }
    const events = session.events()
    const target = events.find((event) => event.seq === request.target)
    if (target === undefined || target.type !== 'assistant/message') {
      return yield* Effect.fail(
        new ReasoningTranslationError({
          code: 'bad-target',
          message: 'the target is not an assistant message: #' + String(request.target),
        }),
      )
    }
    const reasoning = reasoningOf(target)
    if (reasoning === undefined) {
      return yield* Effect.fail(
        new ReasoningTranslationError({
          code: 'no-reasoning',
          message: 'the target message carries no reasoning: #' + String(request.target),
        }),
      )
    }
    const saved = reasoningTranslationsOf(events).get(request.target)
    if (saved !== undefined) return saved
    const text = yield* llm
      .stream({
        provider: request.provider,
        model: request.model,
        messages: [
          { role: 'user', content: [{ type: 'text', text: promptOf(reasoning, language) }] },
        ],
        tools: [],
        params: {},
      })
      .pipe(
        Stream.runFold(
          () => '',
          (said: string, chunk: StreamChunk) =>
            chunk.type === 'text-delta' ? said + chunk.text : said,
        ),
        Effect.mapError(
          (failure) =>
            new ReasoningTranslationError({
              code: 'provider',
              message: failure.code + ': ' + failure.message,
            }),
        ),
      )
    const translated = text.trim()
    if (translated === '') {
      return yield* Effect.fail(
        new ReasoningTranslationError({
          code: 'empty-translation',
          message: 'the model returned no translation',
        }),
      )
    }
    const data: ReasoningTranslationData = {
      target: request.target,
      language,
      text: translated,
      provider: request.provider,
      model: request.model,
    }
    yield* session.append('reasoning/translation', data)
    return data
  })
