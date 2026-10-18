import { createEffect, createSignal, on, onCleanup, type Accessor } from 'solid-js'

/** How long a piece of work that finished well stays green before it rests as a quiet mark. */
export const FINISHED_MS = 2500

/**
 * How far a rising level has come: the time the work has run, as the negative
 * delay its animation starts from, so a reload picks the level up where it was.
 */
export const pourFrom = (startedAt: number, now: number): string =>
  String(-Math.max(0, now - startedAt) / 1000) + 's'

/** How full a level with a known end is, from 0 to 1. */
export const levelOf = (done: number, of: number): string =>
  String(of > 0 ? Math.min(1, Math.max(0, done / of)) : 0)

/**
 * True for a moment after `running` turns false while the page watched, so the
 * finish shows green once and then rests. Work that had already finished when
 * the page drew it never lights.
 */
export const justFinished = (running: Accessor<boolean>): Accessor<boolean> => {
  const [lit, setLit] = createSignal(false)
  // Not deferred: a deferred `on` drops the value it first saw, and the first finish with it.
  createEffect(
    on(running, (now, before) => {
      if (before !== true || now) return
      setLit(true)
      const timer = setTimeout(() => setLit(false), FINISHED_MS)
      onCleanup(() => clearTimeout(timer))
    }),
  )
  return lit
}
