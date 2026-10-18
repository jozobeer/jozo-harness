import type { ToolSchema } from '@jozo-harness/llm'
import type { SandboxShape } from '@jozo-harness/safety'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import { spawn, type Child } from '@jozo-harness/process'
import {
  ToolError,
  type ToolDefinition,
  type ToolExecutionResult,
  type ToolRunContext,
} from '@jozo-harness/tools'
import { Effect, Schema } from 'effect'

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
  /** The sandbox the child runs under. Absent leaves the child unconfined. */
  readonly sandbox?: SandboxShape
}

const Parameters = Schema.Struct({
  code: Schema.String.annotate({
    description:
      'The body of an async JavaScript function. Call another tool as `await tools.name(args)`; the resolved value is the tool result. Use `return` for what the model should read, with `console.log` for progress.',
  }),
})

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
  readonly id: number
  readonly name: string
  readonly args: unknown
}

interface ProtocolFinal {
  readonly t: 'final'
  readonly hasValue?: boolean
  readonly value?: unknown
  readonly error?: string
}

type ProtocolMessage = ProtocolCall | ProtocolFinal

/**
 * The program that runs in the child. It reads one config line, then answers
 * call requests on stdin. Program output goes to stdout unprefixed, so the
 * parent can tell the two apart without wrapping `console.log`.
 */
const BOOTSTRAP = String.raw`
const createInterface = require('node:readline').createInterface
const RS = '\u001e'
const pending = new Map()
let nextId = 1
let started = false
const emit = (message) => process.stdout.write(RS + JSON.stringify(message) + '\n')
const serialized = (value) => {
  if (value === undefined) return undefined
  try { return JSON.parse(JSON.stringify(value)) } catch { return String(value) }
}
const toolsOf = (names) => {
  const built = Object.create(null)
  for (const name of names) {
    built[name] = (args = {}) => new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, (message) => message.ok ? resolve(message.value) : reject(new Error(message.error)))
      emit({ t: 'call', id, name, args })
    })
  }
  return built
}
const run = async (config) => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  try {
    const body = new AsyncFunction('tools', config.code)
    const value = await body(toolsOf(config.tools))
    emit({ t: 'final', hasValue: value !== undefined, value: serialized(value) })
  } catch (error) {
    emit({ t: 'final', error: String(error && error.stack ? error.stack : error) })
  }
}
createInterface({ input: process.stdin }).on('line', (line) => {
  if (!started) { started = true; run(JSON.parse(line)); return }
  const message = JSON.parse(line)
  const settle = pending.get(message.id)
  if (settle !== undefined) { pending.delete(message.id); settle(message) }
})
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

/** Consumes the child's lines until its final message, answering calls on the way. */
const drain = async (
  lines: AsyncIterable<string>,
  answer: (message: ProtocolCall) => Promise<void>,
  sink: Sink,
): Promise<ProtocolFinal | undefined> => {
  for await (const line of lines) {
    const split = splitLine(line)
    if (split.record === undefined) {
      sink.append(split.output + '\n')
      continue
    }
    if (split.output !== '') sink.append(split.output)
    const message = parseRecord(split.record)
    if (message.t === 'call') {
      await answer(message)
      continue
    }
    return message
  }
  return undefined
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

/** The return value as the conversation reads it; absent when the program returned nothing. */
const returnedOf = (final: ProtocolFinal): string =>
  final.hasValue === true && final.value !== undefined
    ? '\nreturn: ' + JSON.stringify(final.value)
    : ''

/** Runs the child to its final message, answering tool calls as they arrive. */
const runSession = async (
  child: Child,
  config: { readonly code: string; readonly tools: ReadonlyArray<string> },
  host: RunCodeHost,
  context: ToolRunContext,
): Promise<RunCodeValue> => {
  child.stdin.write(JSON.stringify(config) + '\n')
  const stderr = new Response(child.stderr).text()
  const sink = makeSink(RUN_CODE_OUTPUT_LIMIT)
  const calls: Array<string> = []

  const answer = async (message: ProtocolCall): Promise<void> => {
    calls.push(message.name)
    const nested = { ...context, callId: context.callId + '.' + String(message.id) }
    const result = await Effect.runPromise(
      host.call(message.name, JSON.stringify(message.args ?? {}), nested),
    )
    child.stdin.write(
      JSON.stringify({
        t: 'result',
        id: message.id,
        ok: !result.isError,
        value: result.value,
        error: textOf(result),
      }) + '\n',
    )
  }

  const lines = createInterface({ input: Readable.fromWeb(child.stdout) })
  const final = await drain(lines, answer, sink)

  child.kill()
  const exitCode = await child.exited
  const detail = (await stderr).slice(0, 2_000)
  if (final === undefined) {
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
  return {
    output: printed.output + returnedOf(final),
    truncated: printed.truncated,
    toolCalls: calls.length,
  }
}

const childArgv = (): ReadonlyArray<string> => [process.execPath, '-e', BOOTSTRAP]

/**
 * A tool that runs a model-written program in a child process. The program
 * reaches other tools through `tools.name(args)`; those calls go back through
 * the registry, so they meet the same policy and approval as a direct call.
 */
export const makeRunCodeTool = (
  host: RunCodeHost,
): ToolDefinition<{ readonly code: string }, RunCodeValue> => ({
  name: 'run_code',
  description:
    'Runs a program you write in a child process and returns its output. The code is the body of an async function: call another tool as `await tools.name(args)` and the call reaches the same policy and sandbox as a direct call. Return the value the next step should read; console.log lines are returned too. Output past the limit is cut with a marker, and a program still running at the timeout is ended.',
  parameters: Parameters,
  output: {
    schema: Output,
    render: (_args, value) => [{ type: 'text', text: value.output }],
  },
  timeoutMs: RUN_CODE_TIMEOUT_MS,
  execute: (args, context) =>
    Effect.gen(function* () {
      const base = { argv: childArgv(), cwd: context.cwd }
      const wrapped =
        host.sandbox === undefined
          ? base
          : yield* host.sandbox
              .wrap({ argv: base.argv, cwd: base.cwd, mode: host.sandbox.mode })
              .pipe(
                Effect.mapError(
                  (error) =>
                    new ToolError({ code: 'execution', message: 'sandbox: ' + error.message }),
                ),
              )
      const names = host
        .tools()
        .map((declaration) => declaration.name)
        .filter((name) => name !== 'run_code')
      return yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          spawn(wrapped.argv, {
            cwd: wrapped.cwd,
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'pipe',
          }),
        ),
        (child) =>
          Effect.tryPromise({
            try: () => runSession(child, { code: args.code, tools: names }, host, context),
            catch: (error) =>
              error instanceof ToolError
                ? error
                : new ToolError({
                    code: 'execution',
                    message: 'run_code could not run its program: ' + String(error),
                  }),
          }).pipe(Effect.ensuring(Effect.sync(() => child.kill()))),
        (child) => Effect.sync(() => child.kill()),
      )
    }),
})
