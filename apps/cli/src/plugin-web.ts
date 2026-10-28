import { Effect, Result } from 'effect'
import type { Plugin, PluginRow } from '@jozo-harness/kernel'
import type { AskShape } from '@jozo-harness/safety'
import type { PluginChange } from '@jozo-harness/tools-tier1'
import type {
  PluginChangeAnswer,
  PluginChangeRequest,
  PluginRowView,
  PluginsPort,
  PluginsView,
} from '@jozo-harness/web'
import { makePluginHost } from './plugin-host.ts'
import type { PluginWiringState } from './plugin-wiring.ts'
import type { OptionalBundle } from './plugins.ts'

export interface WebPluginsOptions {
  /** The rows this run was built from. */
  readonly rows: ReadonlyArray<PluginRow>
  readonly settingsPath: string
  readonly plugins: ReadonlyArray<Plugin<any, any, any>>
  readonly catalog: ReadonlyArray<OptionalBundle>
  readonly wiring: PluginWiringState
  /** The host writes settings only, so a question never comes from this path. */
  readonly ask: AskShape
}

const refuse = (status: number, message: string): PluginChangeAnswer => ({
  ok: false,
  status,
  message,
})

const rowView = (row: PluginRow, running: ReadonlySet<string>): PluginRowView => ({
  id: row.id,
  name: row.name,
  enabled: row.disabled !== true,
  running: running.has(row.id),
})

/**
 * The plugin port the web page talks to. A change writes the settings the next
 * start reads and updates the view the page sees; it does not rebuild the Layer
 * this run was built from. A failed wiring is retried over the running services
 * instead, which is the one change that can reach this run.
 */
export const makeWebPluginsPort = (options: WebPluginsOptions): PluginsPort => {
  const running = new Set(options.rows.map((row) => row.id))
  let rows: ReadonlyArray<PluginRow> = options.rows.map((row) => ({ ...row }))
  const host = makePluginHost({
    rows,
    plugins: options.plugins,
    settingsPath: options.settingsPath,
    ask: options.ask,
  })

  const write = async (change: PluginChange): Promise<PluginChangeAnswer> => {
    const answer = await Effect.runPromise(Effect.result(host.change(change)))
    return Result.isFailure(answer)
      ? refuse(answer.failure.code === 'invalid-arguments' ? 400 : 409, answer.failure.message)
      : { ok: true }
  }

  const view = (): PluginsView => ({
    rows: rows.map((row) => rowView(row, running)),
    catalog: options.catalog.map((bundle) => ({
      id: bundle.id,
      name: bundle.name,
      summary: bundle.summary,
      needsConfig: bundle.needsConfig,
      installed: rows.some((row) => row.name === bundle.name),
    })),
    failures: options.wiring.failures(),
  })

  const retry = async (id: string): Promise<PluginChangeAnswer> => {
    const answer = await Effect.runPromise(Effect.result(options.wiring.retry(id)))
    return Result.isFailure(answer) ? refuse(400, answer.failure.message) : { ok: true }
  }

  const setEnabled = async (
    request: Extract<PluginChangeRequest, { action: 'set-enabled' }>,
  ): Promise<PluginChangeAnswer> => {
    const row = rows.find((each) => each.id === request.id)
    if (row === undefined) return refuse(400, 'no plugin row with that id: ' + request.id)
    if ((row.disabled !== true) === request.enabled) return { ok: true }
    const answer = await write({
      kind: 'set-disabled',
      id: row.id,
      name: row.name,
      disabled: !request.enabled,
    })
    if (!answer.ok) return answer
    rows = rows.map((each) =>
      each.id === request.id ? { ...each, disabled: !request.enabled } : each,
    )
    return { ok: true }
  }

  const install = async (
    request: Extract<PluginChangeRequest, { action: 'install' }>,
  ): Promise<PluginChangeAnswer> => {
    const bundle = options.catalog.find(
      (each) => each.id === request.id && each.name === request.name,
    )
    if (bundle === undefined) {
      return refuse(400, request.name + ' is not a bundle this page installs')
    }
    if (bundle.needsConfig) {
      return refuse(
        400,
        request.name + ' needs config in the settings file, so the page cannot install it',
      )
    }
    if (rows.some((each) => each.id === request.id)) {
      return refuse(409, 'a plugin row already has the id ' + request.id)
    }
    const answer = await write({ kind: 'add', id: request.id, name: request.name })
    if (!answer.ok) return answer
    rows = [...rows, { id: request.id, name: request.name }]
    return { ok: true }
  }

  const change = (request: PluginChangeRequest): Promise<PluginChangeAnswer> => {
    if (request.action === 'retry') return retry(request.id)
    if (request.action === 'set-enabled') return setEnabled(request)
    return install(request)
  }

  return {
    view,
    known: () => options.plugins.map((plugin) => plugin.name),
    change,
  }
}
