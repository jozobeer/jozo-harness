import { spawn } from '@jozo-harness/process'
import { Readable } from 'node:stream'
import type { HarnessChild } from './client.ts'

export interface SpawnHarnessOptions {
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
}

/** Turns the process package's web stream into the Node stream a client reads. */
const readableOf = (stream: ReadableStream<Uint8Array>): Readable =>
  Readable.from(
    (async function* () {
      const reader = stream.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) return
          // The process package hands out web-stream bytes; the client reads
          // Node chunks, where a Buffer keeps its UTF-8 text.
          yield Buffer.from(value)
        }
      } finally {
        reader.releaseLock()
      }
    })(),
  )

/**
 * Starts a harness process for a client. The child leads its own process group,
 * so close reaches the commands a tool started as well as jzh itself.
 */
export const spawnHarness = (
  command: ReadonlyArray<string>,
  options: SpawnHarnessOptions = {},
): HarnessChild => {
  const child = spawn(command, {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
  })
  return {
    stdin: child.stdin,
    stdout: readableOf(child.stdout),
    exited: child.exited,
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    kill: () => child.kill(),
  }
}
