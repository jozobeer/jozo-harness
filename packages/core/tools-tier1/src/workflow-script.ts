import type { AgentsShape, CreateAgentOptions } from '@jozo-harness/agent'
import type { SandboxShape } from '@jozo-harness/safety'
import { forkSeed, type JsonValue, type SessionEvent } from '@jozo-harness/session'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import { spawn, type Child } from '@jozo-harness/process'
import { Effect } from 'effect'
import { childAnswerOf } from './child-answer.ts'
import { eventsOfAgent } from './delegation.ts'

/**
 * How long a workflow script may run. Children outlive one model step, so this
 * is generous compared with run_code; a script that outlives it is ended and
 * its run is failed as a result, never as a broken turn.
 */
export const WORKFLOW_SCRIPT_TIMEOUT_MS = 10 * 60_000

/** How many children one script may start unless the call asks for another number. */
export const WORKFLOW_MAX_CHILDREN = 12

/** How much printed script output the answer keeps before it is cut. */
export const WORKFLOW_SCRIPT_OUTPUT_LIMIT = 16_000

/** What one spawn returned to the script: the child's answer and the tools it used. */
export interface WorkflowSpawnValue {
  readonly sessionId: string
  readonly text: string
  readonly tools: ReadonlyArray<{ readonly name: string; readonly summary?: string }>
}

/** One child a script started, named in the result so the conversation can open it. */
export interface WorkflowSpawnSummary {
  readonly step: number
  /** The label the script gave the spawn; '' when it named none. */
  readonly label: string
  readonly status: 'done' | 'failed'
  readonly sessionId?: string
  readonly reason?: string
}

/** One script run: its return value, or the stage that failed and why. */
export interface WorkflowScriptValue {
  readonly ok: boolean
  readonly output: string
  readonly children: number
  readonly value?: JsonValue
  readonly stage?: string
  readonly reason?: string
  /** The children the run started or tried to, in the order it asked for them. */
  readonly spawns?: ReadonlyArray<WorkflowSpawnSummary>
}

/** The host a workflow script runs against. The child agents are started the same way subagent starts them. */
export interface WorkflowScriptHost {
  readonly agents: AgentsShape
  readonly route: string
  /** The boundary the script's own process runs in; absent leaves it unconfined. */
  readonly sandbox?: SandboxShape
  /** A shorter deadline for tests; production uses WORKFLOW_SCRIPT_TIMEOUT_MS. */
  readonly timeoutMs?: number
}

export interface WorkflowScriptContext {
  readonly sessionId: string
  readonly cwd: string
}

/** The line prefix the child uses for its own messages; a line without it is script output. */
const RECORD = '\u001e'

interface ScriptCall {
  readonly t: 'call'
  readonly id: number
  readonly name: string
  readonly args: { readonly task?: unknown; readonly label?: unknown; readonly cwd?: unknown }
}

interface ScriptFinal {
  readonly t: 'final'
  readonly hasValue?: boolean
  readonly value?: unknown
  readonly error?: string
}

type ScriptMessage = ScriptCall | ScriptFinal

/**
 * The program that runs in the child. It receives the body of an async function
 * whose only binding is `workflow.spawn(task, options?)`; a spawn is a request
 * to the parent, which starts the child through the same agent path as subagent.
 * Keeping the child process to this protocol is what lets the script run inside
 * the run's sandbox without touching the filesystem or process table itself.
 */
export const WORKFLOW_SCRIPT_BOOTSTRAP = String.raw`
const createInterface = require('node:readline').createInterface
const RS = '\u001e'
let nextId = 1
const waiting = new Map()
const send = (message) => process.stdout.write(RS + JSON.stringify(message) + '\n')
const encode = (value) => {
  if (value === undefined) return undefined
  try { return JSON.parse(JSON.stringify(value)) } catch { return String(value) }
}
const ask = (name, args) => new Promise((resolve, reject) => {
  const id = nextId++
  waiting.set(id, { resolve, reject })
  send({ t: 'call', id, name, args })
})
const workflow = {
  spawn: (task, options = {}) => ask('spawn', { task, ...options }),
}
const execute = async (config) => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  try {
    const body = new AsyncFunction('workflow', config.code)
    const value = await body(workflow)
    send({ t: 'final', hasValue: value !== undefined, value: encode(value) })
  } catch (error) {
    send({ t: 'final', error: String(error && error.stack ? error.stack : error) })
  }
}
let booted = false
createInterface({ input: process.stdin }).on('line', (line) => {
  if (!booted) { booted = true; execute(JSON.parse(line)); return }
  const message = JSON.parse(line)
  const waiter = waiting.get(message.id)
  if (waiter === undefined) return
  waiting.delete(message.id)
  if (message.ok) waiter.resolve(message.value)
  else waiter.reject(new Error(message.error))
})
`

