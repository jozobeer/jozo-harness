import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { Context, Effect, Layer } from 'effect'
import { describe, expect, test } from 'vitest'
import type { ToolError } from '@jozo-harness/tools'
import {
  containedPath,
  expandHome,
  makeWorkspaceDependenciesTool,
  resolveWorkspaceDependencies,
  workspaceDependenciesPlugin,
  WorkspaceDependenciesTools,
  type WorkspaceDependenciesValue,
} from '../src/index.ts'

const run = promisify(execFile)

const python = 'dependencies/python/bin/python3'
const node = 'dependencies/node/bin/node'

/** A payload directory holding the files the test names, with runtime.json when given. */
const payload = async (
  manifest: unknown,
  files: Readonly<Record<string, string>> = {},
): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'jozo-harness-runtimes-'))
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, body)
    await chmod(full, 0o755)
  }
  if (manifest !== undefined) {
    await writeFile(join(root, 'runtime.json'), JSON.stringify(manifest))
  }
  return root
}

const script = (name: string): string => '#!/bin/sh\necho ' + name + ' "$@"\n'

interface Outcome {
  readonly value: WorkspaceDependenciesValue | undefined
  readonly error: ToolError | undefined
}

const resolve = async (dir: string): Promise<Outcome> =>
  Effect.runPromise(
    Effect.match(resolveWorkspaceDependencies(dir), {
      onFailure: (error) => ({ value: undefined, error }),
      onSuccess: (value) => ({ value, error: undefined }),
    }),
  )

const call = (dir: string): Promise<Outcome> =>
  Effect.runPromise(
    Effect.match(
      makeWorkspaceDependenciesTool(dir).execute(
        {},
        { sessionId: 's1', cwd: '/work', callId: 'c1' },
      ),
      {
        onFailure: (error) => ({ value: undefined, error }),
        onSuccess: (value) => ({ value, error: undefined }),
      },
    ),
  )

describe('expandHome', () => {
  test('expands a leading home marker and leaves any other path alone', () => {
    expect(expandHome('~')).toBe(homedir())
    expect(expandHome('~/runtimes')).toBe(join(homedir(), 'runtimes'))
    expect(expandHome('/opt/jzh/runtimes')).toBe('/opt/jzh/runtimes')
  })
})

describe('containedPath', () => {
  test('keeps a relative entry inside the payload and refuses one that climbs out', () => {
    expect(containedPath('/payload', python)).toBe(join('/payload', python))
    expect(containedPath('/payload', '../outside/node')).toBeUndefined()
    expect(containedPath('/payload', '/usr/local/bin/node')).toBeUndefined()
    expect(containedPath('/payload', '')).toBeUndefined()
  })
})

