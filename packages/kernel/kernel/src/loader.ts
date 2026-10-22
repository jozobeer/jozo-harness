import { Effect, Layer, Schema } from 'effect'
import { PluginError } from './errors.ts'
import type { Plugin } from './plugin.ts'
import { isRowEnabled, mergeRows, type PluginRow } from './profile.ts'

export interface LoadProfileOptions {
  readonly plugins: ReadonlyArray<Plugin<any, any, any>>
  readonly layers: ReadonlyArray<ReadonlyArray<PluginRow>>
}

const dependentsOf = (
  rows: ReadonlyArray<PluginRow>,
  dependencies: ReadonlyMap<string, ReadonlyArray<string>>,
): ReadonlyMap<string, ReadonlyArray<PluginRow>> => {
  const dependents = new Map<string, PluginRow[]>()
  for (const row of rows) {
    for (const dependency of dependencies.get(row.id) ?? []) {
      dependents.set(dependency, [...(dependents.get(dependency) ?? []), row])
    }
  }
  return dependents
}

/** Decrements the pending count of each dependent and returns the ones that became ready. */
const releaseDependents = (
  rowId: string,
  pending: Map<string, number>,
  dependents: ReadonlyMap<string, ReadonlyArray<PluginRow>>,
): ReadonlyArray<PluginRow> =>
  (dependents.get(rowId) ?? []).filter((dependent) => {
    const count = (pending.get(dependent.id) ?? 0) - 1
    pending.set(dependent.id, count)
    return count === 0
  })

const topologicalOrder = (
  rows: ReadonlyArray<PluginRow>,
  dependencies: ReadonlyMap<string, ReadonlyArray<string>>,
): Effect.Effect<ReadonlyArray<PluginRow>, PluginError> => {
  const pending = new Map(rows.map((row) => [row.id, dependencies.get(row.id)?.length ?? 0]))
  const dependents = dependentsOf(rows, dependencies)
  const ready = rows.filter((row) => pending.get(row.id) === 0)
  const ordered: PluginRow[] = []
  for (let index = 0; index < ready.length; index++) {
    const row = ready[index]!
    ordered.push(row)
    ready.push(...releaseDependents(row.id, pending, dependents))
  }
  if (ordered.length === rows.length) return Effect.succeed(ordered)
  const cycle = rows.filter((row) => !ordered.includes(row)).map((row) => row.id)
  return Effect.fail(
    new PluginError({
      code: 'dependency-cycle',
      message: `dependency cycle among ${cycle.join(', ')}`,
    }),
  )
}

const toNonEmpty = <A>(values: ReadonlyArray<A>): [A, ...Array<A>] => values as [A, ...Array<A>]

type PluginMap = ReadonlyMap<string, Plugin<any, any, any>>

const pluginMap = (
  plugins: ReadonlyArray<Plugin<any, any, any>>,
): Effect.Effect<PluginMap, PluginError> =>
  Effect.gen(function* () {
    const byName = new Map<string, Plugin<any, any, any>>()
    for (const plugin of plugins) {
      if (byName.has(plugin.name)) {
        return yield* Effect.fail(
          new PluginError({
            code: 'duplicate-plugin',
            message: `plugin ${plugin.name} is registered twice`,
            pluginId: plugin.name,
          }),
        )
      }
      byName.set(plugin.name, plugin)
    }
    return byName
  })

const requireKnownPlugins = (
  rows: ReadonlyArray<PluginRow>,
  pluginsByName: PluginMap,
): Effect.Effect<void, PluginError> =>
  Effect.gen(function* () {
    for (const row of rows) {
      if (!pluginsByName.has(row.name)) {
        return yield* Effect.fail(
          new PluginError({
            code: 'unknown-plugin',
            message: `row ${row.id} names unknown plugin ${row.name}`,
            pluginId: row.id,
          }),
        )
      }
    }
  })

