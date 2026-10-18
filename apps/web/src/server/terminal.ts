/**
 * The shell behind the page's terminal pane. It runs one child in the session's
 * own directory and carries its three streams as text frames. There is no PTY
 * yet, so the shell is line-oriented: it echoes nothing the page did not send,
 * and a control character reaches it as a character rather than a keystroke.
 */

import { terminalInputOf, type TerminalFrame } from '../shared/terminal.ts'

/** The part of a child the terminal reads and writes, as the process wrapper gives it. */
export interface ShellChild {
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly stdin: { write(text: string): void }
  readonly exited: Promise<number>
  kill(signal?: NodeJS.Signals | number): void
}

/** Starts one shell in a directory; the process tests hand in a stub here. */
export type SpawnShell = (command: ReadonlyArray<string>, cwd: string) => ShellChild

/** How one shell runs: the app that owns the process wrapper supplies the spawn. */
export interface TerminalOptions {
  readonly spawn: SpawnShell
  readonly shell?: string
}

/** One running shell, as the socket that opened it holds it. */
export interface TerminalSession {
  readonly message: (data: string) => void
  readonly close: () => void
}

/** What a terminal socket gets: starts one shell in a directory and returns its handle. */
export type TerminalFactory = (cwd: string, send: (frame: TerminalFrame) => void) => TerminalSession

/** The shell a page gets: the environment's own, or a POSIX one when it names none. */
export const shellOf = (env: NodeJS.ProcessEnv): string => {
  const shell = env['SHELL']
  return shell === undefined || shell === '' ? '/bin/sh' : shell
}

/**
 * Starts one shell and returns the handle the socket needs: a message writes a
 * line to stdin or closes it, and close takes the process group with it. Output
 * is decoded per stream, because one reader may split a character in two.
 */
export const openShell = (
  cwd: string,
  send: (frame: TerminalFrame) => void,
  options: TerminalOptions,
): TerminalSession => {
  const child = options.spawn([options.shell ?? shellOf(process.env)], cwd)
  const readers: Array<ReadableStreamDefaultReader<Uint8Array>> = []
  let closed = false
  let gone = false

  const pump = async (
    stream: ReadableStream<Uint8Array>,
    name: 'stdout' | 'stderr',
  ): Promise<void> => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    readers.push(reader)
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done === true || closed) return
        send({ type: 'output', stream: name, data: decoder.decode(next.value, { stream: true }) })
      }
    } catch {
      // Closing the socket cancels the read; there is nothing left to say.
    }
  }

  // Output first, exit last: the page shows the shell's last words before its code.
  void Promise.all([pump(child.stdout, 'stdout'), pump(child.stderr, 'stderr')])
    .then(() => child.exited)
    .then((code) => {
      gone = true
      if (!closed) send({ type: 'exit', code })
    })
    .catch(() => undefined)

  const close = (): void => {
    if (closed) return
    closed = true
    child.kill()
    for (const reader of readers) void reader.cancel()
  }

  return {
    message: (data) => {
      const input = terminalInputOf(data)
      if (input === undefined) return
      if (input.type === 'close') {
        close()
        return
      }
      if (!closed && !gone) child.stdin.write(input.data)
    },
    close,
  }
}
