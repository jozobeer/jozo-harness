import {
  AgentRunnerService,
  type Agent,
  type AgentRunner,
  type UserMessage,
} from '@jozo-harness/agent'
import { Hooks, type Plugin } from '@jozo-harness/kernel'
import {
  BlockAssembler,
  Llm,
  LlmFailure,
  compactAssistantStream,
  encodeLlmFailure,
  type ContentBlock,
  type RequestMessage,
  type StreamChunk,
  type TimedStreamChunk,
  type ToolSchema,
} from '@jozo-harness/llm'
import {
  COMPACT_SUMMARY_INSTRUCTION,
  DEFAULT_COMPACT_MAX_BYTES,
  checkpointOf,
  cwdOf,
  deriveMessages,
  IMAGE_REFERENCE_TOKENS,
  lastRequestHeader,
  lastRuntimeContext,
  lastSystemPrompt,
  messageBudgetOf,
  messagesWithPrune,
  meterOf,
  pruneFor,
  summarizableMessages,
  type CompactOptions,
  type CompactionCheckpoint,
  type RequestHeaderData,
  type Session,
  type SessionEvent,
  type SessionEventMap,
  type TokenBudget,
} from '@jozo-harness/session'
import { SystemPrompt } from '@jozo-harness/system-prompt'
import { applySpill, makeSpillWriter, type SpillOptions } from '@jozo-harness/tools'
import { Tools, resultSummary } from '@jozo-harness/tools'
import { Context, Effect, Exit, Layer, Queue, Schema, Stream } from 'effect'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { groupCalls, type CallBatch } from './batch.ts'
import type { AgentRequest } from './hooks.ts'
import { retryConfigSchema } from './retry.ts'

export class AgentLoop extends Context.Service<AgentLoop, AgentRunner>()(
  'jozo-harness/AgentLoop',
) {}

type ToolCall = Extract<ContentBlock, { type: 'tool-call' }>

type StepOutcome =
  | { readonly ok: true; readonly content: ReadonlyArray<ContentBlock> }
  | { readonly ok: false; readonly failure: LlmFailure }

/** The prompt as the system-prompt service hands it to one step. */
interface PromptBuild {
  readonly system: string
  readonly tools: ReadonlyArray<ToolSchema>
}

/** The context window assumed when neither the profile nor the adapter names one. */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000
/** The share of the window a request may reach before compaction fires. */
export const DEFAULT_COMPACT_THRESHOLD_RATIO = 0.8
/** The tokens kept free under the window whatever the ratio says. */
export const DEFAULT_COMPACT_HEADROOM_TOKENS = 65_536
/**
 * The share of the window a compaction leaves untouched. A summary therefore hands
 * the next request a tail well under the line, with the frame and the summary
 * sharing what is left; dsh keeps the same share of its window.
 */
export const DEFAULT_COMPACT_RETAIN_RATIO = 0.16

/** Results larger than this are written to a file; only their head stays in the log. */
const SPILL_BYTES = 32_000

/** Where spilled text goes without a profile saying otherwise: the managed default. */
const SPILL_ROOT = join(tmpdir(), 'jzh-spill')

const spillOf = (agent: Agent): SpillOptions => ({
  maxSpillBytes: agent.options.maxSpillBytes ?? SPILL_BYTES,
  spill: makeSpillWriter({
    root: agent.options.spillDir ?? SPILL_ROOT,
    sessionId: agent.id,
  }),
})

const isToolCall = (block: ContentBlock): block is ToolCall => block.type === 'tool-call'

const splitRoute = (route: string): { readonly provider: string; readonly model: string } => {
  const index = route.indexOf('/')
  return index < 0
    ? { provider: route, model: '' }
    : { provider: route.slice(0, index), model: route.slice(index + 1) }
}

const countEvents = (session: Session, type: 'turn/start' | 'step/start'): number =>
  session.events().filter((event) => event.type === type).length

