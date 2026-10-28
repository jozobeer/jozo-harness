import { HooksLive } from '@jozo-harness/kernel'
import type { AskRequested, AskShape } from '@jozo-harness/safety'
import {
  ToolError,
  Tools,
  toolsLayer,
  type ToolDefinition,
  type ToolExecutionResult,
} from '@jozo-harness/tools'
import { Context, Effect, Layer } from 'effect'
import { describe, expect, test } from 'vitest'
import {
  makePluginTool,
  type PluginChange,
  type PluginHost,
  type PluginRowSummary,
} from '../src/index.ts'

const PROFILE_ROWS: ReadonlyArray<PluginRowSummary> = [
  { id: 'kernel', name: '@jozo-harness/kernel', disabled: false },
  { id: 'tier1', name: '@jozo-harness/tools-tier1', disabled: false },
]

const KNOWN = [
  '@jozo-harness/kernel',
  '@jozo-harness/tools-tier1',
  '@jozo-harness/mcp',
  '@jozo-harness/lsp',
]

/** A settings file that only exists in this test's memory. */
const fakeHost = (answer = 'approve', mounted: ReadonlyArray<string> = [], fail?: string) => {
  const settings: Array<PluginRowSummary> = []
  const asked: Array<AskRequested> = []
  const changes: Array<PluginChange> = []
  const host: PluginHost = {
    rows: () => [...PROFILE_ROWS, ...settings],
    known: () => KNOWN,
    change: (change) =>
      Effect.gen(function* () {
        if (fail !== undefined) {
          return yield* Effect.fail(new ToolError({ code: 'execution', message: fail }))
        }
        changes.push(change)
        if (change.kind === 'remove') {
          const index = settings.findIndex((row) => row.id === change.id)
          if (index >= 0) settings.splice(index, 1)
          return { rows: [...settings], mounted: [], detached: true, unmounted: [] }
        }
        if (change.kind === 'add') {
          settings.push({ id: change.id, name: change.name, disabled: false })
          return { rows: [...settings], mounted, detached: false, unmounted: [] }
        }
        const index = settings.findIndex((each) => each.id === change.id)
        if (index >= 0) {
          settings[index] = { id: change.id, name: change.name, disabled: change.disabled }
        }
        return { rows: [...settings], mounted: [], detached: false, unmounted: [] }
      }),
    ask: {
      ask: (request: AskRequested) => {
        asked.push(request)
        return Effect.succeed(answer)
      },
    } as unknown as AskShape,
  }
  return { host, asked, changes, settings }
}

const call = (
  tool: ToolDefinition<any, any>,
  args: unknown,
): Effect.Effect<ToolExecutionResult | undefined, ToolError, never> =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(Layer.provideMerge(toolsLayer, HooksLive))
      const tools = Context.get(context, Tools)
      yield* tools.register(tool)
      return yield* tools.call({
        callId: 'call-9',
        tool: tool.name,
        arguments: JSON.stringify(args),
        context: { sessionId: 's1', cwd: '/work', callId: 'call-9' },
      })
    }),
  )

const textOf = (result: ToolExecutionResult | undefined): string =>
  (result?.content ?? []).flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')

