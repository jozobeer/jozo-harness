import {
  registerLogOnlySessionEvents,
  registerSessionEventSchemas,
  type SessionEvent,
  type SessionEventSchemaMap,
} from '@jozo-harness/session'
import type { ToolError, ToolRegistry, ToolRestriction } from '@jozo-harness/tools'
import { Effect, Schema, type Scope } from 'effect'

/** Which tools a session may use: plan mode hides the ones that change the workspace. */
export type PlanModeName = 'plan' | 'execute'

/** A change of plan mode, written so a resumed session starts where this one left. */
export interface PlanModeChanged {
  readonly mode: PlanModeName
}

declare module '@jozo-harness/session/events' {
  interface SessionEventMap {
    'plan/mode': PlanModeChanged
  }
}

// The mode is written, not the direction, so a reader does not have to know
// which way the event moved. Plan mode has no way back in, so only "execute"
// is written today.
const PlanModeChangedSchema = Schema.Struct({
  mode: Schema.Literals(['plan', 'execute']),
})

/** A schema for the session event that records plan mode. */
export const planModeEventSchemas: SessionEventSchemaMap = new Map<string, Schema.Schema<unknown>>([
  ['plan/mode', PlanModeChangedSchema],
])

registerSessionEventSchemas(planModeEventSchemas)
// The mode is harness state: the model learns it from the tools it is offered.
registerLogOnlySessionEvents(['plan/mode'])

/** The mode the log recorded last, or nothing when it never recorded one. */
export const currentPlanMode = (events: ReadonlyArray<SessionEvent>): PlanModeName | undefined => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'plan/mode') return event.data.mode
  }
  return undefined
}

/** Where plan mode starts and how it records a change. */
export interface PlanModeOptions {
  /** The mode the log recorded last; absent means the session never left plan mode. */
  readonly recorded?: PlanModeName
  /**
   * Writes the change where a resume can find it. The write happens before the
   * restriction lifts, so a failed write leaves the tools hidden rather than
   * letting the next run believe the plan was approved.
   */
  readonly record?: (mode: PlanModeName) => Effect.Effect<void, ToolError>
}

/** The tools plan mode leaves visible: reading, talking, and the way out. */
export const PLAN_MODE_TOOLS: ReadonlyArray<string> = [
  'read',
  'glob',
  'grep',
  'skill',
  'todo_write',
  'ask_user',
  'exit_plan_mode',
]

/** The word that answers yes to a question this harness asks about its own actions. */
export const APPROVAL_ANSWER = 'approve'
/** What the user answers to approve a plan; any other words keep plan mode. */
export const PLAN_APPROVAL = APPROVAL_ANSWER

/**
 * A restriction that hides every tool that could change the workspace while it is
 * active. Once the plan is approved the way out has nothing left to do, so it
 * goes too rather than asking the user to approve a plan already approved.
 */
export const planModeRestriction = (
  active: () => boolean,
  allowed: ReadonlyArray<string> = PLAN_MODE_TOOLS,
): ToolRestriction => ({
  name: 'plan-mode',
  allows: (tool) => (active() ? allowed.includes(tool) : tool !== 'exit_plan_mode'),
})

/**
 * Plan mode as one object. The restriction is registered once and consults this
 * object on every call, so the tool that ends plan mode can lift it while the
 * session keeps running: the next `schemas` and `call` see the workspace-changing
 * tools again.
 */
export interface PlanModeShape {
  /** Whether the workspace-changing tools are hidden right now. */
  readonly active: () => boolean
  /** Registers the restriction until the surrounding scope closes. */
  readonly install: (
    tools: ToolRegistry,
    allowed?: ReadonlyArray<string>,
  ) => Effect.Effect<void, never, Scope.Scope>
  /** Ends plan mode, recording the change before the restriction lifts. There is no way back in. */
  readonly leave: () => Effect.Effect<void, ToolError>
}

export const makePlanMode = (options: PlanModeOptions = {}): PlanModeShape => {
  let planning = options.recorded !== 'execute'
  return {
    active: () => planning,
    install: (tools, allowed = PLAN_MODE_TOOLS) =>
      tools.restrict(planModeRestriction(() => planning, allowed)),
    leave: () =>
      planning
        ? Effect.gen(function* () {
            if (options.record !== undefined) yield* options.record('execute')
            planning = false
          })
        : Effect.void,
  }
}
