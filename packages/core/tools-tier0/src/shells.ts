import type { Child } from '@jozo-harness/process'

/**
 * A shell kept alive between calls. One process per name, commands written to
 * its stdin and the end of each call marked on its output, so a `cd` or a
 * variable set by one call is still there for the next one.
 */

/** What one command run inside a live shell returns, in the shape a one-shot call has. */
export interface SessionRun {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

export interface ShellSession {
  /** Runs one command line to its end marker, waiting at most the timeout. */
  readonly run: (command: string, timeoutMs: number) => Promise<SessionRun>
  /** True once the shell stopped, whether by a close, a timeout, or its own exit. */
  readonly ended: boolean
  /** Ends the shell and the processes it started. */
  readonly close: () => void
}

/**
 * The confinement a live shell was spawned with. The process stays inside it for
 * its whole life, so a later call can reuse the shell only when it matches.
 */
export interface ShellLaunch {
  readonly shell: 'bash' | 'powershell'
  readonly mode: string
  readonly cwd: string
}

/** A shell the call can use, or the live one it must not reuse. */
export type OpenedSession =
  | { readonly kind: 'ready'; readonly session: ShellSession }
  | { readonly kind: 'mismatch'; readonly launch: ShellLaunch }

export interface ShellSessions {
  /** The launch of the live shell under this name, when one is still running. */
  readonly launchOf: (name: string) => ShellLaunch | undefined
  /**
   * The live shell under this name, started by `start` when there is none.
   * A live shell whose launch differs is not started over and not reused.
   */
  readonly open: (name: string, launch: ShellLaunch, start: () => Child) => OpenedSession
  /** Whether a live shell is held under this name. */
  readonly has: (name: string) => boolean
  /** Ends every held shell; a run calls this when it stops. */
  readonly closeAll: () => void
}

/** The argv that opens a shell which reads commands from stdin until it is closed. */
export const sessionArgv = (shell: 'bash' | 'powershell'): ReadonlyArray<string> =>
  shell === 'bash' ? ['bash', '--noprofile', '--norc'] : ['pwsh', '-NoProfile']

/** A token no command output is likely to repeat, so a marker is never mistaken for output. */
const tokenOf = (): string => 'jzh-' + crypto.randomUUID()

/** The line a call's stdout ends with: the token and the exit code it reported. */
const stdoutMarker = (token: string): string => '__' + token + '__'

/** The line a call's stderr ends with, so both streams are known to be cut. */
const stderrMarker = (token: string): string => '__' + token + '__err'

/** Why one call stopped: both markers, the timeout, or the shell ending first. */
type Settled = 'ended' | 'timedOut' | 'done'

/** The output of one call, cut where its marker starts. */
const cutAt = (buffer: string, marker: string): string => {
  const index = buffer.indexOf(marker)
  return index === -1 ? buffer : buffer.slice(0, index).replace(/\n$/, '')
}

/** The exit code the marker carries; a shell that stopped before it wrote one has failed. */
const codeAt = (buffer: string, marker: string, settled: Settled): number => {
  const index = buffer.indexOf(marker)
  if (index === -1) return settled === 'ended' ? 1 : 0
  return Number(buffer.slice(index + marker.length)) || 0
}

/**
 * The script that runs one command and marks its end on both streams. The exit
 * code rides on the stdout marker, which is written after the command stopped.
 */
const framed = (command: string, token: string): string =>
  command +
  '\n__jzh_code=$?\n' +
  "printf '\\n%s%d\\n' '" +
  stdoutMarker(token) +
  '\' "$__jzh_code"\n' +
  "printf '\\n%s\\n' '" +
  stderrMarker(token) +
  "' >&2\n"

interface Live {
  readonly child: Child
  readonly session: ShellSession
}

interface Held {
  readonly launch: ShellLaunch
  readonly live: Live
}

/** True when a later call would run inside the same confinement the shell was spawned with. */
const sameLaunch = (running: ShellLaunch, next: ShellLaunch): boolean =>
  running.shell === next.shell && running.mode === next.mode && running.cwd === next.cwd

/** One live shell: the process, the buffers it fills, and the call waiting on its end. */
const liveOf = (child: Child, forget: () => void): Live => {
  let stdout = ''
  let stderr = ''
  let exited = false
  let waiting: (() => void) | undefined

  const append = (stream: 'stdout' | 'stderr', text: string): void => {
    if (stream === 'stdout') stdout += text
    else stderr += text
    waiting?.()
  }

  const collect = (stream: ReadableStream<Uint8Array>, name: 'stdout' | 'stderr'): void => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    void (async () => {
      while (true) {
        const { done, value } = await reader.read()
        if (done) return
        if (value !== undefined) append(name, decoder.decode(value))
      }
    })()
  }