describe('the plugin tool', () => {
  test('list shows the rows this run was built from', async () => {
    const { host, changes } = fakeHost()

    const result = await Effect.runPromise(call(makePluginTool(host), { action: 'list' }))

    expect(changes).toEqual([])
    expect(textOf(result)).toContain('kernel @jozo-harness/kernel')
    expect(textOf(result)).toContain('tier1 @jozo-harness/tools-tier1')
    expect(textOf(result)).toContain('next start')
  })

  test('adding a row asks first, then writes it', async () => {
    const { host, asked, changes } = fakeHost()

    const result = await Effect.runPromise(
      call(makePluginTool(host), { action: 'add', id: 'mcp', name: '@jozo-harness/mcp' }),
    )

    expect(asked).toHaveLength(1)
    expect(asked[0]?.id).toBe('call-9')
    expect(asked[0]?.options).toEqual(['approve', 'keep the rows as they are'])
    expect(changes).toEqual([{ kind: 'add', id: 'mcp', name: '@jozo-harness/mcp' }])
    expect(result?.value).toMatchObject({ changed: true })
    expect(textOf(result)).toContain('starts again')
  })

  test('a row the build does not have is refused before anything is asked', async () => {
    const { host, asked, changes } = fakeHost()

    const result = await Effect.runPromise(
      call(makePluginTool(host), { action: 'add', id: 'x', name: 'left-pad' }),
    )

    expect(result?.isError).toBe(true)
    expect(textOf(result)).toContain('this build does not have left-pad')
    expect(textOf(result)).toContain('@jozo-harness/mcp')
    expect(asked).toEqual([])
    expect(changes).toEqual([])
  })

  test('a refusal from the human changes nothing', async () => {
    const { host, asked, changes } = fakeHost('keep the rows as they are')

    const result = await Effect.runPromise(
      call(makePluginTool(host), { action: 'set', id: 'tier1', disabled: true }),
    )

    expect(asked).toHaveLength(1)
    expect(changes).toEqual([])
    expect(result?.isError).toBe(false)
    expect(result?.value).toMatchObject({ changed: false })
    expect(textOf(result)).toContain('kept the plugin rows as they are')
  })

  test('disable and remove name the row they touch', async () => {
    const { host, changes } = fakeHost()
    await Effect.runPromise(
      call(makePluginTool(host), { action: 'add', id: 'mcp', name: '@jozo-harness/mcp' }),
    )

    await Effect.runPromise(
      call(makePluginTool(host), { action: 'set', id: 'mcp', disabled: true }),
    )
    await Effect.runPromise(call(makePluginTool(host), { action: 'remove', id: 'mcp' }))

    expect(changes).toEqual([
      { kind: 'add', id: 'mcp', name: '@jozo-harness/mcp' },
      { kind: 'set-disabled', id: 'mcp', name: '@jozo-harness/mcp', disabled: true },
      { kind: 'remove', id: 'mcp' },
    ])
  })

  test('remove needs an id that exists', async () => {
    const { host, asked } = fakeHost()

    const result = await Effect.runPromise(
      call(makePluginTool(host), { action: 'remove', id: 'nowhere' }),
    )

    expect(result?.isError).toBe(true)
    expect(textOf(result)).toContain('no row with that id: nowhere')
    expect(asked).toEqual([])
  })

  test('set needs an id that exists', async () => {
    const { host, asked } = fakeHost()

    const result = await Effect.runPromise(
      call(makePluginTool(host), { action: 'set', id: 'nowhere', disabled: true }),
    )

    expect(result?.isError).toBe(true)
    expect(textOf(result)).toContain('no row with that id: nowhere')
    expect(asked).toEqual([])
  })

  test('an added row the host wires now says the tools are live', async () => {
    const { host } = fakeHost('approve', ['lsp'])

    const result = await Effect.runPromise(
      call(makePluginTool(host), { action: 'add', id: 'lsp', name: '@jozo-harness/lsp' }),
    )

    expect(result?.value).toMatchObject({ changed: true })
    expect(textOf(result)).toContain('lsp is wired into this run now')
  })

  test('a mount failure leaves the rows and the settings as they were', async () => {
    const { host, asked, changes, settings } = fakeHost('approve', [], 'the row did not build')

    const result = await Effect.runPromise(
      call(makePluginTool(host), { action: 'add', id: 'lsp', name: '@jozo-harness/lsp' }),
    )

    expect(asked).toHaveLength(1)
    expect(changes).toEqual([])
    expect(settings).toEqual([])
    expect(result?.isError).toBe(true)
    expect(textOf(result)).toContain('the row did not build')
    expect(host.rows()).toEqual(PROFILE_ROWS)
  })
})
