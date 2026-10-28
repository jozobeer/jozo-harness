import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'
import { Effect } from 'effect'
import { startStubServer } from '@jozo-harness/test-support-stub'
import { main, type MainIo } from '../src/bin.ts'
import { loadSecrets } from '../src/config.ts'
import { readCredentials, resolveCredentialRef, writeCredential } from '../src/credentials.ts'
import { loadEnvFrom } from '../src/env-file.ts'
import type { ModelEndpoint } from '../src/models.ts'

const endpointOf = (apiKeyEnv: string, apiKeyRef?: string): ModelEndpoint => ({
  provider: 'acme',
  baseUrl: 'http://127.0.0.1:9/v1',
  apiKeyEnv,
  ...(apiKeyRef === undefined ? {} : { apiKeyRef }),
})

const withStore = (): { directory: string; path: string } => {
  const directory = mkdtempSync(join(tmpdir(), 'jozo-harness-credentials-'))
  return { directory, path: join(directory, 'credentials.json') }
}

const messageOf = (read: () => unknown): string => {
  try {
    read()
    return ''
  } catch (cause) {
    return String(cause)
  }
}

describe('the credentials store', () => {
  test('creates the file with 600 and keeps the references it already had', () => {
    const { directory, path } = withStore()

    writeCredential(path, 'first', 'value-one')
    writeCredential(path, 'second', 'value-two')

    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readCredentials(path)).toEqual({ first: 'value-one', second: 'value-two' })
    rmSync(directory, { recursive: true, force: true })
  })

  test('refuses text that is not an object of strings without echoing it', () => {
    const { directory, path } = withStore()
    writeFileSync(path, 'sk-or-very-secret')
    const malformed = messageOf(() => readCredentials(path))
    writeFileSync(path, '{"openrouter":{"key":"sk-or-very-secret"}}')
    const notAString = messageOf(() => readCredentials(path))

    expect(malformed).toContain('not a JSON object')
    expect(notAString).toContain('openrouter')
    expect(malformed + notAString).not.toContain('sk-or-very-secret')
    rmSync(directory, { recursive: true, force: true })
  })
})

describe('resolving a credential reference', () => {
  test('fills the key from the reference when the environment chain leaves it empty', () => {
    const { directory, path } = withStore()
    writeCredential(path, 'openrouter', 'from-reference')
    const env: Record<string, string | undefined> = {}

    const result = resolveCredentialRef(endpointOf('OPENROUTER_API_KEY', 'openrouter'), env, path)

    expect(result.kind).toBe('filled')
    expect(env['OPENROUTER_API_KEY']).toBe('from-reference')
    rmSync(directory, { recursive: true, force: true })
  })

  test('names the missing reference and leaves the value absent', () => {
    const { directory, path } = withStore()
    const env: Record<string, string | undefined> = {}

    const result = resolveCredentialRef(endpointOf('OPENROUTER_API_KEY', 'openrouter'), env, path)

    expect(result.kind).toBe('missing')
    const reason = result.kind === 'missing' ? result.reason : ''
    expect(reason).toContain('"openrouter"')
    expect(reason).toContain(path)
    expect(env['OPENROUTER_API_KEY']).toBeUndefined()
    rmSync(directory, { recursive: true, force: true })
  })

  test('keeps the shell, the nearest .env, and secrets.env ahead of the reference', () => {
    const { directory, path } = withStore()
    writeCredential(path, 'openrouter', 'from-reference')
    const project = mkdtempSync(join(tmpdir(), 'jozo-harness-credential-order-'))
    writeFileSync(join(project, '.env'), 'OPENROUTER_API_KEY=from-dotenv\n')
    const secrets = join(project, 'secrets.env')
    writeFileSync(secrets, 'OPENROUTER_API_KEY=from-secrets\n')
    chmodSync(secrets, 0o600)
    const endpoint = endpointOf('OPENROUTER_API_KEY', 'openrouter')

    const shell: Record<string, string | undefined> = { OPENROUTER_API_KEY: 'from-shell' }
    loadEnvFrom(project, shell)
    loadSecrets(secrets, shell)
    const dotenv: Record<string, string | undefined> = {}
    loadEnvFrom(project, dotenv)
    loadSecrets(secrets, dotenv)
    const fromSecrets: Record<string, string | undefined> = {}
    loadSecrets(secrets, fromSecrets)
    const fromReference: Record<string, string | undefined> = {}

    expect(shell['OPENROUTER_API_KEY']).toBe('from-shell')
    expect(dotenv['OPENROUTER_API_KEY']).toBe('from-dotenv')
    expect(fromSecrets['OPENROUTER_API_KEY']).toBe('from-secrets')
    expect(resolveCredentialRef(endpoint, shell, path).kind).toBe('present')
    expect(resolveCredentialRef(endpoint, fromSecrets, path).kind).toBe('present')
    expect(resolveCredentialRef(endpoint, fromReference, path).kind).toBe('filled')
    expect(fromReference['OPENROUTER_API_KEY']).toBe('from-reference')
    rmSync(project, { recursive: true, force: true })
    rmSync(directory, { recursive: true, force: true })
  })
})

