import type { ToolSchema } from '@jozo-harness/llm'
import type { SandboxShape } from '@jozo-harness/safety'
import { stripTypeScriptTypes } from 'node:module'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import { spawn, type Child } from '@jozo-harness/process'
import {
  registerLogOnlySessionEvents,
  registerSessionEventSchemas,
  type SessionEventMap,
  type SessionEventSchemaMap,
} from '@jozo-harness/session'
import {
  resultSummary,
  ToolError,
  type ToolDefinition,
  type ToolExecutionResult,
  type ToolRunContext,
} from '@jozo-harness/tools'
import { Effect, Schema, type Scope } from 'effect'

/**
 * How long a program may run. The tool pipeline ends a call that outlives this
 * and the finalizer kills the child, so a loop that never returns cannot hold
 * the turn.
 */
export const RUN_CODE_TIMEOUT_MS = 30_000

/**
 * How much output the conversation takes back. A program that prints more is
 * cut and told so, rather than flooding the next step with its own transcript.
 */
export const RUN_CODE_OUTPUT_LIMIT = 16_000

/** What the child's own messages look like on stdout. A line without the prefix is program output. */
const RECORD = '\u001e'

/** A nested call a program made, as the log records it when the call starts. */
export interface PtcDispatchStartData {
  /** The `run_code` call's id plus the program's call number, so a nested id never collides with a direct one. */
  readonly callId: string
  readonly name: string
  /** The JSON the program passed, before the tool decoded it. */
  readonly arguments: string
}

/** A nested call that settled, in the vocabulary a direct `tool/result` uses. */
export interface PtcDispatchData extends PtcDispatchStartData {
  readonly isError: boolean
  /** The one line a reader sees, rendered from the result's content. */
  readonly summary: string
}

declare module '@jozo-harness/session/events' {
  interface SessionEventMap {
    'tool/ptc-dispatch-start': PtcDispatchStartData
    'tool/ptc-dispatch': PtcDispatchData
  }
}

const PtcDispatchStartSchema = Schema.Struct({
  callId: Schema.String,
  name: Schema.String,
  arguments: Schema.String,
})

const PtcDispatchSchema = Schema.Struct({
  callId: Schema.String,
  name: Schema.String,
  arguments: Schema.String,
  isError: Schema.Boolean,
  summary: Schema.String,
})

/** Schemas for the nested-call events this module writes. */
export const ptcDispatchEventSchemas: SessionEventSchemaMap = new Map<
  string,
  Schema.Schema<unknown>
>([
  ['tool/ptc-dispatch-start', PtcDispatchStartSchema],
  ['tool/ptc-dispatch', PtcDispatchSchema],
])

registerSessionEventSchemas(ptcDispatchEventSchemas)
// The model reads a nested result from the program's return value, never as its own message.
registerLogOnlySessionEvents(['tool/ptc-dispatch-start', 'tool/ptc-dispatch'])

/** What a program may write about a nested call: its start and its settlement. */
export type PtcDispatchEventType = 'tool/ptc-dispatch-start' | 'tool/ptc-dispatch'

/** The host a program runs against: what it may call, and how a call reaches the registry. */
export interface RunCodeHost {
  /** The declarations of the tools the program may call. `run_code` itself never appears. */
  readonly tools: () => ReadonlyArray<ToolSchema>
  /** Runs one nested call through the same registry, policy, and hooks as a direct call. */
  readonly call: (
    name: string,
    argumentsJson: string,
    context: ToolRunContext,
  ) => Effect.Effect<ToolExecutionResult>
  /** Writes one nested-call event, so what a program did survives the process that did it. */
  readonly append: <K extends PtcDispatchEventType>(
    type: K,
    data: SessionEventMap[K],
  ) => Effect.Effect<void, unknown>
  /** The sandbox the child runs under. Absent leaves the child unconfined. */
  readonly sandbox?: SandboxShape
  /** The children this run keeps; absent leaves the tool to end its own. */
  readonly sessions?: RunCodeSessions
}

