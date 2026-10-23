import { kernelPlugin, loadProfile } from '@jozo-harness/kernel'
import { systemPromptPlugin } from '@jozo-harness/system-prompt'
import { Context, Effect, Layer } from 'effect'
import { describe, expect, test } from 'vitest'
import { SystemPrompt } from '@jozo-harness/system-prompt'
import {
  Policy,
  Sandbox,
  safetyPlugin,
  sandboxContextText,
  sandboxLayerFor,
  seatbeltStartupNotice,
  type SeatbeltProbeResult,
} from '../src/index.ts'

/** The backend `auto` resolves to where this test runs. */
const native = process.platform === 'darwin' ? 'seatbelt' : 'bwrap'

const build = (config: unknown) =>
  Effect.scoped(
    Effect.gen(function* () {
      const layer = yield* loadProfile({
        plugins: [kernelPlugin, systemPromptPlugin, safetyPlugin],
        layers: [
          [
            { id: 'kernel', name: '@jozo-harness/kernel', config: {} },
            { id: 'system-prompt', name: '@jozo-harness/system-prompt', config: {} },
            { id: 'safety', name: '@jozo-harness/safety', config },
          ],
        ],
      })
      const context = yield* Layer.build(layer)
      const policy = Context.get(context, Policy)
      return {
        preset: policy.preset,
        mode: policy.mode,
        sandbox: Context.get(context, Sandbox).name,
        sandboxMode: Context.get(context, Sandbox).mode,
      }
    }),
  )

describe('safetyPlugin', () => {
  test('the permission facts say what they mean for a call', async () => {
    const text = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const layer = yield* loadProfile({
            plugins: [kernelPlugin, systemPromptPlugin, safetyPlugin],
            layers: [
              [
                { id: 'kernel', name: '@jozo-harness/kernel', config: {} },
                { id: 'system-prompt', name: '@jozo-harness/system-prompt', config: {} },
                {
                  id: 'safety',
                  name: '@jozo-harness/safety',
                  config: { preset: 'workspace-write', sandbox: 'none' },
                },
              ],
            ],
          })
          const context = yield* Layer.build(layer)
          return yield* Context.get(context, SystemPrompt).runtimeContext({ cwd: '/work' })
        }),
      ),
    )

    expect(text).toContain('approval: workspace-write (')
    expect(text).toContain('sandbox: none (')
  })

  test('the preset names the mode commands run under', async () => {
    const observed = await Effect.runPromise(build({ preset: 'read-only' }))

    expect(observed.preset).toBe('read-only')
    expect(observed.mode).toBe('read-only')
    // No sandbox key at all: the provider this platform has is what runs, and it
    // runs commands under the mode the preset names.
    expect(observed.sandbox).toBe(native)
    expect(observed.sandboxMode).toBe('read-only')
  })

  test('a confined workspace-write stays confined', async () => {
    const observed = await Effect.runPromise(
      build({ preset: 'workspace-write', sandbox: native, writableRoots: ['/work'] }),
    )

    expect(observed.preset).toBe('workspace-write')
    expect(observed.mode).toBe('workspace-write')
    expect(observed.sandbox).toBe(native)
    expect(observed.sandboxMode).toBe('workspace-write')
  })

  test('running without a sandbox is an explicit choice', async () => {
    const observed = await Effect.runPromise(build({ preset: 'workspace-write', sandbox: 'none' }))

    expect(observed.sandbox).toBe('none')
    expect(observed.sandboxMode).toBe('danger-full-access')
  })

  test('the full preset asks the provider for no confinement', async () => {
    const observed = await Effect.runPromise(build({ preset: 'full' }))

    expect(observed.mode).toBe('danger-full-access')
    expect(observed.sandboxMode).toBe('danger-full-access')
  })

  test('asking for seatbelt where it cannot run fails instead of running loose', async () => {
    const failed = await Effect.runPromise(
      Effect.scoped(
        Effect.result(
          Layer.build(sandboxLayerFor({ preset: 'full', sandbox: 'seatbelt' }, 'linux')),
        ),
      ),
    )

    expect(failed._tag).toBe('Failure')
    if (failed._tag === 'Failure') {
      expect(String(failed.failure)).toContain('sandbox: none')
    }
  })
})
describe('seatbelt startup notice', () => {
  test('probes once and names a seatbelt that cannot be applied', () => {
    const calls: Array<number> = []
    const notice = seatbeltStartupNotice(
      { preset: 'workspace-write', sandbox: 'auto' },
      'darwin',
      () => {
        calls.push(1)
        return 'refused'
      },
    )

    expect(notice).toContain('cannot be applied inside another sandbox')
    expect(calls).toHaveLength(1)
  })

  test('says nothing when the probe applies or the run uses another backend', () => {
    const refused = (): 'refused' => 'refused'

    expect(
      seatbeltStartupNotice(
        { preset: 'workspace-write', sandbox: 'auto' },
        'darwin',
        () => 'applies',
      ),
    ).toBeUndefined()
    expect(
      seatbeltStartupNotice({ preset: 'workspace-write', sandbox: 'auto' }, 'linux', refused),
    ).toBeUndefined()
    // The full preset wraps nothing, so a refused profile never refuses a command.
    expect(
      seatbeltStartupNotice({ preset: 'full', sandbox: 'seatbelt' }, 'darwin', refused),
    ).toBeUndefined()
    expect(
      seatbeltStartupNotice({ preset: 'workspace-write', sandbox: 'none' }, 'darwin', refused),
    ).toBeUndefined()
  })
})

