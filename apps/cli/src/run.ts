#!/usr/bin/env node
import { processTuiIo, type TuiIo } from '@jozo-harness/tui'
import { Deferred, Effect, Stream } from 'effect'
import { parseArgs } from './args.ts'
import { main, mainAcp, type MainIo } from './bin.ts'
import { runAuthAtStart } from './auth-cli.ts'
import { runConfigAtStart } from './config-cli.ts'

export interface ProcessIo extends MainIo {
  /** True when the process owns a terminal; piped input becomes batch lines. */
  readonly isTty: boolean
  readonly readStdin: () => Promise<string>
  /** The terminal the interactive UI draws on; tests provide their own. */
  readonly tui?: TuiIo
}

/** Lines of piped input: the trailing empty line after the final newline is dropped. */
export const linesOf = (text: string): ReadonlyArray<string> => {
  const parts = text.split('\n')
  return parts.length > 0 && parts[parts.length - 1] === '' ? parts.slice(0, -1) : parts
}

const readBatch = (io: ProcessIo): Effect.Effect<string> =>
  Effect.match(
    Effect.tryPromise({
      try: () => io.readStdin(),
      catch: (cause) => new Error('cannot read stdin: ' + String(cause)),
    }),
    { onFailure: () => '', onSuccess: (value) => value },
  )

/** The fields a terminal run adds to the command; missing ones stay absent. */
const ioFields = (io: ProcessIo, interactive: boolean, text: string): Partial<MainIo> => ({
  tty: io.isTty,
  ...(io.interrupt === undefined ? {} : { interrupt: io.interrupt }),
  ...(io.tui === undefined ? {} : { tui: io.tui }),
  ...(interactive && text === '' ? {} : { lines: Stream.fromIterable(linesOf(text)) }),
})

/** Wires the entry point to a process: a terminal becomes the UI, pipes become lines. */
export function runJozoHarness(argv: ReadonlyArray<string>, io: ProcessIo): Effect.Effect<number> {
  return Effect.gen(function* () {
    // A forced TUI owns stdin; the bytes are keys, not batch lines.
    const forcedTui = io.tui !== undefined && parseArgs(argv).tui
    const interactive = io.isTty || forcedTui
    const text = interactive ? '' : yield* readBatch(io)
    return yield* main(argv, {
      stdout: io.stdout,
      stderr: io.stderr,
      cwd: io.cwd,
      ...ioFields(io, interactive, text),
    })
  })
}

/** The real entry point: streams, stdin, and the process exit code. */
export function runAsProcess(argv: ReadonlyArray<string>): void {
  if (argv[0] === 'auth') {
    void runAuthAtStart(argv).then((code) => {
      process.exitCode = code ?? 0
    })
    return
  }

  if (argv[0] === 'acp') {
    // An editor owns stdin for the life of the process; the batch reader would
    // wait for EOF and answer nothing until the editor went away.
    void mainAcp(argv, {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
      cwd: process.cwd(),
    })
      .pipe(Effect.runPromise)
      .then((code) => {
        process.exitCode = code
      })
    return
  }

  if (argv[0] === 'config') {
    void runConfigAtStart(argv).then((code) => {
      process.exitCode = code ?? 0
    })
    return
  }

  void runJozoHarness(argv, {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    cwd: process.cwd(),
    isTty: process.stdin.isTTY === true,
    readStdin: () => readChunks(process.stdin),
    interrupt: interruptOnSignal(),
    // The UI is built always; --tui or a terminal decides whether it runs.
    tui: processTuiIo(),
  })
    .pipe(Effect.runPromise)
    .then((code) => {
      process.exitCode = code
    })
}

if (import.meta.main) runAsProcess(process.argv.slice(2))

/** Completes when the process receives SIGINT; the running turn is cancelled. */
export function interruptOnSignal(): Effect.Effect<void> {
  return Effect.gen(function* () {
    const signal = yield* Deferred.make<void>()
    const onSignal = (): void => {
      void Effect.runSync(Deferred.succeed(signal, undefined))
    }
    yield* Effect.sync(() => {
      process.once('SIGINT', onSignal)
    })
    return yield* Deferred.await(signal)
  })
}

/** Reads a chunk source to its end as UTF-8 text; a TTY ends at Ctrl-D. */
export async function readChunks(chunks: AsyncIterable<Uint8Array | string>): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''
  for await (const chunk of chunks) {
    text += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
  }
  return text
}
