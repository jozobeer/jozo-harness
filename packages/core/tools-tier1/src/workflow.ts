import { Schema, Effect } from 'effect'
import type { AgentsShape } from '@jozo-harness/agent'
import { forkSeed, type JsonValue } from '@jozo-harness/session'
import { childAnswerOf } from './child-answer.ts'
import { delegationRefusal, eventsOfAgent } from './delegation.ts'
import { ToolError, type ToolDefinition } from '@jozo-harness/tools'

/** How many children a workflow runs at once unless the caller says otherwise. */
export const WORKFLOW_CONCURRENCY = 4

const TaskSchema = Schema.Struct({
  id: Schema.String.annotate({ description: 'Names this task in the answer, and must be unique.' }),
  task: Schema.String.annotate({
    description: 'The whole task for the child, written as if the child sees nothing else.',
  }),
  cwd: Schema.optionalKey(
    Schema.String.annotate({
      description: 'The directory the child starts in. Defaults to this working directory.',
    }),
  ),
  expect: Schema.optionalKey(
    Schema.Literals(['text', 'json']).annotate({
      description: 'What the answer must read as; json makes an unreadable answer a failed item.',
    }),
  ),
})

const Parameters = Schema.Struct({
  tasks: Schema.Array(TaskSchema).annotate({
    description: 'The tasks to run at the same time, one child agent each.',
  }),
  concurrency: Schema.optionalKey(
    Schema.Int.annotate({ description: 'How many children to run at once. Defaults to 4.' }),
  ),
})

export type WorkflowArgs = Schema.Schema.Type<typeof Parameters>
export type WorkflowTask = Schema.Schema.Type<typeof TaskSchema>

/** One task's answer, or null when that task alone could not be read. */
export interface WorkflowItem {
  readonly id: string
  readonly value: JsonValue | null
  readonly error?: string
}

export interface WorkflowHost {
  readonly agents: AgentsShape
  readonly route: string
}

const failed = (id: string, error: string): WorkflowItem => ({ id, value: null, error })

/** An answer that had to be JSON and was not becomes a failed item, not a failed run. */
const parseAnswer = (id: string, answer: string): WorkflowItem => {
  try {
    return { id, value: JSON.parse(answer) as JsonValue }
  } catch {
    return failed(id, 'the answer is not JSON')
  }
}

/** Runs one task in its own child and reads the answer the way the task asked for it. */
const runTask = (
  host: WorkflowHost,
  task: WorkflowTask,
  cwd: string,
  parent: string,
): Effect.Effect<WorkflowItem> =>
  Effect.gen(function* () {
    // Both ways a child can fail to start are this item's failure, not the run's.
    const child = yield* host.agents
      .create({
        cwd: task.cwd ?? cwd,
        options: { route: host.route },
        seed: forkSeed(eventsOfAgent(host.agents, parent)),
        parent,
      })
      .pipe(Effect.orElseSucceed(() => undefined))
    if (child === undefined) return failed(task.id, 'cannot start a child agent')
    // followup answers void on success; false can only mean it refused the message.
    const queued = yield* child
      .followup({ text: task.task, source: 'user' })
      .pipe(Effect.orElseSucceed(() => false))
    if (queued === false) return failed(task.id, 'the child agent took no message')
    yield* child.whenIdle
    const answer = childAnswerOf(child)
    return task.expect === 'json' ? parseAnswer(task.id, answer) : { id: task.id, value: answer }
  })

const duplicateId = (tasks: ReadonlyArray<WorkflowTask>): string | undefined => {
  const seen = new Set<string>()
  for (const task of tasks) {
    if (seen.has(task.id)) return task.id
    seen.add(task.id)
  }
  return undefined
}

const renderItem = (item: WorkflowItem): string =>
  item.error === undefined
    ? item.id + ': ' + (typeof item.value === 'string' ? item.value : JSON.stringify(item.value))
    : item.id + ': (failed: ' + item.error + ')'

/**
 * Runs several child agents at the same time and answers with one item per task.
 * A task that fails is null in the answer rather than a failed call, so one bad
 * item cannot take the others down with it.
 */
export const makeWorkflowTool = (
  host: WorkflowHost,
): ToolDefinition<WorkflowArgs, ReadonlyArray<WorkflowItem>> => ({
  name: 'workflow',
  description:
    'Runs several child agents at once, one per task, and answers with one value per task. A task that fails is null with its reason while the others still answer. Use it to fan out work that needs none of this conversation.',
  parameters: Parameters,
  output: {
    schema: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        value: Schema.NullOr(Schema.Json),
        error: Schema.optionalKey(Schema.String),
      }),
    ),
    render: (_args, value) => [
      {
        type: 'text',
        text: value.length === 0 ? '(no tasks)' : value.map((item) => renderItem(item)).join('\n'),
      },
    ],
  },
  execute: (args, context) =>
    Effect.gen(function* () {
      const refused = delegationRefusal(host.agents, context.sessionId)
      if (refused !== undefined) return yield* Effect.fail(refused)
      const repeated = duplicateId(args.tasks)
      if (repeated !== undefined) {
        return yield* Effect.fail(
          new ToolError({
            code: 'invalid-arguments',
            message: 'two tasks name the same id: ' + repeated,
          }),
        )
      }
      if (args.tasks.length === 0) {
        return yield* Effect.fail(
          new ToolError({
            code: 'invalid-arguments',
            message: 'a workflow needs at least one task',
          }),
        )
      }
      const concurrency = Math.max(args.concurrency ?? WORKFLOW_CONCURRENCY, 1)
      // Each item decides its own fate; one failing child never fails the call.
      return yield* Effect.forEach(
        args.tasks,
        (task) => runTask(host, task, context.cwd, context.sessionId),
        { concurrency },
      )
    }),
})
