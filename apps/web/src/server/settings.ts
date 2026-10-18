import type { Effect } from 'effect'
import type { SettingsView } from '../shared/rpc.ts'
import type { WebError } from './errors.ts'

/**
 * The settings of the run behind the page: what is in effect, and the parts a
 * page may change. The view is the wire shape the page reads; the model is the
 * route the sessions this run opens start from, and `remember` writes it into
 * the settings file so the next run reads it there.
 */
export interface SettingsPort {
  readonly read: () => Effect.Effect<SettingsView, WebError>
  /** Every model the provider offers, as provider/model routes. */
  readonly models: () => Effect.Effect<ReadonlyArray<string>, WebError>
  readonly setModel: (model: string, remember: boolean) => Effect.Effect<void, WebError>
}