/** Writes a file, making the directories above it, because the file may not be there yet. */
const writeFileDeep = async (path: string, text: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

const collect = (): { io: MainIo; out: Array<string>; err: Array<string> } => {
  const out: Array<string> = []
  const err: Array<string> = []
  return {
    out,
    err,
    io: {
      stdout: (text) => void out.push(text),
      stderr: (text) => void err.push(text),
      cwd: '/work',
    },
  }
}

/** A profile at a stub endpoint that names a reference of its own, under a fresh XDG home. */
const withCli = async (
  baseUrl = 'http://127.0.0.1:9/v1',
): Promise<{
  keyEnv: string
  patch: string
  config: string
  store: string
  tearDown: () => Promise<void>
}> => {
  const directory = await mkdtemp(join(tmpdir(), 'jozo-harness-credential-cli-'))
  const keyEnv = 'JZH_TEST_REF_' + crypto.randomUUID().replaceAll('-', '_')
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
      '      localBaseUrl: ""',
      '      apiKeyEnv: ' + keyEnv,
      '      apiKeyRef: openrouter',
    ].join('\n'),
  )
  const config = join(directory, 'config.yaml')
  await writeFileDeep(config, '')
  const store = join(directory, 'jzh', 'credentials.json')
  const previous = process.env['XDG_CONFIG_HOME']
  process.env['XDG_CONFIG_HOME'] = directory
  const tearDown = async () => {
    delete process.env[keyEnv]
    if (previous === undefined) delete process.env['XDG_CONFIG_HOME']
    else process.env['XDG_CONFIG_HOME'] = previous
    await rm(directory, { recursive: true, force: true })
  }
  return { keyEnv, patch, config, store, tearDown }
}

describe('jzh with a credential reference', () => {
  test('shows the reference and the store in --dump-config without the value', async () => {
    const cli = await withCli()
    writeCredential(cli.store, 'openrouter', 'sk-or-very-secret')
    const { io, out, err } = collect()

    const code = await Effect.runPromise(
      main(['--dump-config', '--config', cli.config, '--patch', cli.patch], io),
    )

    expect({ code, err: err.join('') }).toEqual({ code: 0, err: '' })
    expect(out.join('')).toContain('credentials (the reference "openrouter" in ' + cli.store + ')')
    expect(out.join('')).not.toContain('sk-or-very-secret')
    await cli.tearDown()
  })

  test('sends the reference as the provider key when the environment has none', async () => {
    const seen: Array<string | null> = []
    const server = await startStubServer(async (request) => {
      seen.push(request.headers.get('authorization'))
      return Response.json({ data: [{ id: 'm-1' }] })
    })
    const cli = await withCli(server.origin + '/v1')
    writeCredential(cli.store, 'openrouter', 'from-reference')
    const { io, out, err } = collect()

    const code = await Effect.runPromise(
      main(['models', '--config', cli.config, '--patch', cli.patch], io),
    )

    await server.stop()
    expect({ code, err: err.join('') }).toEqual({ code: 0, err: '' })
    expect(seen).toEqual(['Bearer from-reference'])
    expect(out.join('')).toBe('127.0.0.1/m-1\n')
    await cli.tearDown()
  })

  test('stops a models listing and names the reference it could not find', async () => {
    const cli = await withCli()
    const { io, err } = collect()

    const code = await Effect.runPromise(
      main(['models', '--config', cli.config, '--patch', cli.patch], io),
    )

    expect(code).toBe(1)
    expect(err.join('')).toContain('"openrouter"')
    expect(err.join('')).toContain(cli.store)
    await cli.tearDown()
  })
})
