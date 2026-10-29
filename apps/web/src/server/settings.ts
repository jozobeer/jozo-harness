import type { Effect } from 'effect'
import type { EditableSettingsView, RunSettingsInput, SettingsView } from '../shared/rpc.ts'
import type { WebError } from './errors.ts'

/**
 * The settings of the run behind the page: what is in effect, and the parts a
 * page may change. The view is the wire shape the page reads; the model is the
 * route the sessions this run opens start from, and `remember` writes it into
 * the settings file so the next run reads it there. The effort is the choice
 * those sessions start from, and it stays with this run.
 */
export interface SettingsPort {
  readonly read: () => Effect.Effect<SettingsView, WebError>
  /** Every model the provider offers, as provider/model routes. */
  readonly models: () => Effect.Effect<ReadonlyArray<string>, WebError>
  readonly setModel: (model: string, remember: boolean) => Effect.Effect<void, WebError>
  /** The effort a session opened from now asks for; '' leaves it to the provider. */
  readonly setEffort: (effort: string) => Effect.Effect<void, WebError>
  /**
   * The values the settings pane may edit, resolved from the same rows a run uses,
   * with where each came from. A key is shown by reference and presence only.
   */
  readonly editable: () => Effect.Effect<EditableSettingsView, WebError>
  /**
   * Validates every field first and writes them through the one settings writer.
   * A refusal names the field, so the page can point at it.
   */
  readonly saveEditable: (input: RunSettingsInput) => Effect.Effect<EditableSettingsView, WebError>
  /** The tool set a new session starts from, as the settings file holds it now. */
  readonly defaultTools: () => Effect.Effect<
    { readonly tools: ReadonlyArray<string> | undefined; readonly settingsPath: string },
    WebError
  >
  /**
   * Writes the set a new session starts from through the settings file, the same
   * one `jzh config set tools` writes. A session already open keeps its own set.
   */
  readonly saveDefaultTools: (tools: ReadonlyArray<string>) => Effect.Effect<void, WebError>
}
