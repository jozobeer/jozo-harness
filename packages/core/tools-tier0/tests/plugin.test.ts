import { kernelPlugin, loadProfile } from '@jozo-harness/kernel'
import { safetyPlugin } from '@jozo-harness/safety'
import { systemPromptPlugin } from '@jozo-harness/system-prompt'
import { Context, Effect, Layer } from 'effect'
import { describe, expect, test } from 'vitest'
import { join } from 'node:path'
import { Tier0Tools, fileReaderOf, tier0Plugin } from '../src/index.ts'

/** The rows a profile writes: the kernel, the prompt, the sandbox, and the tools. */
const layersOf = (tier0: Readonly<Record<string, unknown>>) => [
  [
    { id: 'kernel', name: '@jozo-harness/kernel', config: {} },
    { id: 'system-prompt', name: '@jozo-harness/system-prompt', config: {} },
    {
      id: 'safety',
      name: '@jozo-harness/safety',
      config: { preset: 'workspace-write', sandbox: 'auto', writableRoots: ['/work'] },
    },
    { id: 'tier0', name: '@jozo-harness/tools-tier0', config: tier0 },
  ],
]

const build = (tier0: Readonly<Record<string, unknown>>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const layer = yield* loadProfile({
          plugins: [kernelPlugin, systemPromptPlugin, safetyPlugin, tier0Plugin],
          layers: layersOf(tier0),
        })
        const context = yield* Layer.build(layer)
        // No approval seam here: this test watches the sandbox the row resolved.
        return Context.get(context, Tier0Tools)(undefined).map((tool) => tool.name)
      }),
    ),
  )

describe('tier0Plugin', () => {
  test('resolves the tool list with the sandbox from the safety row', async () => {
    expect(await build({})).toEqual(['read', 'write', 'edit', 'glob', 'grep', 'bash'])
  })

  test('a host whose bwrap cannot be reached fails the load instead of running unconfined', async () => {
    // `reach` is a program that is not there, so the probe cannot answer. A
    // workspace-write on a host that cannot hold it is a promise nothing keeps.
    await expect(build({ ssh: { reach: ['jzh-no-such-host'], root: '/tmp' } })).rejects.toThrow(
      'cannot be used',
    )
  })

  test('a mode the sandbox does not have is refused before any host is reached', async () => {
    await expect(
      build({ ssh: { reach: ['true'], root: '/tmp', mode: 'writable-by-anyone' } }),
    ).rejects.toThrow()
  })
})

describe('the file reader a tool of its own gets', () => {
  test('a profile without a host reads this disk', async () => {
    const read = fileReaderOf([{ name: '@jozo-harness/tools-tier0', config: {} }])
    const bytes = await Effect.runPromise(read(join(process.cwd(), 'package.json')))

    expect(new TextDecoder().decode(bytes)).toContain('@jozo-harness/root')
  })

  test('a profile with a host reads the host, not this disk', async () => {
    // The reach is a program that is not there, so a read has to fail: reaching
    // the local disk instead would answer with this machine's bytes.
    const read = fileReaderOf([
      {
        name: '@jozo-harness/tools-tier0',
        config: { ssh: { reach: ['jzh-no-such-host'], root: '/srv/work' } },
      },
    ])

    const result = await Effect.runPromise(Effect.result(read('/srv/work/notes.txt')))

    expect(result._tag).toBe('Failure')
  })
})
