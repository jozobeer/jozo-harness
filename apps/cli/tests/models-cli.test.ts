import { describe, expect, test } from 'vitest'
import { Effect } from 'effect'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseArgs } from '../src/args.ts'
import { startStubServer } from '@jozo-harness/test-support-stub'
import { main, type MainIo } from '../src/bin.ts'
/** Writes a file, making the directories above it, because the file may not be there yet. */
const writeFileDeep = async (path: string, text: string | Uint8Array): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

/** A provider that lists `ids`, records every path it saw, and every model a chat named. */
const serveProvider = async (ids: ReadonlyArray<string>, refusal = 500) => {
  const requested: Array<string> = []
  const seen: Array<string> = []
  const server = await startStubServer(async (request) => {
    const path = new URL(request.url).pathname
    seen.push(request.method + ' ' + path)
    if (path === '/v1/models') return Response.json({ data: ids.map((id) => ({ id })) })
    if (path === '/v1/chat/completions') {
      const body = (await request.json()) as { model: string }
      requested.push(body.model)
    }
    return new Response('stub', { status: refusal })
  })
  return { server, requested, seen, baseUrl: server.origin + '/v1' }
}

/**
 * Points the llm row at the stub under a key variable of its own, and keeps
 * sessions and the settings file (written only when given) in a temp dir.
 * `tearDown` undoes both.
 */
const setUp = async (baseUrl: string, settings?: string) => {
  const directory = await mkdtemp(join(tmpdir(), 'jozo-harness-models-'))
  const keyEnv = 'JZH_TEST_KEY_' + crypto.randomUUID().replaceAll('-', '_')
  process.env[keyEnv] = 'test-key'
  const patch = join(directory, 'local.yml')
  await writeFileDeep(
    patch,
    [
      'name: local',
      'plugins:',
      '  - id: llm',
      "    name: '@jozo-harness/llm-openai'",
      '    config:',
      '      baseUrl: ' + baseUrl,
      // The test points at its own stub; the bundled profile points every
      // request at the local Ollama daemon, so opt out of that route.
      '      localBaseUrl: ""',
      '      apiKeyEnv: ' + keyEnv,
      '  - id: session-jsonl',
      "    name: '@jozo-harness/session-jsonl'",
      '    config:',
      '      root: ' + join(directory, 'sessions'),
      // These tests count the requests the stub saw; a naming call is one more.
      '  - id: agent-loop',
      "    name: '@jozo-harness/agent-loop'",
      '    config:',
      '      title:',
      '        enabled: false',
      // The test process may itself be sandboxed; commands are not what this run tests.
      '  - id: safety',
      "    name: '@jozo-harness/safety'",
      '    config:',
      '      sandbox: none',
    ].join('\n'),
  )
  const config = join(directory, 'config.yaml')
  if (settings !== undefined) await writeFileDeep(config, settings)
  const tearDown = async () => {
    delete process.env[keyEnv]
    await rm(directory, { recursive: true, force: true })
  }
  return { tearDown, flags: ['--config', config, '--patch', patch] }
}

const collect = () => {
  const out: Array<string> = []
  const err: Array<string> = []
  const io: MainIo = {
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
    cwd: '/work',
  }
  return { io, out, err }
}

const randomIds = (count: number): Array<string> =>
  Array.from({ length: count }, () => 'm-' + crypto.randomUUID().slice(0, 8))

describe('parseArgs models', () => {
  test('a lone models word is the command, not a task', () => {
    const parsed = parseArgs(['models'])
    expect(parsed.models).toBe(true)
    expect(parsed.task).toBeUndefined()
  })

  test('models inside a longer task stays a task', () => {
    const parsed = parseArgs(['models', 'are', 'fun'])
    expect(parsed.models).toBe(false)
    expect(parsed.task).toBe('models are fun')
  })
})

describe('jzh models', () => {
  test('prints one route per line from the profile endpoint', async () => {
    const ids = randomIds(4)
    const { server, baseUrl } = await serveProvider(ids)
    const { tearDown, flags } = await setUp(baseUrl)
    const { io, out, err } = collect()

    const code = await Effect.runPromise(main(['models', ...flags], io))

    await server.stop()
    await tearDown()
    // The pair, so a failure says why: this one flaked once in forty runs of the suite.
    expect({ code, err }).toEqual({ code: 0, err: [] })
    expect(out.join('')).toBe(
      ids
        .map((id) => '127.0.0.1/' + id + '\n')
        .sort()
        .join(''),
    )
  })
})

describe('jzh models failures', () => {
  test('an unreachable provider is reported as one line and exits 1', async () => {
    const { server, baseUrl } = await serveProvider([])
    await server.stop()
    const { tearDown, flags } = await setUp(baseUrl)
    const { io, out, err } = collect()

    const code = await Effect.runPromise(main(['models', ...flags], io))

    await tearDown()
    expect(code).toBe(1)
    expect(out).toEqual([])
    expect(err).toHaveLength(1)
    expect(err[0]?.startsWith('jzh: cannot list models from ' + baseUrl + '/models: ')).toBe(true)
    expect(err[0]?.endsWith('\n')).toBe(true)
    expect(err[0]?.split('\n')).toHaveLength(2)
  })
})

describe('the model a run uses', () => {
  test('without a flag the settings file default is used', async () => {
    // A 400 is refused without a retry, so the run ends at the provider once.
    const { server, requested, seen, baseUrl } = await serveProvider([], 400)
    const model = 'm-' + crypto.randomUUID().slice(0, 8)
    const { tearDown, flags } = await setUp(baseUrl, 'model: x/' + model + '\n')
    const { io, err } = collect()

    const code = await Effect.runPromise(main([...flags, 'go'], io))

    await server.stop()
    await tearDown()
    // The stub refuses, so the run ends at the provider. Asserting what the stub saw,
    // and the reason it failed, is what says whether the run got there at all.
    expect({ code, err, seen }).toEqual({
      code: 1,
      err: ['jzh: the turn failed: PROVIDER: provider returned HTTP 400: stub\n'],
      seen: ['POST /v1/chat/completions'],
    })
    expect(requested).toEqual([model])
  })

  test('the flag wins over the settings file', async () => {
    const { server, requested, seen, baseUrl } = await serveProvider([], 400)
    const { tearDown, flags } = await setUp(baseUrl, 'model: x/settings-model\n')
    const { io, err } = collect()

    const code = await Effect.runPromise(main([...flags, '--model', 'x/flag-model', 'go'], io))

    await server.stop()
    await tearDown()
    expect({ code, err, seen }).toEqual({
      code: 1,
      err: ['jzh: the turn failed: PROVIDER: provider returned HTTP 400: stub\n'],
      seen: ['POST /v1/chat/completions'],
    })
    expect(requested).toEqual(['flag-model'])
  })

  test('with no model anywhere the run stops before the provider', async () => {
    const { server, requested, baseUrl } = await serveProvider([])
    const { tearDown, flags } = await setUp(baseUrl)
    const { io, err } = collect()

    const code = await Effect.runPromise(main([...flags, 'go'], io))

    await server.stop()
    await tearDown()
    expect(code).toBe(1)
    expect(err).toEqual([
      'jzh: no model is set: run jzh config set model <provider/model>, or pass --model for one run (jzh models lists them)\n',
    ])
    expect(requested).toEqual([])
  })
})