const Parameters = Schema.Struct({
  code: Schema.String.annotate({
    description:
      'The body of an async JavaScript function. Call another tool as `await tools.name(args)`; the resolved value is the tool result. Use `return` for what the model should read, with `console.log` for progress.',
  }),
  runtime: Schema.optionalKey(
    Schema.Literals(['node', 'python']).annotate({
      description:
        'Which runtime runs the code. Defaults to node. python runs the body as a python3 script, where a tool call is tools.name(...) and print is the output.',
    }),
  ),
})

export type RunCodeRuntime = 'node' | 'python'

export interface RunCodeValue {
  /** The program's printed output, then its returned value when it returned one. */
  readonly output: string
  readonly truncated: boolean
  readonly toolCalls: number
}

const Output = Schema.Struct({
  output: Schema.String,
  truncated: Schema.Boolean,
  toolCalls: Schema.Int,
})

interface ProtocolCall {
  readonly t: 'call'
  readonly rid: number
  readonly id: number
  readonly name: string
  readonly args: unknown
}

interface ProtocolFinal {
  readonly t: 'final'
  readonly rid: number
  readonly hasValue?: boolean
  readonly value?: unknown
  readonly error?: string
}

type ProtocolMessage = ProtocolCall | ProtocolFinal

/**
 * The program that runs in the child. It reads run lines until stdin closes and
 * answers call requests between them. The child outlives a call, so what a
 * program put on `globalThis` is still there when the session runs the next one.
 * Program output goes to stdout unprefixed, so the parent can tell it apart from
 * its own records without wrapping `console.log`.
 */
const BOOTSTRAP = String.raw`
const createInterface = require('node:readline').createInterface
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const RS = '\u001e'
const pending = new Map()
let nextId = 1
const emit = (message) => process.stdout.write(RS + JSON.stringify(message) + '\n')
const serialized = (value) => {
  if (value === undefined) return undefined
  try { return JSON.parse(JSON.stringify(value)) } catch { return String(value) }
}
const toolsOf = (names, rid) => {
  const built = Object.create(null)
  for (const name of names) {
    built[name] = (args = {}) => new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(rid + ':' + id, (message) => message.ok ? resolve(message.value) : reject(new Error(message.error)))
      emit({ t: 'call', rid, id, name, args })
    })
  }
  return built
}
const run = async (config) => {
  const rid = config.rid
  nextId = 1
  try {
    // The parent already removed the type annotations; the program is an async
    // arrow body, so its own return and await stay at its top level.
    const body = new AsyncFunction('tools', 'return await (' + config.code + ').call(globalThis)')
    const value = await body(toolsOf(config.tools, rid))
    emit({ t: 'final', rid, hasValue: value !== undefined, value: serialized(value) })
  } catch (error) {
    emit({ t: 'final', rid, error: String(error && error.stack ? error.stack : error) })
  }
}
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.t === 'run') { run(message); return }
  const key = message.rid + ':' + message.id
  const settle = pending.get(key)
  if (settle !== undefined) { pending.delete(key); settle(message) }
})
`

/**
 * The program that runs in the child when the runtime is python. It speaks the
 * same one-line-of-JSON protocol as the node bootstrap, and keeps one namespace
 * for the session, so a name a previous program bound is still there. A tool
 * call is synchronous: the body waits on stdin while the parent runs the tool,
 * and the answer becomes the call's value or exception.
 */
