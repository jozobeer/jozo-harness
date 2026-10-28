import type { Agent } from '@jozo-harness/agent'
import { repairInterruptedRun } from '@jozo-harness/agent-loop'
import type { HookRegistry } from '@jozo-harness/kernel'
import {
  clipQuotes,
  parseCommand,
  rateFeedback,
  type CommandsShape,
  type Quote,
  type Session,
  type SessionError,
  type SessionEvent,
} from '@jozo-harness/session'
import { loadSkill, type LoadedSkill } from '@jozo-harness/tools-tier1'
import type { AskAnswer, AskBatchRequested, AskQuestion } from '@jozo-harness/safety'
import { answerOf } from '@jozo-harness/safety'
import type { SubmitMode, UiEvent, UiHost } from '@jozo-harness/ui-protocol'
import { Deferred, Effect, Queue, Stream, type Scope } from 'effect'

export type { UiHost } from '@jozo-harness/ui-protocol'

/** One live subscription. History is queued before `replaying` flips, so events that arrive during the replay stay behind it. */
interface Subscriber {
  readonly queue: Queue.Queue<UiEvent>
  replaying: boolean
  readonly pending: Array<UiEvent>
}

/** True when this live event is already in the history snapshot just queued. */
const alreadyQueued = (event: UiEvent, seen: ReadonlySet<number>): boolean =>
  event.kind === 'session' && seen.has(event.event.seq)

/**
 * Moves events buffered during the replay onto the queue, behind the history.
 * The handoff does not yield, so a publish cannot land between the buffer and the flag.
 */
const releaseReplay = (subscriber: Subscriber, seen: ReadonlySet<number>): void => {
  while (subscriber.pending.length > 0) {
    const caught = subscriber.pending.splice(0)
    for (const event of caught) {
      if (alreadyQueued(event, seen)) continue
      Queue.offerUnsafe(subscriber.queue, event)
    }
  }
  subscriber.replaying = false
}

/** Queues the snapshot, then anything that arrived while that was happening. */
const queueHistory = (
  subscriber: Subscriber,
  history: ReadonlyArray<SessionEvent>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const seen = new Set(history.map((event) => event.seq))
    for (const event of history) {
      yield* Queue.offer(subscriber.queue, { kind: 'session', event })
    }
    releaseReplay(subscriber, seen)
  })

export interface MakeUiHostOptions {
  readonly session: Session
  readonly agent: Agent
  readonly hooks: HookRegistry
  /** What the human can type besides a message; absent means every line is a message. */
  readonly commands?: CommandsShape
  /**
   * The roots the skill catalog reads. A slash naming a skill the registry does not
   * answer loads that skill for this turn; absent means only messages and commands.
   */
  readonly skills?: ReadonlyArray<string>
}

/**
 * Binds one running agent to the UI protocol. The host owns the wait for
 * approvals and questions, so a UI answers through commands and never through
 * a callback.
 */
