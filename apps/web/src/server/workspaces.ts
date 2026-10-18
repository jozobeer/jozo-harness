import type { Effect } from 'effect'
import type { WorkspaceView } from '../shared/rpc.ts'
import type { WebError } from './errors.ts'

/**
 * The folders a page may start a session in. A folder is offered because a
 * session already lives there or because the reader registered it; the run's own
 * working directory is always the last resort and never goes missing.
 */
export interface WorkspacesPort {
  readonly list: () => Effect.Effect<
    { readonly cwd: string; readonly items: ReadonlyArray<WorkspaceView> },
    WebError
  >
  /** Registers one more folder; only an absolute, existing directory is accepted. */
  readonly add: (cwd: string) => Effect.Effect<void, WebError>
}
