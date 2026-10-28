import { execFileSync } from 'node:child_process'
import { Effect } from 'effect'
import type { RuntimeContextEntry } from './types.ts'

/** Tmux facts sort between the workspace and the clock. */
export const TMUX_CONTEXT_ORDER = 20

/** The place this process runs at: session name, window index, pane index. */
export interface TmuxLocation {
  readonly session: string
  readonly window: string
  readonly pane: string
}

/**
 * How the tmux fact sees the host. Tests replace it, so neither the environment
 * of the test runner nor a live tmux server decides what the tests prove.
 */
export interface TmuxProbe {
  /** The process environment; both TMUX and TMUX_PANE mean a pane owns it. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** Runs tmux with these arguments and returns its stdout, or undefined when it cannot answer. */
  readonly run: (args: ReadonlyArray<string>) => string | undefined
}

const runTmux = (args: ReadonlyArray<string>): string | undefined => {
  try {
    return execFileSync('tmux', [...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    })
  } catch {
    // A missing tmux or a refused query is an absent fact, not a failed step.
    return undefined
  }
}

/** The probe of this process: its environment and the real tmux binary. */
export const processTmuxProbe = (): TmuxProbe => ({ env: process.env, run: runTmux })

/** Session names cannot hold a colon, so the first colon ends the name. */
const LOCATION = /^([^:]+):([0-9]+)\.([0-9]+)$/

/**
 * The location tmux reports for this pane, or undefined outside tmux and on any
 * failed query. The comparison unit is the session name, window index, and pane
 * index: a window rename or a move between panes without a window change is the
 * same place and must not add another snapshot.
 *
 * Only the values read in this step decide. A step started from a child or
 * another process can miss a move it did not witness, but it never reports a
 * stale place; for context a model acts on, a missed change is the safer error.
 */
export const readTmuxLocation = (probe: TmuxProbe): TmuxLocation | undefined => {
  const tmuxPane = probe.env.TMUX_PANE
  if (
    probe.env.TMUX === undefined ||
    probe.env.TMUX === '' ||
    tmuxPane === undefined ||
    tmuxPane === ''
  ) {
    return undefined
  }
  // Target the pane that owns this process instead of the client's active pane.
  const output = probe.run(['display-message', '-p', '-t', tmuxPane, '#S:#I.#P'])
  if (output === undefined) return undefined
  const match = LOCATION.exec(output.trim())
  if (match === null) return undefined
  const session = match[1]
  const window = match[2]
  const pane = match[3]
  if (session === undefined || window === undefined || pane === undefined) return undefined
  return { session, window, pane }
}

const line = (location: TmuxLocation): string =>
  'tmux: session ' + location.session + ', window ' + location.window + ', pane ' + location.pane

/** One opt-in runtime fact for the tmux pane this process runs in. */
export const tmuxContextEntry = (probe: TmuxProbe = processTmuxProbe()): RuntimeContextEntry => ({
  name: 'tmux',
  order: TMUX_CONTEXT_ORDER,
  text: () =>
    Effect.sync(() => {
      const location = readTmuxLocation(probe)
      return location === undefined ? undefined : line(location)
    }),
})