  collect(child.stdout, 'stdout')
  collect(child.stderr, 'stderr')
  void child.exited.then(
    () => {
      exited = true
      waiting?.()
    },
    () => {
      exited = true
      waiting?.()
    },
  )

  const close = (): void => {
    if (exited) return
    exited = true
    child.stdin.end()
    child.kill()
    forget()
  }

  /** Waits until both markers are in the buffers, the timeout runs out, or the shell ends. */
  const settle = (token: string, timeoutMs: number): Promise<Settled> =>
    new Promise((resolve) => {
      const out = stdoutMarker(token)
      const err = stderrMarker(token)
      const finish = (reason: Settled): void => {
        clearTimeout(timer)
        waiting = undefined
        resolve(reason)
      }
      const timer = setTimeout(() => finish('timedOut'), timeoutMs)
      waiting = () => {
        if (stdout.includes(out) && stderr.includes(err)) finish('done')
        else if (exited) finish('ended')
      }
      waiting()
    })

  const run = async (command: string, timeoutMs: number): Promise<SessionRun> => {
    if (exited) return { exitCode: 1, stdout: '', stderr: 'session ended', timedOut: false }
    stdout = ''
    stderr = ''
    const token = tokenOf()
    const reason = settle(token, timeoutMs)
    child.stdin.write(framed(command, token))
    const settled = await reason
    if (settled === 'timedOut') {
      close()
      return { exitCode: 124, stdout, stderr, timedOut: true }
    }
    const out = stdoutMarker(token)
    return {
      exitCode: codeAt(stdout, out, settled),
      stdout: cutAt(stdout, out),
      stderr: cutAt(stderr, stderrMarker(token)),
      timedOut: false,
    }
  }

  return {
    child,
    session: {
      run,
      get ended() {
        return exited
      },
      close,
    },
  }
}

/** The shells one run keeps alive, by the name each call asked for. */
export const makeShellSessions = (): ShellSessions => {
  const held = new Map<string, Held>()

  const closeAll = (): void => {
    // A close drops its own entry, which a Map allows while it is being walked.
    for (const entry of held.values()) entry.live.session.close()
    held.clear()
  }

  const liveHeld = (name: string): Held | undefined => {
    const entry = held.get(name)
    if (entry === undefined || entry.live.session.ended) return undefined
    return entry
  }

  return {
    launchOf: (name) => liveHeld(name)?.launch,
    open: (name, launch, start) => {
      const existing = liveHeld(name)
      // The running process cannot be re-wrapped, so a different launch is refused.
      if (existing !== undefined) {
        return sameLaunch(existing.launch, launch)
          ? { kind: 'ready', session: existing.live.session }
          : { kind: 'mismatch', launch: existing.launch }
      }
      const live = liveOf(start(), () => {
        const current = held.get(name)
        if (current !== undefined && current.live.session.ended) held.delete(name)
      })
      held.set(name, { launch, live })
      return { kind: 'ready', session: live.session }
    },
    has: (name) => liveHeld(name) !== undefined,
    closeAll,
  }
}