/** The argv of the child that runs a workflow script. */
export const workflowScriptArgv = (): ReadonlyArray<string> => [
  process.execPath,
  '-e',
  WORKFLOW_SCRIPT_BOOTSTRAP,
]

/** Collects script output up to the limit, then only remembers that it was cut. */
const makeOutput = (
  limit: number,
): { readonly write: (text: string) => void; readonly text: () => string } => {
  const parts: Array<string> = []
  let size = 0
  let truncated = false
  return {
    write: (text) => {
      if (truncated) return
      const room = limit - size
      if (text.length <= room) {
        parts.push(text)
        size += text.length
        return
      }
      parts.push(text.slice(0, Math.max(0, room)))
      size = limit
      truncated = true
    },
    text: () => {
      const output = parts.join('')
      return truncated
        ? output + '\n[output truncated after ' + String(limit) + ' characters]'
        : output
    },
  }
}

/** The one-line result of each finished call, by the call it belongs to. */
const resultSummaries = (events: ReadonlyArray<SessionEvent>): ReadonlyMap<string, string> =>
  new Map(
    events.flatMap((event) =>
      event.type === 'tool/result' && event.data.summary !== undefined
        ? [[event.data.callId, event.data.summary] as const]
        : [],
    ),
  )

/** The tool calls a child made after it started, with the one-line results the log already keeps. */
const toolCallsOf = (
  events: ReadonlyArray<SessionEvent>,
): ReadonlyArray<{ readonly name: string; readonly summary?: string }> => {
  const results = resultSummaries(events)
  return events.flatMap((event) => {
    if (event.type !== 'tool/call') return []
    const summary = results.get(event.data.callId)
    return [{ name: event.data.name, ...(summary === undefined ? {} : { summary }) }]
  })
}

/** The stage a spawn names in a failure, so the reader can tell which call stopped the script. */
const stageOf = (number: number, label: unknown): string =>
  'spawn ' + String(number) + (typeof label === 'string' && label !== '' ? ' (' + label + ')' : '')

/** The failure a result carries, if any. */
interface Failure {
  readonly stage: string
  readonly reason: string
}

/** Why this spawn may not run, before any child is started; the first such refusal is the run's failure. */
const spawnFailure = (
  call: ScriptCall,
  count: { children: number },
  limit: number,
  failure: { current: Failure | undefined },
): Failure | undefined => {
  const stage = stageOf(count.children + 1, call.args.label)
  if (failure.current !== undefined) {
    return {
      stage,
      reason: 'the workflow already failed at ' + failure.current.stage,
    }
  }
  if (typeof call.args.task !== 'string' || call.args.task === '') {
    failure.current = { stage, reason: 'spawn needs a non-empty task' }
    return failure.current
  }
  if (count.children >= limit) {
    failure.current = {
      stage,
      reason: 'the script asked for more than ' + String(limit) + ' children',
    }
    return failure.current
  }
  return undefined
}

/** The last turn the child closed, which says whether it answered or failed. */
const lastTurnEnd = (events: ReadonlyArray<SessionEvent>) => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'turn/end') return event
  }
  return undefined
}

/** Why the child's turn failed, when it ended without an answer worth reading. */
const childFailureOf = (events: ReadonlyArray<SessionEvent>): string | undefined => {
  const reason = lastTurnEnd(events)?.data.reason
  if (reason === undefined) return undefined
  if (reason.kind === 'error') return reason.failure.message
  return reason.kind === 'cancelled' || reason.kind === 'interrupted' ? reason.kind : undefined
}

/** The label a spawn names itself by; '' when it names none. */
const labelOf = (call: ScriptCall): string =>
  typeof call.args.label === 'string' ? call.args.label : ''

/** How one spawn starts its child: the same arguments subagent uses. */
const createOf = (
  call: ScriptCall,
  host: WorkflowScriptHost,
  context: WorkflowScriptContext,
): CreateAgentOptions => ({
  cwd: typeof call.args.cwd === 'string' ? call.args.cwd : context.cwd,
  options: { route: host.route },
  seed: forkSeed(eventsOfAgent(host.agents, context.sessionId)),
  parent: context.sessionId,
})