const PYTHON_BOOTSTRAP = String.raw`
import json, sys, traceback
RS = chr(30)
def read_message():
    line = sys.stdin.readline()
    if line == '':
        raise RuntimeError('run_code ended before the tool call was answered')
    return json.loads(line)
class Tools:
    def __init__(self, names, rid):
        self._names = set(names)
        self._rid = rid
        self._next_id = 1
    def __getattr__(self, name):
        if name not in self._names:
            raise AttributeError(name)
        def call(**args):
            call_id = self._next_id
            self._next_id += 1
            sys.stdout.write(RS + json.dumps({'t': 'call', 'rid': self._rid, 'id': call_id, 'name': name, 'args': args}) + '\n')
            sys.stdout.flush()
            message = read_message()
            if not message.get('ok'):
                raise RuntimeError(message.get('error') or 'tool ' + name + ' failed')
            return message.get('value')
        return call
namespace = {}
while True:
    line = sys.stdin.readline()
    if line == '':
        break
    config = json.loads(line)
    if config.get('t') != 'run':
        continue
    rid = config.get('rid')
    namespace['tools'] = Tools(config.get('tools') or [], rid)
    try:
        exec(compile(config.get('code') or '', '<run_code>', 'exec'), namespace, namespace)
        message = {'t': 'final', 'rid': rid}
    except Exception:
        message = {'t': 'final', 'rid': rid, 'error': traceback.format_exc()}
    sys.stdout.write(RS + json.dumps(message) + '\n')
    sys.stdout.flush()
`

const textOf = (result: ToolExecutionResult): string =>
  result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')

interface Sink {
  append(text: string): void
  /** The output with the truncation marker, when the limit was reached. */
  finish(): { readonly output: string; readonly truncated: boolean }
}

/** Collects program output up to the limit, then only remembers that it was cut. */
const makeSink = (limit: number): Sink => {
  let output = ''
  let truncated = false
  const append = (text: string): void => {
    if (truncated) return
    const room = limit - output.length
    if (text.length <= room) {
      output += text
      return
    }
    output += text.slice(0, Math.max(0, room))
    truncated = true
  }
  const finish = () => ({
    output: truncated
      ? output + '\n[output truncated after ' + String(limit) + ' characters]'
      : output,
    truncated,
  })
  return { append, finish }
}

const parseRecord = (line: string): ProtocolMessage =>
  JSON.parse(line.slice(RECORD.length)) as ProtocolMessage

interface SplitLine {
  /** Program output that shared the line with the record. */
  readonly output: string
  readonly record: string | undefined
}

/** Splits output that lacked a newline from the record that followed it. */
const splitLine = (line: string): SplitLine => {
  const index = line.indexOf(RECORD)
  if (index < 0) return { output: line, record: undefined }
  return { output: line.slice(0, index), record: line.slice(index) }
}

/** What the program reads back from one tool call it made. */
interface ProtocolResult {
  readonly ok: boolean
  readonly value: unknown
  readonly error: string
}

interface WorkerRun {
  readonly rid: number
  readonly sink: Sink
  readonly answer: (call: ProtocolCall) => Promise<ProtocolResult>
  readonly resolve: (final: ProtocolFinal | undefined) => void
}

/**
 * One child that keeps a session's program state between calls. It is started on
 * the first call and replaced only when it dies or has to be killed.
 */
export interface SessionWorker {
  /** Sends one program and settles with its final record, or undefined when the child ended. */
  readonly run: (
    code: string,
    tools: ReadonlyArray<string>,
    handlers: {
      readonly sink: Sink
      readonly answer: (call: ProtocolCall) => Promise<ProtocolResult>
    },
  ) => Promise<ProtocolFinal | undefined>
  /** Whether the child is still there to run another program. */
  readonly alive: () => boolean
  /** Ends the child; no program runs in it afterwards. */
  readonly kill: () => void
  /** The child's exit code, once it stopped. */
  readonly exited: Promise<number>
  /** The child's stderr, read once it stopped. */
  readonly stderr: () => Promise<string>
}

/**
 * Routes one stdout line to the run in flight: program output, a tool call, or
 * the final record. A child that writes something unreadable fails the run
 * rather than holding it open.
 */
const routeLine = (
  running: WorkerRun,
  line: string,
  onCall: (call: ProtocolCall) => void,
  onFinal: (final: ProtocolFinal) => void,
): void => {
  const split = splitLine(line)
  if (split.record === undefined) {
    running.sink.append(line + '\n')
    return
  }
  if (split.output !== '') running.sink.append(split.output)
  let message: ProtocolMessage
  try {
    message = parseRecord(split.record)
  } catch (error) {
    onFinal({ t: 'final', rid: running.rid, error: 'unreadable record: ' + String(error) })
    return
  }
  if (message.t === 'call') {
    if (message.rid === running.rid) onCall(message)
    return
  }
  if (message.rid === running.rid) onFinal(message)
}

