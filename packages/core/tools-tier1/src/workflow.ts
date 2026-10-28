import { Schema, Effect } from 'effect'
import type { AgentsShape } from '@jozo-harness/agent'
import { forkSeed, type JsonValue } from '@jozo-harness/session'
import { childAnswerOf } from './child-answer.ts'
import { delegationRefusal, eventsOfAgent } from './delegation.ts'
import {
  runWorkflowScript,
  WORKFLOW_MAX_CHILDREN,
  type WorkflowScriptHost,
  type WorkflowScriptValue,
  type WorkflowSpawnSummary,
} from './workflow-script.ts'
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
  tasks: Schema.optionalKey(
    Schema.Array(TaskSchema).annotate({
      description: 'The tasks to run at the same time, one child agent each.',
    }),
  ),
  script: Schema.optionalKey(
    Schema.String.annotate({
      description:
        'The body of an async JavaScript function. It receives `workflow` and calls `await workflow.spawn(task, options?)`; each spawn starts one child agent and resolves to its final text and tool summaries. Use it for loops and stages that depend on earlier answers. Runs in the same sandbox as run_code.',
    }),
  ),
  concurrency: Schema.optionalKey(
    Schema.Int.annotate({
      description: 'How many children to run at once when tasks are given. Defaults to 4.',
    }),
  ),
  maxChildren: Schema.optionalKey(
    Schema.Int.annotate({
      description:
        'How many children a script may start. Defaults to ' +
        String(WORKFLOW_MAX_CHILDREN) +
        '; the spawn past the limit fails the run at that stage.',
    }),
  ),
})

export type WorkflowArgs = Schema.Schema.Type<typeof Parameters>
export type WorkflowTask = Schema.Schema.Type<typeof TaskSchema>

/** One task's answer, or null when that task alone could not be read. */
export interface WorkflowItem {
  readonly id: string
  readonly value: JsonValue | null
  readonly error?: string
  /** The child that ran the task, so the conversation can open its session. */
  readonly sessionId?: string
}

/** What a workflow answers: one item per task, or what the script returned. */
export type WorkflowValue = ReadonlyArray<WorkflowItem> | WorkflowScriptValue

export interface WorkflowHost extends WorkflowScriptHost {
  readonly agents: AgentsShape
  readonly route: string
}

const failed = (id: string, error: string, sessionId?: string): WorkflowItem => ({
  id,
  value: null,
  error,
  ...(sessionId === undefined ? {} : { sessionId }),
})

