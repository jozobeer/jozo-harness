import { Effect } from 'effect'
import type { RuntimeContextEntry } from './types.ts'

/**
 * The GUI fact sorts after the workspace: the model reads where it works, then
 * which page is asking. It never changes within a run, so the snapshot repeats
 * the same bytes until something else moves.
 */
export const GUI_CONTEXT_ORDER = 15

/**
 * One fact for the browser UI serving this session. The reader is called at
 * render time: the port a run binds is known only after it listens, and a
 * session opened by --resume is built before that.
 */
export const guiContextEntry = (read: () => string | undefined): RuntimeContextEntry => ({
  name: 'gui',
  order: GUI_CONTEXT_ORDER,
  text: () =>
    Effect.sync(() => {
      const url = read()
      return url === undefined || url === '' ? undefined : 'gui: ' + url
    }),
})