/** The calls the log holds with no result: the run that made them is gone. */
const openCalls = (
  events: ReadonlyArray<SessionEvent>,
): ReadonlyArray<{ readonly callId: string; readonly name: string }> => {
  const open = new Map<string, string>()
  for (const event of events) {
    if (event.type === 'tool/call') open.set(event.data.callId, event.data.name)
    if (event.type === 'tool/result') open.delete(event.data.callId)
  }
  return [...open.entries()].map(([callId, name]) => ({ callId, name }))
}

const recordedTurnEnd = (session: Session, turn: number): boolean =>
  session.events().some((event) => event.type === 'turn/end' && event.data.turn === turn)

const agentLoopEffect = (
  config: AgentLoopConfig = {},
): Effect.Effect<AgentRunner, never, Hooks | Tools | SystemPrompt | Llm> =>
  Effect.gen(function* () {
    const hooks = yield* Hooks
    const tools = yield* Tools
    const promptService = yield* SystemPrompt
    const llm = yield* Llm
    const budget: TokenBudget = {
      contextWindow:
        config.contextWindow ?? llm.capabilities.contextWindow ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
      thresholdRatio: config.thresholdRatio ?? DEFAULT_COMPACT_THRESHOLD_RATIO,
      headroomTokens: config.headroomTokens ?? DEFAULT_COMPACT_HEADROOM_TOKENS,
      reserveTokens: config.maxTokens ?? 0,
      imageTokens: llm.capabilities.imageTokens ?? IMAGE_REFERENCE_TOKENS,
    }
    const compact: CompactOptions = {
      retainTokens:
        config.retainTokens ?? Math.floor(messageBudgetOf(budget) * DEFAULT_COMPACT_RETAIN_RATIO),
      maxBytes: config.maxBytes ?? DEFAULT_COMPACT_MAX_BYTES,
    }

    // A session that cannot be written stops the agent: `orDie` turns the failure into
    // a defect, which `runTurn` records as an error turn and which kills the runner.
    const append = <K extends keyof SessionEventMap>(
      agent: Agent,
      type: K,
      data: SessionEventMap[K],
    ): Effect.Effect<void> => agent.session.append(type, data).pipe(Effect.orDie)

    const recordAttempt = (
      agent: Agent,
      request: AgentRequest,
      failure: LlmFailure,
      stream: ReadonlyArray<TimedStreamChunk>,
    ): Effect.Effect<void> =>
      append(agent, 'assistant/attempt', {
        provider: request.provider,
        model: request.model,
        failure: encodeLlmFailure(failure),
        stream: compactAssistantStream(stream),
      })

    const streamStep = (agent: Agent, request: AgentRequest): Effect.Effect<StepOutcome> =>
      Effect.gen(function* () {
        const assembler = new BlockAssembler()
        const stream: Array<TimedStreamChunk> = []
        const collect = (chunk: StreamChunk) =>
          Effect.gen(function* () {
            const timed: TimedStreamChunk = { time: Date.now(), chunk }
            stream.push(timed)
            assembler.push(chunk)
            yield* hooks.emit('agent/assistant-stream', timed, agent)
          })

        return yield* Stream.runForEach(llm.stream(request), collect).pipe(
          Effect.matchEffect({
            onFailure: (failure: LlmFailure) =>
              Effect.gen(function* () {
                yield* recordAttempt(agent, request, failure, stream)
                return { ok: false as const, failure }
              }),
            onSuccess: () =>
              Effect.gen(function* () {
                const assembled = assembler.snapshot()
                if (assembled.content.length === 0 || assembled.finish === 'error') {
                  const failure = new LlmFailure({
                    code: assembled.content.length === 0 ? 'EMPTY_RESPONSE' : 'PROVIDER',
                    message: 'the provider completed without usable content',
                  })
                  yield* recordAttempt(agent, request, failure, stream)
                  return { ok: false as const, failure }
                }
                yield* append(agent, 'assistant/message', {
                  provider: request.provider,
                  model: request.model,
                  content: assembled.content,
                  ...(assembled.usage === undefined ? {} : { usage: assembled.usage }),
                  stream: compactAssistantStream(stream),
                })
                return { ok: true as const, content: assembled.content }
              }),
          }),
        )
      })

    /**
     * Records the runtime facts only when they changed. The log is the only memory:
     * a resumed session compares against the newest snapshot it already holds, so
     * the same workspace and permission state is not restated every step.
     */
    const recordRuntimeContext = (agent: Agent, cwd: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const text = yield* promptService.runtimeContext({ cwd })
        if (text === '' || text === lastRuntimeContext(agent.session.events())) return
        yield* append(agent, 'user/message', { text, source: 'runtime-context' })
      })

    /**
     * Appends the settled system prompt when it changed and the input that started
     * the step; the runtime snapshot follows the prompt and precedes the input, and
     * is recorded on every step so a mid-turn change reaches the next request. The
     * log's newest frame is the comparison, so a resumed session holding duplicates
     * stops growing rather than adding another copy.
     */
    const recordInput = (
      agent: Agent,
      build: { readonly system: string },
      input: ReadonlyArray<UserMessage>,
      cwd: string,
      opening: boolean,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (opening && build.system !== lastSystemPrompt(agent.session.events())) {
          yield* append(agent, 'system/message', { text: build.system })
        }
        yield* recordRuntimeContext(agent, cwd)
        for (const message of input) {
          yield* append(agent, 'user/message', { text: message.text, source: message.source })
        }
      })

    /** Whether two headers describe the same assembled request. */
    const sameHeader = (previous: RequestHeaderData, request: AgentRequest): boolean =>
      previous.provider === request.provider &&
      previous.model === request.model &&
      JSON.stringify(previous.params) === JSON.stringify(request.params) &&
      JSON.stringify(previous.tools) === JSON.stringify(request.tools)

    /**
     * Records what this request was assembled with, once per series: a step that
     * changes neither route, parameters, nor tools reuses the header it opened.
     */
    const recordRequestHeader = (agent: Agent, request: AgentRequest): Effect.Effect<void> =>
      Effect.gen(function* () {
        const previous = lastRequestHeader(agent.session.events())
        if (previous !== undefined && sameHeader(previous, request)) return
        yield* append(agent, 'request/header', {
          provider: request.provider,
          model: request.model,
          params: request.params,
          tools: request.tools,
          series: (previous?.series ?? 0) + 1,
          reason: previous === undefined ? 'opened' : 'changed',
        })
      })

    /**
     * Records what this request stops carrying, before it is sent: a request over
     * the price keeps every message in the log and replaces the content of the old
     * ones. The price is the token pressure of the request, so a conversation with
     * room left is sent as it is and only one past the threshold is pruned.
     */
    /**
     * The one auxiliary call that turns the summarized span into words. It reuses
     * the routed model and the conversation prefix, appends its instruction, and
     * answers with text only. Anything but a usable summary leaves the log without
     * a checkpoint: the prune below still bounds the request.
     */
    const summarize = (
      envelope: Omit<AgentRequest, 'messages'>,
      messages: ReadonlyArray<RequestMessage>,
    ): Effect.Effect<string> =>
      llm
        .stream({
          provider: envelope.provider,
          model: envelope.model,
          params: envelope.params,
          tools: [],
          messages: [
            ...messages,
            { role: 'user', content: [{ type: 'text', text: COMPACT_SUMMARY_INSTRUCTION }] },
          ],
        })
        .pipe(
          Stream.runFold(
            () => '',
            (text: string, chunk: StreamChunk) =>
              chunk.type === 'text-delta' ? text + chunk.text : text,
          ),
          Effect.map((text) => text.trim()),
          Effect.catchCause(() => Effect.succeed('')),
        )

    /** The checkpoint this span earns, or nothing when there is no word for it. */
    const checkpointFor = (
      envelope: Omit<AgentRequest, 'messages'>,
      events: ReadonlyArray<SessionEvent>,
    ): Effect.Effect<CompactionCheckpoint | undefined> =>
      Effect.gen(function* () {
        const range = summarizableMessages(events, compact)
        if (range.length === 0) return undefined
        const bound = messagesWithPrune(range, pruneFor(events, compact))
        const summary = yield* summarize(envelope, bound)
        return checkpointOf(range, summary, envelope)
      })

    /**
     * Folds the history when the meter says it is past the line, or when a provider
     * refused the request and the loop needs the surface to shrink before one more
     * attempt. A forced fold prunes first, so the auxiliary summary call is made on
     * the smaller history; the answer says whether the estimate actually came down.
     */
    const recordCompaction = (
      agent: Agent,
      envelope: Omit<AgentRequest, 'messages'>,
      force = false,
    ): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const events = agent.session.events()
        const meter = meterOf(events, budget)
        if (!force && !meter.compacts) return false
        if (force) {
          const first = pruneFor(events, compact)
          if (first !== undefined) yield* append(agent, 'compaction/prune', first)
        }
        const checkpoint = yield* checkpointFor(envelope, agent.session.events())
        if (checkpoint !== undefined) yield* append(agent, 'compaction/checkpoint', checkpoint)
        const prune = pruneFor(agent.session.events(), compact)
        if (prune !== undefined) yield* append(agent, 'compaction/prune', prune)
        return meterOf(agent.session.events(), budget).estimated < meter.estimated
      })

    /** The request envelope of this step, before the history is folded into it. */
    const envelopeOf = (agent: Agent, build: PromptBuild): Omit<AgentRequest, 'messages'> => {
      const route = splitRoute(agent.options.route)
      return {
        provider: route.provider,
        model: route.model,
        // Params reach the provider as written, so the cap uses the field it reads and
        // the header records what the budget above reserved. The effort uses the same
        // wire vocabulary the provider's own API does.
        params: {
          ...(agent.options.reasoningEffort === undefined
            ? {}
            : { reasoning_effort: agent.options.reasoningEffort }),
          ...(config.maxTokens === undefined ? {} : { max_tokens: config.maxTokens }),
        },
        tools: build.tools,
      }
    }

    const requestOf = (agent: Agent, build: PromptBuild): AgentRequest => ({
      ...envelopeOf(agent, build),
      // The log is what was sent: recorded compaction is part of the fold.
      messages: deriveMessages(agent.session.events()),
    })

    /**
     * The request after a fold that made the surface smaller, and nothing when the
     * fold left it as large: the loop only resends what can still fit.
     */
    const rebuildAfterFold = (
      agent: Agent,
      envelope: Omit<AgentRequest, 'messages'>,
      rebuild: () => Effect.Effect<AgentRequest>,
      attempt: number,
      failure: LlmFailure,
    ): Effect.Effect<AgentRequest | undefined> =>
      Effect.gen(function* () {
        if (!(yield* recordCompaction(agent, envelope, true))) return undefined
        yield* append(agent, 'llm/retry', {
          attempt,
          code: failure.code,
          delayMs: 0,
          cause: 'context-overflow',
        })
        return yield* rebuild()
      })

    /** Whether the hooks ask for one more attempt; a retry waits out its delay and records itself. */
    const retryAfterFailure = (
      agent: Agent,
      failure: LlmFailure,
      attempt: number,
    ): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const decision = yield* hooks.waterfall('agent/request-error', agent, failure, attempt)
        if (decision?.kind !== 'retry') return false
        const delayMs = decision.delayMs ?? 0
        if (delayMs > 0) yield* Effect.sleep(delayMs)
        yield* append(agent, 'llm/retry', {
          attempt,
          code: failure.code,
          delayMs,
          cause: 'transient',
        })
        return true
      })

    /**
     * The request to send again after a context overflow, and nothing when this
     * attempt is not one or the fold left the surface as large.
     */
    const resendAfterOverflow = (
      agent: Agent,
      envelope: Omit<AgentRequest, 'messages'>,
      rebuild: () => Effect.Effect<AgentRequest>,
      attempt: number,
      failure: LlmFailure,
      alreadyRecovered: boolean,
    ): Effect.Effect<AgentRequest | undefined> =>
      alreadyRecovered || failure.code !== 'CONTEXT_WINDOW_EXCEEDED'
        ? Effect.succeed(undefined)
        : rebuildAfterFold(agent, envelope, rebuild, attempt, failure)

    /**
     * Sends the settled request until a hook says to stop retrying. A context
     * overflow gets one fold-and-rebuild attempt before the same hooks decide; the
     * request is only resent when the fold actually made the surface smaller.
     */
    const streamUntilSettled = (
      agent: Agent,
      request: AgentRequest,
      envelope: Omit<AgentRequest, 'messages'>,
      rebuild: () => Effect.Effect<AgentRequest>,
    ): Effect.Effect<StepOutcome> =>
      Effect.gen(function* () {
        let current = request
        let attempt = 0
        let overflowRecovered = false
        while (true) {
          const outcome = yield* streamStep(agent, current)
          if (outcome.ok) return outcome
          attempt += 1
          const rebuilt = yield* resendAfterOverflow(
            agent,
            envelope,
            rebuild,
            attempt,
            outcome.failure,
            overflowRecovered,
          )
          if (rebuilt !== undefined) {
            overflowRecovered = true
            current = rebuilt
            continue
          }
          if (!(yield* retryAfterFailure(agent, outcome.failure, attempt))) return outcome
        }
      })

    const requestStep = (
      agent: Agent,
      input: ReadonlyArray<UserMessage>,
      opening: boolean,
    ): Effect.Effect<StepOutcome> =>
      Effect.gen(function* () {
        const build = yield* promptService
          .build({ variables: {} })
          .pipe(Effect.provideService(Tools, tools), Effect.orDie)
        yield* recordInput(
          agent,
          build,
          input,
          cwdOf(agent.session.events(), agent.session.header),
          opening,
        )
        const envelope = envelopeOf(agent, build)
        yield* recordCompaction(agent, envelope)
        const rebuild = (): Effect.Effect<AgentRequest> =>
          Effect.gen(function* () {
            const base = requestOf(agent, build)
            const rebuilt = (yield* hooks.waterfall('agent/request', base)) ?? base
            yield* recordRequestHeader(agent, rebuilt)
            return rebuilt
          })
        const request = yield* rebuild()
        return yield* streamUntilSettled(agent, request, envelope, rebuild)
      })

    const runOne = (
      agent: Agent,
      call: ToolCall,
      pending: Map<string, ToolCall>,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const spill = spillOf(agent)
        const outcome = yield* tools.call({
          callId: call.id,
          tool: call.name,
          arguments: call.arguments,
          context: {
            sessionId: agent.id,
            cwd: cwdOf(agent.session.events(), agent.session.header),
            callId: call.id,
            // A tool that pages its own result stores the overflow through the
            // same writer the pipeline uses, so both live beside the session.
            ...(spill.spill === undefined ? {} : { spill: spill.spill }),
          },
        })
        const shown = yield* applySpill(
          outcome,
          { callId: call.id, tool: call.name },
          spillOf(agent),
        )
        // The presentation is rendered where the tool is known, and recorded with
        // the result: every UI reads the same line out of the log instead of
        // guessing one from the raw content.
        yield* append(agent, 'tool/result', {
          callId: call.id,
          isError: shown.isError,
          content: shown.content,
          summary: tools.presentResult(call.name, call.arguments, {
            isError: shown.isError,
            summary: resultSummary(shown.content),
          }).summary,
        })
        pending.delete(call.id)
      })

    const declareBatch = (
      agent: Agent,
      batch: CallBatch<ToolCall>,
      pending: Map<string, ToolCall>,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        for (const call of batch.calls) {
          yield* append(agent, 'tool/call', {
            callId: call.id,
            name: call.name,
            arguments: call.arguments,
            summary: tools.presentCall(call.name, call.arguments).summary,
          })
          pending.set(call.id, call)
        }
      })

    const runBatch = (
      agent: Agent,
      batch: CallBatch<ToolCall>,
      pending: Map<string, ToolCall>,
    ): Effect.Effect<void> => {
      const run = (call: ToolCall) => runOne(agent, call, pending)
      return batch.parallel
        ? Effect.forEach(batch.calls, run, { concurrency: 'unbounded' })
        : Effect.forEach(batch.calls, run, { discard: true })
    }

    /** What a call gets when the run that made it never finished it. */
    const didNotFinish = (agent: Agent, callId: string, name: string): Effect.Effect<void> =>
      append(agent, 'tool/result', {
        callId,
        isError: true,
        content: [{ type: 'text' as const, text: `tool ${name} did not finish` }],
      }).pipe(Effect.catchCause(() => Effect.void))

    const failPending = (
      agent: Agent,
      pending: ReadonlyMap<string, ToolCall>,
    ): Effect.Effect<void> =>
      Effect.forEach([...pending.values()], (call) => didNotFinish(agent, call.id, call.name), {
        discard: true,
      })

    /**
     * The log a run resumes from can hold a call with no result: a process killed
     * between the call and its answer, or a question the reader never answered. A
     * turn that asks with that history asks the model about a call it never got an
     * answer for, so those calls are written down as unfinished before it does.
     */
    const closeOpenCalls = (agent: Agent): Effect.Effect<void> =>
      Effect.forEach(
        openCalls(agent.session.events()),
        (call) => didNotFinish(agent, call.callId, call.name),
        { discard: true },
      )

    const executeCalls = (agent: Agent, calls: ReadonlyArray<ToolCall>): Effect.Effect<void> =>
      Effect.gen(function* () {
        const pending = new Map<string, ToolCall>()
        yield* Effect.onExit(
          Effect.gen(function* () {
            const batches = groupCalls(calls, (call) =>
              tools.isConcurrencySafe(call.name, call.arguments),
            )
            for (const batch of batches) {
              yield* declareBatch(agent, batch, pending)
              yield* runBatch(agent, batch, pending)
            }
          }),
          () => failPending(agent, pending),
        )
      })

    const runSteps = (
      agent: Agent,
      turn: number,
      input: ReadonlyArray<UserMessage>,
    ): Effect.Effect<boolean> => {
      const loop = (
        pending: ReadonlyArray<UserMessage>,
        opening: boolean,
      ): Effect.Effect<boolean> =>
        Effect.gen(function* () {
          const step = countEvents(agent.session, 'step/start') + 1
          yield* append(agent, 'step/start', { step })
          const outcome = yield* requestStep(agent, pending, opening)
          if (!outcome.ok) {
            yield* append(agent, 'step/end', { step })
            yield* append(agent, 'turn/end', {
              turn,
              reason: { kind: 'error', failure: encodeLlmFailure(outcome.failure) },
            })
            return false
          }
          const calls = outcome.content.filter(isToolCall)
          if (calls.length === 0) {
            yield* append(agent, 'step/end', { step })
            if (agent.inbox.nextStep.length === 0) return true
            return yield* loop(yield* agent.inbox.claim(false).pipe(Effect.orDie), false)
          }
          yield* executeCalls(agent, calls)
          yield* append(agent, 'step/end', { step })
          // Input queued while the tools ran (steer, inject) joins the next request.
          return yield* loop(yield* agent.inbox.claim(false).pipe(Effect.orDie), false)
        })
      return loop(input, true)
    }

    const runTurn = (agent: Agent): Effect.Effect<void> => {
      const turn = countEvents(agent.session, 'turn/start') + 1
      const program = Effect.gen(function* () {
        yield* closeOpenCalls(agent)
        yield* append(agent, 'turn/start', { turn })
        const claimed = yield* agent.inbox.claim(true).pipe(Effect.orDie)
        const decision = yield* hooks.waterfall('agent/pre-step', { agent, messages: claimed })
        if (decision?.kind === 'reject') {
          yield* append(agent, 'turn/end', {
            turn,
            reason: {
              kind: 'error',
              failure: encodeLlmFailure(
                new LlmFailure({ code: 'INVALID_REQUEST', message: decision.reason }),
              ),
            },
          })
          return
        }
        // Context the pre-step listeners supplied opens the turn, before its claimed input.
        const completed = yield* runSteps(agent, turn, [...(decision?.messages ?? []), ...claimed])
        if (!completed) return
        yield* hooks.serial('agent/turn-stopping', agent)
        yield* append(agent, 'turn/end', { turn, reason: { kind: 'completed' } })
      })
      const recordAbnormal = (exit: Exit.Exit<void, never>): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (Exit.isSuccess(exit) || recordedTurnEnd(agent.session, turn)) return
          const cause = agent.driver.cancelCause
          const reason =
            cause === undefined
              ? {
                  kind: 'error' as const,
                  failure: encodeLlmFailure(
                    new LlmFailure({ code: 'PROVIDER' as const, message: 'the turn failed' }),
                  ),
                }
              : { kind: 'cancelled' as const, cause }
          yield* append(agent, 'turn/end', { turn, reason }).pipe(
            Effect.catchCause(() => Effect.void),
          )
        })
      return program.pipe(Effect.onExit(recordAbnormal)) as Effect.Effect<void>
    }

    const run: AgentRunner['run'] = (agent: Agent) =>
      Effect.gen(function* () {
        while (true) {
          yield* Queue.take(agent.driver.wake)
          if (!agent.inbox.pending) continue
          yield* agent.driver.setStatus('running')
          yield* runTurn(agent).pipe(Effect.ensuring(agent.driver.setStatus('idle')))
        }
      })

    return { run }
  })

