import { describe, expect, test } from 'vitest'
import { Context, Effect, Layer, Schema } from 'effect'
import {
  PluginError,
  loadPluginRow,
  loadProfile,
  mergeRows,
  parseProfile,
  renderConfig,
  type Plugin,
  type PluginRow,
} from '../src/index.ts'

class Alpha extends Context.Service<Alpha, { readonly id: string }>()('test/Alpha') {}
class Beta extends Context.Service<Beta, { readonly id: string; readonly alpha: string }>()(
  'test/Beta',
) {}

const alphaPlugin: Plugin<{ readonly label: string }, Alpha, never> = {
  name: 'alpha',
  config: Schema.Struct({ label: Schema.String }),
  provides: [Alpha],
  requires: [],
  layer: (config) => Layer.succeed(Alpha, { id: config.label }),
}

const alphaAlsoPlugin: Plugin<{}, Alpha, never> = {
  name: 'alpha-also',
  config: Schema.Struct({}),
  provides: [Alpha],
  requires: [],
  layer: () => Layer.succeed(Alpha, { id: 'alpha-also' }),
}

const betaPlugin: Plugin<{}, Beta, Alpha> = {
  name: 'beta',
  config: Schema.Struct({}),
  provides: [Beta],
  requires: [Alpha],
  layer: () =>
    Layer.effect(
      Beta,
      Effect.gen(function* () {
        const alpha = yield* Alpha
        return { id: 'beta', alpha: alpha.id }
      }),
    ),
}

const alphaRequiresBetaPlugin: Plugin<{}, Alpha, Beta> = {
  name: 'alpha-requires-beta',
  config: Schema.Struct({}),
  provides: [Alpha],
  requires: [Beta],
  layer: () =>
    Layer.effect(
      Alpha,
      Effect.gen(function* () {
        const beta = yield* Beta
        return { id: beta.id }
      }),
    ),
}

const betaRequiresAlphaPlugin: Plugin<{}, Beta, Alpha> = {
  name: 'beta-requires-alpha',
  config: Schema.Struct({}),
  provides: [Beta],
  requires: [Alpha],
  layer: () =>
    Layer.effect(
      Beta,
      Effect.gen(function* () {
        const alpha = yield* Alpha
        return { id: 'beta', alpha: alpha.id }
      }),
    ),
}

const row = (id: string, name: string, config?: unknown, disabled?: boolean): PluginRow => ({
  id,
  name,
  ...(config === undefined ? {} : { config }),
  ...(disabled === undefined ? {} : { disabled }),
})

const loadError = (
  plugins: ReadonlyArray<Plugin<any, any, any>>,
  layers: ReadonlyArray<ReadonlyArray<PluginRow>>,
) => Effect.runPromise(Effect.flip(loadProfile({ plugins, layers })))

describe('mergeRows', () => {
  test('overlays rows by id and appends new rows in first-seen order', () => {
    const merged = mergeRows([
      [row('alpha', 'alpha', { label: 'base' }), row('beta', 'beta', {})],
      [row('alpha', 'alpha', { extra: true }), row('gamma', 'gamma', {}, true)],
    ])

    expect(merged.map((r) => r.id)).toEqual(['alpha', 'beta', 'gamma'])
    expect(merged[0]?.config).toEqual({ label: 'base', extra: true })
    expect(merged[2]?.disabled).toBe(true)
  })

  test('a later layer can disable a row', () => {
    const merged = mergeRows([[row('alpha', 'alpha')], [row('alpha', 'alpha', undefined, true)]])
    expect(merged[0]?.disabled).toBe(true)
  })
})