export const makeUiHost = (options: MakeUiHostOptions): Effect.Effect<UiHost, never, Scope.Scope> =>
  Effect.gen(function* () {
    // A log this run resumed from may end inside a turn whose process is gone.
    // Closing it here keeps the page from drawing a dead approval card or a
    // running marker that no answer can clear.
    yield* repairInterruptedRun(options.agent)
    const subscribers = new Set<Subscriber>()
    const approvals = new Map<string, Deferred.Deferred<boolean>>()
    const asks = new Map<string, Deferred.Deferred<string>>()

    const publish = (event: UiEvent): void => {
      for (const subscriber of subscribers.values().toArray()) {
        if (subscriber.replaying) subscriber.pending.push(event)
        else Queue.offerUnsafe(subscriber.queue, event)
      }
    }

    yield* options.hooks.on('session/event', (event, session) => {
      if (session !== options.session) return
      // The wait is registered the moment the request is logged: the caller
      // appends the event just before it starts waiting, so no answer is lost.
      if (event.type === 'safety/approval/requested') {
        approvals.set(event.data.callId, Deferred.makeUnsafe<boolean>())
      }
      if (event.type === 'safety/approval/answered') approvals.delete(event.data.callId)
      if (event.type === 'interaction/ask/requested' && !asks.has(event.data.id)) {
        asks.set(event.data.id, Deferred.makeUnsafe<string>())
      }
      if (event.type === 'interaction/ask/answered') asks.delete(event.data.id)
      publish({ kind: 'session', event })
    })

    yield* options.hooks.on('agent/assistant-stream', (chunk, agent) => {
      if (agent !== options.agent) return
      publish({ kind: 'stream', chunk })
    })

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        subscribers.clear()
      }),
    )

    // The entry outlives the answer: a waiter that starts after the command
    // still finds a settled Deferred. The answered event removes it. An answer
    // nobody waits on stays unsettled, which is what the caller reads.
    const settle = <A>(
      waiting: Map<string, Deferred.Deferred<A>>,
      key: string,
      value: A,
    ): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const pending = waiting.get(key)
        if (pending === undefined) return false
        yield* Deferred.succeed(pending, value)
        return true
      })

    const waitFor = <A>(
      waiting: Map<string, Deferred.Deferred<A>>,
      key: string,
      missing: A,
    ): Effect.Effect<A> =>
      Effect.gen(function* () {
        const pending = waiting.get(key)
        return pending === undefined ? missing : yield* Deferred.await(pending)
      })

    /**
     * Asks a batch one question at a time through the existing question card.
     * The log keeps the batch call id and the questions, so a late answer still
     * names the call it belongs to even though the card shows one question.
     */
    const serveQuestions = (request: AskBatchRequested): Effect.Effect<ReadonlyArray<AskAnswer>> =>
      Effect.forEach(
        request.questions,
        (question: AskQuestion) =>
          Effect.gen(function* () {
            const id = request.callId + '/' + question.id
            const pending = yield* Deferred.make<string>()
            asks.set(id, pending)
            yield* options.session.append('interaction/ask/requested', {
              id,
              question:
                question.header === undefined
                  ? question.question
                  : question.header + '\n\n' + question.question,
              options: question.options.map((option) => option.label),
            })
            const answer = yield* Deferred.await(pending)
            yield* options.session.append('interaction/ask/answered', { id, answer })
            return answerOf(question, answer)
          }),
        { concurrency: 1 },
      ).pipe(Effect.orDie)

    /** Whether the registry answers this name; a command keeps a name a skill also has. */
    const commandAnswers = (name: string): boolean =>
      options.commands?.list().some((command) => command.name === name) ?? false

    /**
     * The skill a slash line forces, or nothing: the name must not be a command, and
     * the catalog is searched again on every line, as the skill tool searches it.
     */
    const forcedSkillOf = (line: string) =>
      Effect.gen(function* () {
        const roots = options.skills
        if (roots === undefined || roots.length === 0) return undefined
        const invocation = parseCommand(line)
        if (invocation === undefined || commandAnswers(invocation.name)) return undefined
        const skill = yield* loadSkill(roots, invocation.name)
        // A name no root lists is left to the registry, whose answer names commands.
        return skill === undefined ? undefined : { skill, input: invocation.input }
      })

    /**
     * Hands one line to the agent. A steer joins the running turn at its next
     * step; with nothing running the same queue wakes the runner and starts the
     * turn a followup would have started, so the fallback needs no check here.
     */
    const deliver = (
      message: {
        readonly text: string
        readonly source: 'user'
        readonly quotes?: ReadonlyArray<Quote>
      },
      mode: SubmitMode,
    ): Effect.Effect<void, SessionError> =>
      mode === 'steer' ? options.agent.steer(message) : options.agent.followup(message)

    /**
     * Writes a forced load the way a model's own call would write it: the assistant
     * turn that names the call, the call, and its result. The history stays one
     * shape, and the Run pane folds the load out of the same records.
     */
    const recordSkillLoad = (
      loaded: {
        readonly skill: LoadedSkill
        readonly input: string
      },
      mode: SubmitMode,
    ): Effect.Effect<void, SessionError> =>
      Effect.gen(function* () {
        const callId = 'skill-' + String(options.session.events().length + 1)
        const args = JSON.stringify({ name: loaded.skill.name })
        const route = options.agent.options?.route ?? ''
        const slash = route.indexOf('/')
        yield* options.session.append('assistant/message', {
          provider: slash < 0 ? 'jzh' : route.slice(0, slash),
          model: slash < 0 ? 'skill' : route.slice(slash + 1),
          content: [{ type: 'tool-call', id: callId, name: 'skill', arguments: args }],
          stream: [],
        })
        yield* options.session.append('tool/call', {
          callId,
          name: 'skill',
          arguments: args,
          // The path is where the card says the skill came from; the name stays in the args.
          summary: loaded.skill.path,
        })
        yield* options.session.append('tool/result', {
          callId,
          isError: false,
          content: [{ type: 'text', text: loaded.skill.body }],
          summary: loaded.skill.description,
        })
        // No arguments is a load without a turn: the human asked to read it.
        if (loaded.input !== '') yield* deliver({ text: loaded.input, source: 'user' }, mode)
      })

    /** The message the agent receives: the human's words, and the passages they quoted. */
    const quotedMessage = (
      text: string,
      quotes: ReadonlyArray<Quote>,
    ): {
      readonly text: string
      readonly source: 'user'
      readonly quotes?: ReadonlyArray<Quote>
    } => (quotes.length === 0 ? { text, source: 'user' } : { text, source: 'user', quotes })

    /**
     * A line from the page becomes a forced skill, a command, or the agent's
     * input, in that order. The mode reaches only a message: a command or a skill
     * load answers now either way, so steering it would wait for a step it does
     * not need.
     */
    const submitLine = (
      text: string,
      mode: SubmitMode,
      quotes?: ReadonlyArray<Quote>,
    ): Effect.Effect<void, SessionError> =>
      Effect.gen(function* () {
        // Quotations travel with the body, and both empty is nothing to send.
        const selected = clipQuotes(quotes ?? [])
        if (text.trim() === '' && selected.length === 0) return
        // A slash the registry does not answer may still name a skill; the loaded
        // skill becomes the turn's input, and its arguments become the message.
        const loaded = yield* forcedSkillOf(text)
        if (loaded !== undefined) {
          yield* recordSkillLoad(loaded, mode)
          return
        }
        const outcome =
          options.commands === undefined
            ? undefined
            : yield* options.commands.run(text, options.session, {
                route: () => options.agent.options.route,
                effort: () => options.agent.options.reasoningEffort ?? '',
                setModel: (model) => options.agent.setRoute(model),
                setEffort: (effort) => options.agent.setEffort(effort),
              })
        if (outcome !== undefined) return
        yield* deliver(quotedMessage(text, selected), mode)
      })

    return {
      events: Stream.scoped(
        Stream.unwrap(
          Effect.gen(function* () {
            const queue = yield* Queue.unbounded<UiEvent>()
            // Subscribe before the snapshot. An event that lands while history is
            // queued would otherwise miss this subscriber and never be delivered.
            const subscriber: Subscriber = { queue, replaying: true, pending: [] }
            subscribers.add(subscriber)
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                subscribers.delete(subscriber)
              }),
            )
            yield* queueHistory(subscriber, options.session.events())
            return Stream.fromQueue(queue)
          }),
        ),
      ),
      // A command is answered without consuming a turn; its answer reaches the UI
      // through the session events, so a reconnecting client sees it too.
      submit: (text, mode = 'queue', quotes) => submitLine(text, mode, quotes),
      approve: (callId, approved) => Effect.asVoid(settle(approvals, callId, approved)),
      /**
       * A question only lives in the run that asked it: a session reopened from
       * its log draws the question again, with nobody left to wait on the answer.
       * The reader's word is input for the session either way, so it becomes the
       * next message, and the log records the question as answered rather than
       * leaving a card that answers nothing behind it.
       */
      answer: (id, answer) =>
        Effect.gen(function* () {
          const taken = yield* settle(asks, id, answer)
          if (taken) return
          yield* options.session.append('interaction/ask/answered', { id, answer })
          yield* options.agent.followup({ text: answer, source: 'user' })
        }),
      cancel: () => options.agent.cancel('user'),
      setEffort: (effort) => options.agent.setEffort(effort),
      setModel: (model) => options.agent.setRoute(model),
      // Without a request there is nothing to allow: deny rather than hang.
      answerApproval: (request) => waitFor(approvals, request.callId, false),
      answerAsk: (request) => waitFor(asks, request.id, ''),
      serveQuestions,
      rate: (target, rating, memo) =>
        rateFeedback(options.session, {
          target,
          rating,
          ...(memo === undefined ? {} : { memo }),
        }).pipe(Effect.asVoid),
    }
  })