describe('workspace_dependencies tool', () => {
  test('returns absolute paths for the runtimes the payload ships', async () => {
    const root = await payload(
      { python, node },
      { [python]: script('bundled-python'), [node]: script('bundled-node') },
    )
    try {
      const { value, error } = await resolve(root)

      expect(error).toBeUndefined()
      expect(value?.root).toBe(await realpath(root))
      expect(value?.python).toBe(await realpath(join(root, python)))
      expect(value?.node).toBe(await realpath(join(root, node)))
      expect(value?.pnpm).toBeUndefined()
      expect(value?.missing).toEqual(['pnpm'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('lists every runtime the payload does not ship as missing', async () => {
    const root = await payload({ python }, { [python]: script('bundled-python') })
    try {
      const { value } = await resolve(root)

      expect(value?.missing).toEqual(['node', 'pnpm'])
      expect(value?.node).toBeUndefined()
      expect(value?.pnpm).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('returns pnpm beside the runtimes when the payload ships all three', async () => {
    const pnpm = 'dependencies/pnpm/bin/pnpm.mjs'
    const root = await payload(
      { python, node, pnpm },
      { [python]: script('p'), [node]: script('n'), [pnpm]: script('pnpm') },
    )
    try {
      const { value } = await resolve(root)

      expect(value?.pnpm).toBe(await realpath(join(root, pnpm)))
      expect(value?.missing).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('runs the returned python path from bash', async () => {
    const root = await payload({ python }, { [python]: script('bundled-python') })
    try {
      const { value } = await resolve(root)
      if (value === undefined) throw new Error('the payload did not resolve')
      const { stdout } = await run('bash', ['-c', value.python + ' --version'])

      expect(stdout).toBe('bundled-python --version\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('refuses a manifest entry that leaves the payload', async () => {
    const root = await payload({ python, node: '../outside/node' }, { [python]: script('p') })
    try {
      const { error } = await resolve(root)

      expect(error?.code).toBe('unavailable')
      expect(error?.message).toContain('outside')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('refuses a runtime whose link resolves outside the payload', async () => {
    const root = await payload({ python, node }, { [python]: script('p') })
    const outside = await mkdtemp(join(tmpdir(), 'jozo-harness-runtimes-outside-'))
    try {
      const elsewhere = join(outside, 'node')
      await writeFile(elsewhere, script('outside-node'))
      await chmod(elsewhere, 0o755)
      await mkdir(dirname(join(root, node)), { recursive: true })
      await symlink(elsewhere, join(root, node))

      const { error } = await resolve(root)

      expect(error?.code).toBe('unavailable')
      expect(error?.message).toContain('outside')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('says the payload is not installed when its directory is absent', async () => {
    const { error } = await resolve(join(tmpdir(), 'jozo-harness-no-such-payload'))

    expect(error?.code).toBe('unavailable')
    expect(error?.message).toContain('not there')
  })

  test('says a payload without runtime.json is no payload at all', async () => {
    const root = await payload(undefined)
    try {
      const { error } = await resolve(root)

      expect(error?.code).toBe('unavailable')
      expect(error?.message).toContain('runtime.json')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('says a manifest that is not JSON cannot be read', async () => {
    const root = await payload(undefined)
    try {
      await writeFile(join(root, 'runtime.json'), '{ not json')

      const { error } = await resolve(root)

      expect(error?.code).toBe('unavailable')
      expect(error?.message).toContain('not valid JSON')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('says a manifest without python is not a manifest', async () => {
    const root = await payload({ node })
    try {
      const { error } = await resolve(root)

      expect(error?.code).toBe('unavailable')
      expect(error?.message).toContain('must name python')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('says which runtime the payload has no file for', async () => {
    const root = await payload({ python: 'dependencies/python/bin/python3' })
    try {
      const { error } = await resolve(root)

      expect(error?.code).toBe('unavailable')
      expect(error?.message).toContain('no such file')
      expect(error?.message).toContain('python')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('says which runtime is not an executable file', async () => {
    const root = await payload({ python }, { [python]: script('p') })
    try {
      await chmod(join(root, python), 0o644)
      const notExecutable = await resolve(root)

      expect(notExecutable.error?.message).toContain('not executable')

      await rm(join(root, python))
      await mkdir(join(root, python), { recursive: true })
      const notAFile = await resolve(root)

      expect(notAFile.error?.message).toContain('not a file')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('renders the paths as one JSON block', async () => {
    const root = await payload({ python }, { [python]: script('p') })
    try {
      const { value } = await resolve(root)
      if (value === undefined) throw new Error('the payload did not resolve')
      const tool = makeWorkspaceDependenciesTool(root)

      expect(tool.output.render({}, value)).toEqual([
        { type: 'text', text: JSON.stringify(value, undefined, 2) },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('is safe to run beside another call and reports no error by itself', async () => {
    const root = await payload({ python }, { [python]: script('p') })
    try {
      const tool = makeWorkspaceDependenciesTool(root)
      const { value, error } = await call(root)

      expect(tool.isConcurrencySafe?.({})).toBe(true)
      expect(error).toBeUndefined()
      expect(value?.python).toBe(await realpath(join(root, python)))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('workspace-dependencies plugin', () => {
  test('hands the tool built from the payload the row configured', async () => {
    const root = await payload({ python }, { [python]: script('p') })
    try {
      const built = Effect.runSync(
        Effect.scoped(
          Effect.gen(function* () {
            const services = yield* Layer.build(workspaceDependenciesPlugin.layer({ dir: root }))
            return Context.get(services, WorkspaceDependenciesTools)
          }),
        ),
      )

      expect(built.map((tool) => tool.name)).toEqual(['workspace_dependencies'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