export const agentLoopLayer: Layer.Layer<AgentLoop, never, Hooks | Tools | SystemPrompt | Llm> =
  Layer.effect(AgentLoop, agentLoopEffect())

export const agentLoopConfigSchema = Schema.Struct({
  /** The tail this profile never prunes, in estimated tokens. Defaults to 16% of the window. */
  retainTokens: Schema.optionalKey(Schema.Int),
  /** One text block larger than this many bytes is stubbed, outside the retention. */
  maxBytes: Schema.optionalKey(Schema.Int),
  /** The routed model's context window in tokens. Defaults to the adapter's, or 128000. */
  contextWindow: Schema.optionalKey(Schema.Int),
  /** Compact once the estimate reaches this share of the window. Defaults to 0.8. */
  thresholdRatio: Schema.optionalKey(Schema.Number),
  /** Tokens kept free under the window. Defaults to 65536. */
  headroomTokens: Schema.optionalKey(Schema.Int),
  /**
   * Output tokens one request sends as `max_tokens` and reserves. The line comes down
   * by this much before the headroom is taken off. Unset reserves nothing.
   */
  maxTokens: Schema.optionalKey(Schema.Int),
  /** Transient provider failures worth another attempt, and how long to wait. */
  retry: Schema.optionalKey(retryConfigSchema),
})

export type AgentLoopConfig = Schema.Schema.Type<typeof agentLoopConfigSchema>

/** Loader definition for the turn runner. */
export const agentLoopPlugin: Plugin<
  AgentLoopConfig,
  AgentRunnerService,
  Hooks | Tools | SystemPrompt | Llm
> = {
  name: '@jozo-harness/agent-loop',
  config: agentLoopConfigSchema,
  provides: [AgentRunnerService],
  requires: [Hooks, Tools, SystemPrompt, Llm],
  layer: (config) => Layer.effect(AgentRunnerService, agentLoopEffect(config)),
}