describe('sandbox context line', () => {
  const lineFor = (probe: SeatbeltProbeResult | undefined): string =>
    sandboxContextText(
      { preset: 'workspace-write', sandbox: 'auto' },
      { _tag: 'available', name: 'seatbelt', enforcement: 'full' },
      probe,
    )

  test('names a refused seatbelt at the end of the sandbox line', () => {
    const line = lineFor('refused')

    expect(line).toContain('; the seatbelt cannot be applied here, so commands are refused')
    expect(line.endsWith('refused')).toBe(true)
  })

  test('keeps the line it had when the seatbelt applies or the binary is missing', () => {
    const applies = lineFor('applies')

    expect(applies).not.toContain('cannot be applied')
    expect(lineFor('missing')).toBe(applies)
  })
})

describe('sandbox selection', () => {
  test('auto takes the backend this platform has', async () => {
    const context = await Effect.runPromise(
      Effect.scoped(
        Layer.build(
          sandboxLayerFor({ preset: 'workspace-write', sandbox: 'auto' }, 'linux', () => true),
        ),
      ),
    )
    const sandbox = Context.get(context, Sandbox)

    expect(sandbox.name).toBe('bwrap')
    expect(sandbox.mode).toBe('workspace-write')
    expect(sandbox.enforcement).toBe('full')
  })

  test('auto without a usable bwrap stops instead of running loose', async () => {
    const failed = await Effect.runPromise(
      Effect.scoped(
        Effect.result(
          Layer.build(
            sandboxLayerFor({ preset: 'workspace-write', sandbox: 'auto' }, 'linux', () => false),
          ),
        ),
      ),
    )

    expect(failed._tag).toBe('Failure')
    if (failed._tag === 'Failure') {
      const message = String(failed.failure)
      expect(message).toContain('bwrap')
      expect(message).toContain('landlock')
      expect(message).toContain('sandbox: none')
    }
  })

  test('an explicit bwrap where it cannot run is refused instead of ignored', async () => {
    const failed = await Effect.runPromise(
      Effect.scoped(
        Effect.result(
          Layer.build(sandboxLayerFor({ preset: 'full', sandbox: 'bwrap' }, 'darwin', () => true)),
        ),
      ),
    )

    expect(failed._tag).toBe('Failure')
    if (failed._tag === 'Failure') {
      expect(String(failed.failure)).toContain('Linux only')
    }
  })

  test('auto on a platform with no backend stops instead of running loose', async () => {
    const failed = await Effect.runPromise(
      Effect.scoped(
        Effect.result(
          Layer.build(sandboxLayerFor({ preset: 'full', sandbox: 'auto' }, 'win32', () => false)),
        ),
      ),
    )

    expect(failed._tag).toBe('Failure')
    if (failed._tag === 'Failure') {
      expect(String(failed.failure)).toContain('win32')
      expect(String(failed.failure)).toContain('sandbox: none')
    }
  })
})