/** Writes one child into the run, so the result can name it and where it ran. */
const recordSpawn = (
  run: ScriptRun,
  call: ScriptCall,
  step: number,
  status: 'done' | 'failed',
  sessionId: string | undefined,
  reason: string | undefined,
): void => {
  run.spawns.push({
    step,
    label: labelOf(call),
    status,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(reason === undefined ? {} : { reason }),
  })
}

/** Answers one spawn with the child's answer, or with the reason it could not run. */
const answerSpawn = async (
  call: ScriptCall,
  child: Child,
  host: WorkflowScriptHost,
  context: WorkflowScriptContext,
  run: ScriptRun,
  limit: number,
): Promise<void> => {
  const { count } = run
  const reply = (ok: boolean, body: { value?: WorkflowSpawnValue; error?: string }): void => {
    try {
      child.stdin.write(JSON.stringify({ t: 'result', id: call.id, ...body, ok }) + '\n')
    } catch {
      // The script process is gone; its outcome no longer has a reader.
    }
  }
  // A child that failed after it started still has a session the node can open.
  const fail = (stage: string, reason: string, sessionId?: string): void => {
    run.failure.current = { stage, reason }
    recordSpawn(run, call, count.children, 'failed', sessionId, reason)
    reply(false, { error: reason })
  }
  const unstartable = spawnFailure(call, count, limit, run.failure)
  if (unstartable !== undefined) {
    recordSpawn(run, call, count.children + 1, 'failed', undefined, unstartable.reason)
    reply(false, { error: unstartable.reason })
    return
  }
  const stage = stageOf(count.children + 1, call.args.label)
  const task = typeof call.args.task === 'string' ? call.args.task : ''
  count.children += 1
  const created = await Effect.runPromise(
    host.agents.create(createOf(call, host, context)).pipe(Effect.orElseSucceed(() => undefined)),
  )
  if (created === undefined) {
    fail(stage, 'cannot start a child agent')
    return
  }
  const before = created.session.events().length
  const queued = await Effect.runPromise(
    created.followup({ text: task, source: 'user' }).pipe(Effect.orElseSucceed(() => false)),
  )
  if (queued === false) {
    fail(stage, 'the child agent took no message', created.id)
    return
  }
  const idle = await Effect.runPromise(
    created.whenIdle.pipe(
      Effect.match({
        onFailure: () => false,
        onSuccess: () => true,
      }),
    ),
  )
  if (!idle) {
    fail(stage, 'the child agent did not become idle', created.id)
    return
  }
  const answered = created.session.events().slice(before)
  const childFailure = childFailureOf(answered)
  if (childFailure !== undefined) {
    fail(stage, 'the child agent failed: ' + childFailure, created.id)
    return
  }
  recordSpawn(run, call, count.children, 'done', created.id, undefined)
  reply(true, {
    value: {
      sessionId: created.id,
      text: childAnswerOf(created),
      tools: toolCallsOf(answered),
    },
  })
}

/** What a script run has collected while its lines arrive. */
interface ScriptRun {
  readonly output: ReturnType<typeof makeOutput>
  readonly failure: { current: Failure | undefined }
  readonly count: { children: number }
  /** The children reached so far, in the order the script asked for them. */
  readonly spawns: Array<WorkflowSpawnSummary>
  timedOut: boolean
}

/** Reads the script's lines, handing each spawn to the caller and stopping at the final message. */
const consumeScript = async (
  lines: AsyncIterable<string>,
  run: ScriptRun,
  onCall: (call: ScriptCall) => void,
): Promise<ScriptFinal | undefined> => {
  for await (const line of lines) {
    const at = line.indexOf(RECORD)
    if (at < 0) {
      run.output.write(line + '\n')
      continue
    }
    if (at > 0) run.output.write(line.slice(0, at))
    const message = JSON.parse(line.slice(at + RECORD.length)) as ScriptMessage
    if (message.t !== 'call') return message
    onCall(message)
  }
  return undefined
}

/** The first stage that failed, in the order the run reads them. */
const scriptFailure = (
  run: ScriptRun,
  final: ScriptFinal | undefined,
  exitCode: number,
  detail: string,
  timeoutMs: number,
): Failure | undefined => {
  if (run.timedOut) {
    return {
      stage: 'timeout',
      reason: 'the script did not finish within ' + String(timeoutMs) + 'ms',
    }
  }
  if (run.failure.current !== undefined) return run.failure.current
  if (final === undefined) {
    return {
      stage: 'script',
      reason:
        'the script process ended with code ' +
        String(exitCode) +
        (detail === '' ? '' : ': ' + detail),
    }
  }
  return final.error === undefined
    ? undefined
    : { stage: 'script', reason: 'the script raised: ' + final.error }
}