/**
 * Wraps a started child in the line protocol. Output and records share stdout,
 * so a line is split at the record marker; a call is answered in order, and the
 * final record of the run in flight settles that call.
 */
const makeWorker = (child: Child): SessionWorker => {
  const stderr = new Response(child.stderr).text()
  const lines = createInterface({ input: Readable.fromWeb(child.stdout) })
  let current: WorkerRun | undefined
  let answers: Promise<void> = Promise.resolve()
  let nextRid = 1
  let ended = false

  const settle = (final: ProtocolFinal | undefined): void => {
    const running = current
    if (running === undefined) return
    current = undefined
    running.resolve(final)
  }

  const answerLater = (call: ProtocolCall, running: WorkerRun): void => {
    answers = answers.then(async () => {
      try {
        const settled = await running.answer(call)
        child.stdin.write(
          JSON.stringify({
            t: 'result',
            rid: call.rid,
            id: call.id,
            ok: settled.ok,
            value: settled.value,
            error: settled.error,
          }) + '\n',
        )
      } catch (error) {
        settle({ t: 'final', rid: call.rid, error: String(error) })
      }
    })
  }

  lines.on('line', (line: string) => {
    const running = current
    if (running === undefined) return
    routeLine(running, line, (call) => answerLater(call, running), settle)
  })
  // A child that ends leaves the program it was running without an answer; the
  // caller reports the exit code instead of waiting on a record that cannot come.
  lines.on('close', () => {
    ended = true
    settle(undefined)
  })

  return {
    alive: () => !ended,
    run: (code, tools, handlers) =>
      new Promise((resolve) => {
        if (current !== undefined) {
          resolve({ t: 'final', rid: 0, error: 'another program is still running in this session' })
          return
        }
        const rid = nextRid
        nextRid += 1
        current = { rid, ...handlers, resolve }
        child.stdin.write(JSON.stringify({ t: 'run', rid, code, tools }) + '\n')
      }),
    kill: () => {
      ended = true
      settle(undefined)
      child.kill()
    },
    exited: child.exited,
    stderr: () => stderr,
  }
}

/** The one line an artifact result writes; a nested page has to survive the outer result. */
const PAGE_LINE = /^page: \/artifact\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/

/** The return value as the conversation reads it; absent when the program returned nothing. */
const returnedOf = (final: ProtocolFinal): string =>
  final.hasValue === true && final.value !== undefined
    ? '\nreturn: ' + JSON.stringify(final.value)
    : ''

/**
 * Removes the type annotations before the child sees the program. The body is
 * wrapped in an async arrow because a program is a function body (`return` and
 * `await` at its top level), not a module. Node's stripper refuses the
 * constructs it cannot erase (enums, namespaces), and that refusal is the only
 * way a typed program does not run: it never reaches JavaScript with its
 * annotations still in place.
 */
export const stripProgram = (code: string): string =>
  stripTypeScriptTypes('(async () => {\n' + code + '\n})', { mode: 'strip' })

