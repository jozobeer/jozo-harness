import type { SubmitMode } from '@jozo-harness/ui-protocol'

/** Where the busy-Enter choice is kept, beside the theme and the rail width. */
export const BUSY_ENTER_KEY = 'jzh.busy-enter'

/** The choice a page starts with: queue, as the core and the CLI treat a busy turn. */
export const busyEnterFrom = (stored: string | null): SubmitMode =>
  stored === 'steer' ? 'steer' : 'queue'

/** Whether a send gesture is the accelerated one: Cmd on a Mac, Ctrl elsewhere. */
export const acceleratedSend = (event: {
  readonly metaKey: boolean
  readonly ctrlKey: boolean
}): boolean => event.metaKey || event.ctrlKey

/** The other mode of a pair, which the accelerated gesture asks for. */
export const oppositeMode = (mode: SubmitMode): SubmitMode => (mode === 'steer' ? 'queue' : 'steer')

/**
 * What Enter sends while a turn runs. With no turn there is no next step to
 * join, so the line is queued and starts the next turn either way; an
 * accelerated gesture (Cmd/Ctrl+Enter) asks for the opposite of the stored
 * choice, so both modes stay reachable without changing the setting.
 */
export const submitModeFor = (
  preferred: SubmitMode,
  running: boolean,
  accelerated: boolean,
): SubmitMode => {
  if (!running) return 'queue'
  return accelerated ? oppositeMode(preferred) : preferred
}