describe('loadProfile', () => {
  test('builds a layer whose services resolve through their dependencies', async () => {
    const label = crypto.randomUUID()

    const beta = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const layer = yield* loadProfile({
            plugins: [alphaPlugin, betaPlugin],
            layers: [[row('alpha', 'alpha', { label }), row('beta', 'beta')]],
          })
          const context = yield* Layer.build(layer)
          return Context.get(context, Beta)
        }),
      ),
    )

    expect(beta).toEqual({ id: 'beta', alpha: label })
  })

  test('fails with missing-provider when a required service has no provider', async () => {
    const error = await loadError([betaPlugin], [[row('beta', 'beta')]])
    expect(error).toBeInstanceOf(PluginError)
    expect(error.code).toBe('missing-provider')
    expect(error.message).toContain('test/Alpha')
  })

  test('fails with dependency-cycle when providers require each other', async () => {
    const error = await loadError(
      [alphaRequiresBetaPlugin, betaRequiresAlphaPlugin],
      [[row('alpha', 'alpha-requires-beta'), row('beta', 'beta-requires-alpha')]],
    )
    expect(error.code).toBe('dependency-cycle')
  })

  test('fails with unknown-plugin when a row names an unregistered plugin', async () => {
    const error = await loadError([alphaPlugin], [[row('ghost', 'ghost')]])
    expect(error.code).toBe('unknown-plugin')
  })

  test('fails with config when the row config does not match the plugin schema', async () => {
    const error = await loadError([alphaPlugin], [[row('alpha', 'alpha', { label: 42 })]])
    expect(error.code).toBe('config')
    expect(error.pluginId).toBe('alpha')
  })

  test('skips disabled rows', async () => {
    const error = await loadError(
      [alphaPlugin, betaPlugin],
      [[row('alpha', 'alpha', undefined, true), row('beta', 'beta')]],
    )
    expect(error.code).toBe('missing-provider')
  })

  test('fails with duplicate-provider when two rows provide the same service', async () => {
    const error = await loadError(
      [alphaPlugin, alphaAlsoPlugin],
      [[row('alpha', 'alpha'), row('alpha-2', 'alpha-also')]],
    )
    expect(error.code).toBe('duplicate-provider')
  })
})

describe('renderConfig', () => {
  test('renders the effective rows and their config', () => {
    const text = renderConfig([
      row('alpha', 'alpha', { label: 'x' }),
      row('beta', 'beta', {}),
      row('gamma', 'gamma', undefined, true),
    ])
    expect(text).toBe(
      'plugin rows in effect (profiles + settings file + --patch):\n  - id=alpha name=alpha config={"label":"x"}\n  - id=beta name=beta config={}\n  - id=gamma name=gamma disabled\n',
    )
  })
})

describe('parseProfile', () => {
  test('parses a YAML profile into rows', async () => {
    const label = crypto.randomUUID()
    const text = [
      'name: test',
      'plugins:',
      '  - id: alpha',
      '    name: alpha',
      '    config:',
      `      label: ${label}`,
    ].join('\n')

    const profile = await Effect.runPromise(parseProfile(text))

    expect(profile.name).toBe('test')
    expect(profile.plugins).toEqual([{ id: 'alpha', name: 'alpha', config: { label } }])
  })

  test('fails with config when the YAML is malformed', async () => {
    const error = await Effect.runPromise(Effect.flip(parseProfile('name: [unclosed')))
    expect(error.code).toBe('config')
  })

  test('fails with config when the profile shape is wrong', async () => {
    const error = await Effect.runPromise(Effect.flip(parseProfile('name: test\nplugins: nope')))
    expect(error.code).toBe('config')
  })
})

describe('loader composition', () => {
  class Up extends Context.Service<Up, { readonly id: string }>()('test/Up') {}
  class Down extends Context.Service<Down, { readonly id: string }>()('test/Down') {}

  const upPlugin: Plugin<{}, Up, never> = {
    name: 'up',
    config: Schema.Struct({}),
    provides: [Up],
    requires: [],
    layer: () => Layer.succeed(Up, { id: 'up' }),
  }

  const downPlugin: Plugin<{}, Down, Up> = {
    name: 'down',
    config: Schema.Struct({}),
    provides: [Down],
    requires: [Up],
    layer: () =>
      Layer.effect(
        Down,
        Effect.gen(function* () {
          const up = yield* Up
          return { id: `${up.id}-down` }
        }),
      ),
  }

  test('a provided service reaches the built context through the loader', async () => {
    const built = await Effect.runPromise(
      Effect.gen(function* () {
        const layer = yield* loadProfile({
          plugins: [upPlugin, downPlugin],
          layers: [[row('up', 'up'), row('down', 'down')]],
        })
        const context = yield* Layer.build(layer)
        return Context.get(context, Down)
      }).pipe(Effect.scoped),
    )

    expect(built).toEqual({ id: 'up-down' })
  })
})

