/**
 * A shell without a process, for the tests that need the server's terminal
 * plumbing rather than a real shell: the test writes its output and ends it.
 */

import type { ShellChild } from '../src/server/terminal.ts'

/** A writable channel for one stream a stub shell owns. */
const channelOf = (): {
  readonly stream: ReadableStream<Uint8Array>
  readonly push: (text: string) => void
  readonly close: () => void
} => {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  const stream = new ReadableStream<Uint8Array>({
    start: (made) => {
      controller = made
    },
  })
  return {
    stream,
    push: (text) => {
      try {
        controller?.enqueue(new TextEncoder().encode(text))
      } catch {
        // The terminal that owned the stream already closed it; a late write is lost.
      }
    },
    close: () => controller?.close(),
  }
}

/** What one stub shell hands the terminal and what the terminal did to it. */
export interface StubShell {
  readonly child: ShellChild
  readonly out: (text: string) => void
  readonly err: (text: string) => void
  readonly writes: Array<string>
  readonly kills: () => number
  readonly finish: (code: number) => void
}

/** Starts a stub shell: output is pushed by the test, and finish closes the streams. */
export const makeStubShell = (): StubShell => {
  const out = channelOf()
  const err = channelOf()
  const writes: Array<string> = []
  let killed = 0
  let finish = (_code: number): void => undefined
  const exited = new Promise<number>((resolve) => {
    finish = resolve
  })
  return {
    child: {
      stdout: out.stream,
      stderr: err.stream,
      stdin: {
        write: (text) => {
          writes.push(text)
        },
      },
      exited,
      kill: () => {
        killed += 1
      },
    },
    out: out.push,
    err: err.push,
    writes,
    kills: () => killed,
    finish: (code) => {
      out.close()
      err.close()
      finish(code)
    },
  }
}
