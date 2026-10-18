/**
 * A child process on Node with the shape the tools and tests used to get from
 * Bun: output as web streams, a promise for the exit code, and a signal-taking
 * kill. Nothing here is specific to any tool.
 */

import { spawn as spawnChild } from 'node:child_process'
import { constants } from 'node:os'
import { Readable } from 'node:stream'

/** The writable end of a piped stdin. */
export interface ChildInput {
  /** Queues text for the child. Node writes in order, so no flush is needed. */
  write(text: string): void
  /** Closes the input so the child reads end-of-file. */
  end(): void
}

/** A running child process. */
export interface Child {
  /** The exit code; a process killed by a signal reads as 128 + the signal number. */
  readonly exited: Promise<number>
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly stdin: ChildInput
  /** Sends the signal (SIGTERM by default) to the child. */
  kill(signal?: NodeJS.Signals | number): void
}

/** How the child is wired. Output is piped unless the caller says otherwise. */
export interface SpawnOptions {
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly stdin?: 'pipe' | 'ignore' | 'inherit'
  readonly stdout?: 'pipe' | 'ignore' | 'inherit'
  readonly stderr?: 'pipe' | 'ignore' | 'inherit'
}

/** An empty stream, for an output the caller did not ask to read. */
const noStream = (): ReadableStream<Uint8Array> =>
  new ReadableStream({ start: (controller) => controller.close() })

const streamOf = (stream: Readable | null): ReadableStream<Uint8Array> =>
  stream === null ? noStream() : (Readable.toWeb(stream) as ReadableStream<Uint8Array>)

/** The code a signal death reads as, the way a shell reports it. */
const codeOf = (code: number | null, signal: NodeJS.Signals | null): number =>
  code ?? 128 + (signal === null ? 0 : (constants.signals[signal] ?? 0))

/**
 * True where a child can lead a process group. A POSIX group lets a kill reach
 * the descendants a command started; Node cannot group children on Windows.
 */
const groupsChildren = process.platform !== 'win32'

export const spawn = (command: ReadonlyArray<string>, options: SpawnOptions = {}): Child => {
  const [program, ...args] = command
  if (program === undefined) throw new Error('spawn needs a command to run')
  const child = spawnChild(program, args, {
    stdio: [options.stdin ?? 'ignore', options.stdout ?? 'pipe', options.stderr ?? 'pipe'],
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    // The child leads its own group, so the kill below can take the whole tree.
    detached: groupsChildren,
  })
  return {
    exited: new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve(codeOf(code, signal)))
    }),
    stdout: streamOf(child.stdout),
    stderr: streamOf(child.stderr),
    stdin: {
      write: (text) => {
        child.stdin?.write(text)
      },
      end: () => {
        child.stdin?.end()
      },
    },
    kill: (signal) => {
      const pid = child.pid
      if (!groupsChildren || pid === undefined) {
        child.kill(signal)
        return
      }
      try {
        // A negative pid names the process group the child leads.
        process.kill(-pid, signal ?? 'SIGTERM')
      } catch {
        // The group may have ended already; the direct child may still be there.
        child.kill(signal)
      }
    },
  }
}