describe('loader composition with two dependencies', () => {
  class Base extends Context.Service<Base, { readonly id: string }>()('test/Base') {}
  class Also extends Context.Service<Also, { readonly tag: string }>()('test/Also') {}
  class Nested extends Context.Service<Nested, { readonly value: string }>()('test/Nested') {}

  const basePlugin: Plugin<{}, Base, never> = {
    name: 'base',
    config: Schema.Struct({}),
    provides: [Base],
    requires: [],
    layer: () => Layer.succeed(Base, { id: 'base' }),
  }

  const alsoPlugin: Plugin<{}, Also, never> = {
    name: 'also',
    config: Schema.Struct({}),
    provides: [Also],
    requires: [],
    layer: () => Layer.succeed(Also, { tag: 'also' }),
  }

  /** Mirrors `sessionsService`: a layer effect that reads a second service. */
  const nestedService: Effect.Effect<{ readonly value: string }, never, Also> = Effect.gen(
    function* () {
      const also = yield* Also
      return { value: `${also.tag}-nested` }
    },
  )

  const nestedPlugin: Plugin<{}, Nested, Base | Also> = {
    name: 'nested',
    config: Schema.Struct({}),
    provides: [Nested],
    requires: [Base, Also],
    layer: () =>
      Layer.effect(
        Nested,
        Effect.gen(function* () {
          yield* Base
          return yield* nestedService
        }),
      ),
  }

  test('reaches the context when the layer effect reads a second service', async () => {
    const built = await Effect.runPromise(
      Effect.gen(function* () {
        const layer = yield* loadProfile({
          plugins: [basePlugin, alsoPlugin, nestedPlugin],
          layers: [[row('base', 'base'), row('also', 'also'), row('nested', 'nested')]],
        })
        const context = yield* Layer.build(layer)
        return Context.get(context, Nested)
      }).pipe(Effect.scoped),
    )

    expect(built).toEqual({ value: 'also-nested' })
  })
})

describe('loadPluginRow', () => {
  test('builds one row over the services this run already holds', async () => {
    const label = crypto.randomUUID()
    const built = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* loadPluginRow({
            plugins: [alphaPlugin],
            row: row('alpha', 'alpha', { label }),
            context: Context.empty(),
          })
          return Context.get(context, Alpha)
        }),
      ),
    )

    expect(built).toEqual({ id: label })
  })

  test('refuses a row whose service this run already has', async () => {
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.flip(
          loadPluginRow({
            plugins: [alphaPlugin],
            row: row('alpha', 'alpha', { label: 'again' }),
            context: Context.make(Alpha, { id: 'running' }),
          }),
        ),
      ),
    )

    expect(error.code).toBe('duplicate-provider')
    expect(error.service).toBe('test/Alpha')
  })

  test('refuses a row whose dependency this run does not hold', async () => {
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.flip(
          loadPluginRow({
            plugins: [betaPlugin],
            row: row('beta', 'beta'),
            context: Context.empty(),
          }),
        ),
      ),
    )

    expect(error.code).toBe('missing-provider')
    expect(error.service).toBe('test/Alpha')
  })

  test('refuses a row whose config its schema rejects', async () => {
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.flip(
          loadPluginRow({
            plugins: [alphaPlugin],
            row: row('alpha', 'alpha', { label: 42 }),
            context: Context.empty(),
          }),
        ),
      ),
    )

    expect(error.code).toBe('config')
  })
})