const providerIndex = (
  rows: ReadonlyArray<PluginRow>,
  pluginsByName: PluginMap,
): Effect.Effect<ReadonlyMap<string, PluginRow>, PluginError> =>
  Effect.gen(function* () {
    const providerByService = new Map<string, PluginRow>()
    for (const row of rows) {
      const plugin = pluginsByName.get(row.name)!
      for (const service of plugin.provides) {
        const existing = providerByService.get(service.key)
        if (existing !== undefined && existing.id !== row.id) {
          return yield* Effect.fail(
            new PluginError({
              code: 'duplicate-provider',
              message: `service ${service.key} is provided by both ${existing.id} and ${row.id}`,
              pluginId: row.id,
              service: service.key,
            }),
          )
        }
        providerByService.set(service.key, row)
      }
    }
    return providerByService
  })

const requireProviders = (
  rows: ReadonlyArray<PluginRow>,
  pluginsByName: PluginMap,
  providerByService: ReadonlyMap<string, PluginRow>,
): Effect.Effect<ReadonlyMap<string, ReadonlyArray<string>>, PluginError> =>
  Effect.gen(function* () {
    const dependencies = new Map<string, ReadonlyArray<string>>()
    for (const row of rows) {
      const plugin = pluginsByName.get(row.name)!
      const providers = new Set<string>()
      for (const service of plugin.requires) {
        const provider = providerByService.get(service.key)
        if (provider === undefined) {
          return yield* Effect.fail(
            new PluginError({
              code: 'missing-provider',
              message: `row ${row.id} requires ${service.key}, but no enabled plugin provides it`,
              pluginId: row.id,
              service: service.key,
            }),
          )
        }
        providers.add(provider.id)
      }
      dependencies.set(row.id, [...providers])
    }
    return dependencies
  })

const decodeConfig = (
  row: PluginRow,
  plugin: Plugin<any, any, any>,
): Effect.Effect<any, PluginError, never> =>
  Schema.decodeUnknownEffect(plugin.config)(row.config ?? {}).pipe(
    Effect.mapError(
      (issue) =>
        new PluginError({
          code: 'config',
          message: `config of ${row.id} is invalid: ${issue.message}`,
          pluginId: row.id,
        }),
    ),
  ) as Effect.Effect<any, PluginError, never>

const buildLayers = (
  ordered: ReadonlyArray<PluginRow>,
  pluginsByName: PluginMap,
  dependencies: ReadonlyMap<string, ReadonlyArray<string>>,
): Effect.Effect<ReadonlyMap<string, Layer.Layer<any, any, any>>, PluginError> =>
  Effect.gen(function* () {
    const built = new Map<string, Layer.Layer<any, any, any>>()
    for (const row of ordered) {
      const plugin = pluginsByName.get(row.name)!
      const config = yield* decodeConfig(row, plugin)
      const layer = plugin.layer(config) as Layer.Layer<any, any, any>
      const deps = (dependencies.get(row.id) ?? []).map((id) => built.get(id)!)
      built.set(
        row.id,
        deps.length === 0 ? layer : Layer.provide(layer, Layer.mergeAll(...toNonEmpty(deps))),
      )
    }
    return built
  })

const mergeLayers = (
  layers: ReadonlyArray<Layer.Layer<any, any, any>>,
): Layer.Layer<any, any, any> =>
  (layers.length === 0 ? Layer.empty : Layer.mergeAll(...toNonEmpty(layers))) as Layer.Layer<
    any,
    any,
    any
  >

/**
 * Merges the profile layers and builds one layer in dependency order.
 *
 * Fails before building anything when a row names an unknown plugin, two rows
 * provide the same service, a required service has no provider, the providers
 * form a cycle, or a config does not match its plugin schema. A failure while
 * the returned layer is built releases the already-built plugins in reverse.
 */
export function loadProfile(
  options: LoadProfileOptions,
): Effect.Effect<Layer.Layer<any, PluginError, never>, PluginError> {
  return Effect.gen(function* () {
    const pluginsByName = yield* pluginMap(options.plugins)
    const enabled = mergeRows(options.layers).filter(isRowEnabled)
    yield* requireKnownPlugins(enabled, pluginsByName)
    const providerByService = yield* providerIndex(enabled, pluginsByName)
    const dependencies = yield* requireProviders(enabled, pluginsByName, providerByService)
    const ordered = yield* topologicalOrder(enabled, dependencies)
    const built = yield* buildLayers(ordered, pluginsByName, dependencies)
    return mergeLayers([...built.values()]) as Layer.Layer<any, PluginError, never>
  })
}