/** Runs one program in the session child, answering tool calls as they arrive. */
const runSession = async (
  worker: SessionWorker,
  config: { readonly code: string; readonly tools: ReadonlyArray<string> },
  host: RunCodeHost,
  context: ToolRunContext,
): Promise<RunCodeValue> => {
  const sink = makeSink(RUN_CODE_OUTPUT_LIMIT)
  const calls: Array<string> = []
  const pages: Array<string> = []

  const answer = async (message: ProtocolCall): Promise<ProtocolResult> => {
    calls.push(message.name)
    const callId = context.callId + '.' + String(message.id)
    const argumentsJson = JSON.stringify(message.args ?? {})
    // The start is durable before the call runs, so a program that dies mid-call
    // leaves evidence of what it had begun rather than nothing.
    await Effect.runPromise(
      host.append('tool/ptc-dispatch-start', {
        callId,
        name: message.name,
        arguments: argumentsJson,
      }),
    )
    // A program's call is not a decision of its own: the review that let this
    // program run already covered it, so the pipeline must not ask again.
    const nested = { ...context, callId, nested: true as const }
    const result = await Effect.runPromise(host.call(message.name, argumentsJson, nested))
    // A nested tool's note belongs to the step the program runs in, so the outer
    // call carries it: the fragments leave in the order the program made the calls.
    for (const text of result.context ?? []) context.addContext?.(text)
    // The child's result leaves to the program, then only its summary reaches
    // the log; keep the published page line so the outer card can draw it.
    for (const line of textOf(result).split('\n')) {
      const page = line.trim()
      if (PAGE_LINE.test(page) && !pages.includes(page)) pages.push(page)
    }
    await Effect.runPromise(
      host.append('tool/ptc-dispatch', {
        callId,
        name: message.name,
        arguments: argumentsJson,
        isError: result.isError,
        summary: resultSummary(result.content),
      }),
    )
    return { ok: !result.isError, value: result.value, error: textOf(result) }
  }

  const final = await worker.run(config.code, config.tools, { sink, answer })
  if (final === undefined) {
    const exitCode = await worker.exited
    const detail = (await worker.stderr()).slice(0, 2_000)
    throw new ToolError({
      code: 'execution',
      message:
        'run_code exited with code ' + String(exitCode) + (detail === '' ? '' : ': ' + detail),
    })
  }
  if (final.error !== undefined) {
    throw new ToolError({ code: 'execution', message: 'run_code failed: ' + final.error })
  }
  const printed = sink.finish()
  const output = printed.output + returnedOf(final)
  const shown = new Set(output.split('\n').map((line) => line.trim()))
  const extra = pages.filter((page) => !shown.has(page))
  return {
    output: extra.length === 0 ? output : output + '\n' + extra.join('\n'),
    truncated: printed.truncated,
    toolCalls: calls.length,
  }
}

/** The children one tool keeps, keyed by session and runtime. */
export interface RunCodeSessions {
  /** The child for this session and runtime, started on first use. */
  readonly open: (
    key: string,
    start: () => Effect.Effect<SessionWorker, ToolError>,
  ) => Effect.Effect<SessionWorker, ToolError>
  /** Ends and forgets the child of a session; the next call starts a fresh one. */
  readonly discard: (key: string) => Effect.Effect<void>
  /** Ends every child this tool kept. */
  readonly closeAll: () => Effect.Effect<void>
}

/** The pool a tool owns when no surrounding scope does; `closeAll` is its end. */
const makeSessionPool = (): RunCodeSessions => {
  const held = new Map<string, SessionWorker>()
  const closeAll = (): Effect.Effect<void> =>
    Effect.sync(() => {
      for (const worker of held.values()) worker.kill()
      held.clear()
    })
  return {
    open: (key, start) =>
      Effect.suspend(() => {
        const existing = held.get(key)
        if (existing !== undefined) return Effect.succeed(existing)
        return Effect.map(start(), (worker) => {
          held.set(key, worker)
          return worker
        })
      }),
    discard: (key) =>
      Effect.sync(() => {
        const worker = held.get(key)
        held.delete(key)
        worker?.kill()
      }),
    closeAll,
  }
}

/**
 * Builds the children a run keeps and ends them when its scope closes. A session
 * therefore never reads what a closed session's program left behind.
 */
export const makeRunCodeSessions = (): Effect.Effect<RunCodeSessions, never, Scope.Scope> =>
  Effect.gen(function* () {
    const pool = makeSessionPool()
    yield* Effect.addFinalizer(() => pool.closeAll())
    return pool
  })

/** The argv of the child that runs the program, per runtime. */
export const childArgv = (runtime: RunCodeRuntime): ReadonlyArray<string> =>
  runtime === 'python' ? ['python3', '-c', PYTHON_BOOTSTRAP] : [process.execPath, '-e', BOOTSTRAP]

/** What `run_code` accepts; the code is a JavaScript or TypeScript function body. */
export interface RunCodeArgs {
  readonly code: string
  readonly runtime?: RunCodeRuntime
}

