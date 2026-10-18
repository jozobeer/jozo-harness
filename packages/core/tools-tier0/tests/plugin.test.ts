import { kernelPlugin, loadProfile } from '@jozo-harness/kernel'
import { safetyPlugin } from '@jozo-harness/safety'
import { systemPromptPlugin } from '@jozo-harness/system-prompt'
import { Context, Effect, Layer } from 'effect'
import { describe, expect, test } from 'vitest'
import { Tier0Tools, tier0Plugin } from '../src/index.ts'

describe('tier0Plugin', () => {
  test('resolves the tool list with the sandbox from the safety row', async () => {
    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const layer = yield* loadProfile({
            plugins: [kernelPlugin, systemPromptPlugin, safetyPlugin, tier0Plugin],
            layers: [
              [
                { id: 'kernel', name: '@jozo-harness/kernel', config: {} },
                { id: 'system-prompt', name: '@jozo-harness/system-prompt', config: {} },
                {
                  id: 'safety',
                  name: '@jozo-harness/safety',
                  config: {
                    preset: 'workspace-write',
                    sandbox: 'auto',
                    writableRoots: ['/work'],
                  },
                },
                { id: 'tier0', name: '@jozo-harness/tools-tier0', config: {} },
              ],
            ],
          })
          const context = yield* Layer.build(layer)
          // No approval seam here: this test watches the sandbox the row resolved.
          const tools = Context.get(context, Tier0Tools)(undefined)
          return { names: tools.map((tool) => tool.name) }
        }),
      ),
    )

    expect(observed.names).toEqual(['read', 'write', 'edit', 'glob', 'grep', 'bash'])
  })
})
