import type { SessionEvent } from '@jozo-harness/session'
import { Data, type Effect, type Queue, type Scope } from 'effect'
import type { Session, SessionError, SessionId, TurnCancelCause } from '@jozo-harness/session'
import type { UserMessage } from './events.ts'
import type { Inbox } from './inbox.ts'

export type AgentStatus = 'idle' | 'running' | 'cancelling' | 'disposed'

/** Why a running turn was cancelled. Recorded in `turn/end.reason`. */
export type AgentCancelCause = TurnCancelCause

export interface AgentOptions {
  /** Results larger than this are written away; unset keeps the loop default. */
  readonly maxSpillBytes?: number
  /** Where spilled text is kept; unset keeps the loop's managed default. */
  readonly spillDir?: string
  /** `provider/model` route. */
  readonly route: string
  readonly reasoningEffort?: string
}

/** A plugin failed to accept a new agent. The create is rolled back. */
export class AgentInitError extends Data.TaggedError('AgentInitError')<{
  readonly code: 'init'
  readonly message: string
}> {}

/** Runner-facing view of one agent. Not part of the consumption contract. */
export interface AgentDriver {
  /** Reports the turn state. `whenIdle` resolves when the agent is idle with nothing pending. */
  setStatus(status: AgentStatus): Effect.Effect<void>
  /** Cause of the latest `cancel`, read by the turn finalizer when it records `turn/end`. */
  readonly cancelCause: AgentCancelCause | undefined
  /** Completes once per `followup`. A runner takes from it before starting a turn. */
  readonly wake: Queue.Queue<void>
}

export interface Agent {
  readonly id: SessionId
  readonly session: Session
  /** What the loop reads as it works: the options as they are now, not as they were created. */
  readonly options: AgentOptions
  readonly inbox: Inbox
  readonly status: AgentStatus
  /** Agent-scoped registrations live until the agent is disposed. */
  readonly scope: Scope.Scope
  readonly driver: AgentDriver
  /**
   * Switches the reasoning effort the loop asks the provider for. It lands on
   * the request after the switch; '' leaves the choice to the provider.
   */
  setEffort(effort: string): Effect.Effect<void>
  /**
   * Switches the route the loop asks, as `provider/model`. It lands on the
   * request after the switch, and the session keeps it until it is switched
   * again.
   */
  setRoute(route: string): Effect.Effect<void>
  /** Queues input for a new turn and wakes the runner. */
  followup(message: UserMessage): Effect.Effect<void, SessionError>
  /** Queues input for the next step boundary without waking an idle agent. */
  steer(message: UserMessage): Effect.Effect<void, SessionError>
  /** Queues input for the next request without waking an idle agent. */
  inject(message: UserMessage): Effect.Effect<void, SessionError>
  cancel(cause: AgentCancelCause): Effect.Effect<void>
  readonly whenIdle: Effect.Effect<void>
}

/** Runs turns for one agent. Started once, inside the agent's scope. */
export interface AgentRunner {
  run(agent: Agent): Effect.Effect<void>
}

export interface CreateAgentOptions {
  /** Events the child session starts from, e.g. a fork of the parent. */
  readonly seed?: ReadonlyArray<SessionEvent>
  readonly cwd: string
  readonly options: AgentOptions
  /** Resumes an existing session instead of creating one. */
  readonly resume?: SessionId
  /** The agent that started this one. Its cancel and dispose reach this child too. */
  readonly parent?: SessionId
}

export type AgentError = SessionError | AgentInitError

export interface AgentsShape {
  create(options: CreateAgentOptions): Effect.Effect<Agent, AgentError>
  get(id: SessionId): Agent | undefined
  list(): ReadonlyArray<Agent>
  /** The agents this one started, and only those. */
  childrenOf(id: SessionId): ReadonlyArray<Agent>
  dispose(id: SessionId): Effect.Effect<void>
  disposeAll(): Effect.Effect<void>
}