/** An answer that had to be JSON and was not becomes a failed item, not a failed run. */
const parseAnswer = (id: string, answer: string, sessionId: string): WorkflowItem => {
  try {
    return { id, value: JSON.parse(answer) as JsonValue, sessionId }
  } catch {
    return failed(id, 'the answer is not JSON', sessionId)
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
    if (queued === false) {
      return failed(task.id, 'the child agent took no message', child.id)
    }
    yield* child.whenIdle
    const answer = childAnswerOf(child)
    return task.expect === 'json'
      ? parseAnswer(task.id, answer, child.id)
      : { id: task.id, value: answer, sessionId: child.id }
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

/** One child as the result names it: what it was called, how it went, and where it ran. */
interface ChildLine {
  readonly name: string
  readonly status: 'done' | 'failed'
  readonly sessionId?: string
  readonly reason?: string
}

/**
 * The trailing block that names every child and its session. The answers above
 * stay as they were; this block is what lets the conversation draw a node whose
 * rows open a child's own session.
 */
const renderChildren = (children: ReadonlyArray<ChildLine>): ReadonlyArray<string> =>
  children.length === 0
    ? []
    : [
        '',
        'child sessions:',
        ...children.map(
          (child) =>
            child.name +
            ': ' +
            child.status +
            (child.reason === undefined ? '' : ' (' + child.reason + ')') +
            (child.sessionId === undefined ? '' : ' [child session: ' + child.sessionId + ']'),
        ),
      ]

/** One task item as the child block reads it. */
const lineOf = (item: WorkflowItem): ChildLine => ({
  name: item.id,
  status: item.error === undefined ? 'done' : 'failed',
  ...(item.error === undefined ? {} : { reason: item.error }),
  ...(item.sessionId === undefined ? {} : { sessionId: item.sessionId }),
})

/** One spawn as the child block reads it; an unnamed spawn goes by its step. */
const spawnLineOf = (spawn: WorkflowSpawnSummary): ChildLine => ({
  name: spawn.label === '' ? 'spawn ' + String(spawn.step) : spawn.label,
  status: spawn.status,
  ...(spawn.reason === undefined ? {} : { reason: spawn.reason }),
  ...(spawn.sessionId === undefined ? {} : { sessionId: spawn.sessionId }),
})

/** Tells a script answer apart from the task array without reading either shape. */
const isScriptValue = (value: WorkflowValue): value is WorkflowScriptValue => !Array.isArray(value)

const renderScript = (value: WorkflowScriptValue): string => {
  const head = value.ok
    ? 'workflow script: ok'
    : 'workflow script failed at ' + (value.stage ?? 'script') + ': ' + (value.reason ?? 'unknown')
  const lines = [
    head,
    'children: ' + String(value.children),
    ...(value.output === '' ? [] : ['output:', value.output.trimEnd()]),
    ...(value.value === undefined ? [] : ['return: ' + JSON.stringify(value.value)]),
    ...renderChildren((value.spawns ?? []).map(spawnLineOf)),
  ]
  return lines.join('\n')
}

const invalid = (message: string): ToolError =>
  new ToolError({ code: 'invalid-arguments', message })

/**
 * Runs several child agents at the same time and answers with one item per task,
 * or runs a model-written script that starts children one stage at a time and
 * reads their answers. A task or child that fails is null in the answer rather
 * than a failed call, so one bad item cannot take the others down with it.
 */
export const makeWorkflowTool = (
  host: WorkflowHost,
): ToolDefinition<WorkflowArgs, WorkflowValue> => ({
  name: 'workflow',
  description:
    'Runs child agents and answers with what they said. With tasks it fans out one child per task and answers one value per task. With script it runs a JavaScript body that calls `await workflow.spawn(task, options?)` and chooses the next child from the answers, for loops and stages that depend on each other. A task or script failure comes back as a failed result, not a broken call. Scripts that go past maxChildren or the deadline fail at that stage.',
  parameters: Parameters,
  output: {
    schema: Schema.Union([
      Schema.Array(
        Schema.Struct({
          id: Schema.String,
          value: Schema.NullOr(Schema.Json),
          error: Schema.optionalKey(Schema.String),
          sessionId: Schema.optionalKey(Schema.String),
        }),
      ),
      Schema.Struct({
        ok: Schema.Boolean,
        output: Schema.String,
        children: Schema.Int,
        value: Schema.optionalKey(Schema.Json),
        stage: Schema.optionalKey(Schema.String),
        reason: Schema.optionalKey(Schema.String),
        spawns: Schema.optionalKey(
          Schema.Array(
            Schema.Struct({
              step: Schema.Int,
              label: Schema.String,
              status: Schema.Literals(['done', 'failed']),
              sessionId: Schema.optionalKey(Schema.String),
              reason: Schema.optionalKey(Schema.String),
            }),
          ),
        ),
      }),
    ]),
    render: (_args, value) => [
      {
        type: 'text',
        text: isScriptValue(value)
          ? renderScript(value)
          : value.length === 0
            ? '(no tasks)'
            : [
                value.map((item) => renderItem(item)).join('\n'),
                ...renderChildren(value.map(lineOf)),
              ].join('\n'),
      },
    ],
  },
  execute: (args, context) =>
    Effect.gen(function* () {
      const refused = delegationRefusal(host.agents, context.sessionId)
      if (refused !== undefined) return yield* Effect.fail(refused)
      if ((args.tasks === undefined) === (args.script === undefined)) {
        return yield* Effect.fail(invalid('a workflow needs either tasks or script, and not both'))
      }
      if (args.script !== undefined) {
        return yield* Effect.promise(() =>
          runWorkflowScript(
            host,
            { sessionId: context.sessionId, cwd: context.cwd },
            {
              code: args.script ?? '',
              ...(args.maxChildren === undefined ? {} : { maxChildren: args.maxChildren }),
            },
          ),
        )
      }
      const tasks = args.tasks ?? []
      const repeated = duplicateId(tasks)
      if (repeated !== undefined) {
        return yield* Effect.fail(invalid('two tasks name the same id: ' + repeated))
      }
      if (tasks.length === 0) {
        return yield* Effect.fail(invalid('a workflow needs at least one task'))
      }
      const concurrency = Math.max(args.concurrency ?? WORKFLOW_CONCURRENCY, 1)
      // Each item decides its own fate; one failing child never fails the call.
      return yield* Effect.forEach(
        tasks,
        (task) => runTask(host, task, context.cwd, context.sessionId),
        { concurrency },
      )
    }),
})