/** What the call answers: the script's value, or the stage that failed. */
const scriptOutcome = (
  run: ScriptRun,
  final: ScriptFinal | undefined,
  exitCode: number,
  detail: string,
  timeoutMs: number,
): WorkflowScriptValue => {
  const base = {
    output: run.output.text(),
    children: run.count.children,
    ...(run.spawns.length === 0 ? {} : { spawns: run.spawns }),
  }
  const failure = scriptFailure(run, final, exitCode, detail, timeoutMs)
  if (failure !== undefined) {
    return { ...base, ok: false, stage: failure.stage, reason: failure.reason }
  }
  return {
    ...base,
    ok: true,
    ...(final?.hasValue === true && final.value !== undefined
      ? { value: final.value as JsonValue }
      : {}),
  }
}

/** Runs one script process to its final message, spawning children on the way. */
const runScriptSession = async (
  child: Child,
  code: string,
  host: WorkflowScriptHost,
  context: WorkflowScriptContext,
  limit: number,
): Promise<WorkflowScriptValue> => {
  const run: ScriptRun = {
    output: makeOutput(WORKFLOW_SCRIPT_OUTPUT_LIMIT),
    failure: { current: undefined },
    count: { children: 0 },
    spawns: [],
    timedOut: false,
  }
  const timeoutMs = host.timeoutMs ?? WORKFLOW_SCRIPT_TIMEOUT_MS
  const timer = setTimeout(() => {
    run.timedOut = true
    child.kill()
  }, timeoutMs)
  const stderr = new Response(child.stderr).text()
  child.stdin.write(JSON.stringify({ code }) + '\n')
  const lines = createInterface({ input: Readable.fromWeb(child.stdout) })
  const final = await consumeScript(lines, run, (call) => {
    // A spawn runs while the script keeps reading, so Promise.all in a script
    // starts children at the same time instead of one after another.
    void answerSpawn(call, child, host, context, run, limit).catch(() => undefined)
  })
  clearTimeout(timer)
  child.kill()
  const exitCode = await child.exited
  const detail = (await stderr).slice(0, 2_000)
  return scriptOutcome(run, final, exitCode, detail, timeoutMs)
}

/**
 * Runs a model-written script that can start child agents. The script process is
 * wrapped by the run's sandbox exactly as run_code's is, and every spawn reaches
 * the agent registry, so the child gets the same sandbox and approvals as one
 * started by subagent. Failures come back as the value of the call, never as a
 * failed workflow, so a bad script cannot take the parent turn down.
 */
export const runWorkflowScript = async (
  host: WorkflowScriptHost,
  context: WorkflowScriptContext,
  args: { readonly code: string; readonly maxChildren?: number },
): Promise<WorkflowScriptValue> => {
  const limit = Math.max(args.maxChildren ?? WORKFLOW_MAX_CHILDREN, 1)
  const base = { argv: workflowScriptArgv(), cwd: context.cwd }
  const wrapped:
    | { readonly command: { readonly argv: ReadonlyArray<string>; readonly cwd: string } }
    | { readonly failure: string } =
    host.sandbox === undefined
      ? { command: base }
      : await Effect.runPromise(
          host.sandbox.wrap({ argv: base.argv, cwd: base.cwd, mode: host.sandbox.mode }).pipe(
            Effect.mapError((error) => error.message),
            Effect.match({
              onFailure: (message) => ({ failure: message }),
              onSuccess: (command) => ({ command }),
            }),
          ),
        )
  if ('failure' in wrapped) {
    return {
      ok: false,
      output: '',
      children: 0,
      stage: 'sandbox',
      reason: 'sandbox: ' + wrapped.failure,
    }
  }
  let child: Child
  try {
    child = spawn(wrapped.command.argv, {
      cwd: wrapped.command.cwd,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch (error) {
    return {
      ok: false,
      output: '',
      children: 0,
      stage: 'runtime',
      reason: 'cannot start the script process: ' + String(error),
    }
  }
  try {
    return await runScriptSession(child, args.code, host, context, limit)
  } catch (error) {
    return {
      ok: false,
      output: '',
      children: 0,
      stage: 'script',
      reason: 'the script process could not be read: ' + String(error),
    }
  } finally {
    child.kill()
  }
}