/** `run_code` plus the end of the children it kept when no scope owns them. */
export interface RunCodeTool extends ToolDefinition<RunCodeArgs, RunCodeValue> {
  /** Ends every session child this tool started. */
  readonly closeSessions: () => Effect.Effect<void>
}

/**
 * A tool that runs a model-written program in a child process kept for the
 * session. The program reaches other tools through `tools.name(args)`; those
 * calls go back through the registry, so they meet the same policy and approval
 * as a direct call.
 */
export const makeRunCodeTool = (host: RunCodeHost): RunCodeTool => {
  const sessions = host.sessions ?? makeSessionPool()
  return {
    name: 'run_code',
    description:
      'Runs a program you write and returns its output. The code is the body of an async function: call another tool as `await tools.name(args)` and the call reaches the same policy and sandbox as a direct call. Return the value the next step should read; console.log lines are returned too. The program is TypeScript: type annotations, `as`, and `satisfies` are removed before it runs, and a program whose types cannot be removed fails instead of running as broken JavaScript. The child lives as long as the session, so values you put on `globalThis` are still there on the next call; a program still running at the timeout is ended, and the next call starts a fresh child. With runtime python the code is a script that calls tools.name(...) and prints its output.',
    parameters: Parameters,
    output: {
      schema: Output,
      render: (_args, value) => [{ type: 'text', text: value.output }],
    },
    timeoutMs: RUN_CODE_TIMEOUT_MS,
    execute: (args, context) =>
      Effect.gen(function* () {
        const runtime = args.runtime ?? 'node'
        // The strip happens here, before a child exists: an annotation that cannot
        // be removed is this call's failure, not a JavaScript syntax error later.
        const code =
          runtime === 'python'
            ? args.code
            : yield* Effect.try({
                try: () => stripProgram(args.code),
                catch: (error) =>
                  new ToolError({
                    code: 'invalid-arguments',
                    message:
                      'run_code could not remove the type annotations from the program: ' +
                      String(error),
                  }),
              })
        const key = context.sessionId + '\u001e' + runtime
        const names = host
          .tools()
          .map((declaration) => declaration.name)
          .filter((name) => name !== 'run_code')
        const worker = yield* sessions.open(key, () =>
          Effect.gen(function* () {
            const base = { argv: childArgv(runtime), cwd: context.cwd }
            const wrapped =
              host.sandbox === undefined
                ? base
                : yield* host.sandbox
                    .wrap({ argv: base.argv, cwd: base.cwd, mode: host.sandbox.mode })
                    .pipe(
                      Effect.mapError(
                        (error) =>
                          new ToolError({
                            code: 'execution',
                            message: 'sandbox: ' + error.message,
                          }),
                      ),
                    )
            return yield* Effect.try({
              try: () =>
                makeWorker(
                  spawn(wrapped.argv, {
                    cwd: wrapped.cwd,
                    stdin: 'pipe',
                    stdout: 'pipe',
                    stderr: 'pipe',
                  }),
                ),
              // A missing runtime is the run's shape, not a broken program: say which
              // one is absent instead of failing the turn.
              catch: (error) =>
                new ToolError({
                  code: 'unavailable',
                  message: 'no ' + runtime + ' runtime in this run: ' + String(error),
                }),
            })
          }),
        )
        return yield* Effect.tryPromise({
          try: () => runSession(worker, { code, tools: names }, host, context),
          catch: (error) =>
            error instanceof ToolError
              ? error
              : new ToolError({
                  code: 'execution',
                  message: 'run_code could not run its program: ' + String(error),
                }),
        }).pipe(
          // A child that died is no longer the session's memory; forgetting it here
          // lets the next call start a fresh one instead of writing to a closed pipe.
          Effect.tapError(() =>
            Effect.suspend(() => (worker.alive() ? Effect.void : sessions.discard(key))),
          ),
          // A call that timed out must not leave the stuck program behind, waiting
          // on the next call's line; the next call gets a child of its own.
          Effect.onInterrupt(() => sessions.discard(key)),
        )
      }),
    closeSessions: sessions.closeAll,
  }
}
