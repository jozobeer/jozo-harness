import { statSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'
import { runAuth, type AuthIo } from '../src/index.ts'

const collector = (value: string): { io: AuthIo; out: Array<string>; err: Array<string> } => {
  const out: Array<string> = []
  const err: Array<string> = []
  return {
    out,
    err,
    io: {
      stdout: (text) => void out.push(text),
      stderr: (text) => void err.push(text),
      readLine: async () => value,
    },
  }
}

describe('jzh auth ref', () => {
  test('stores a referenced secret with 600 and never echoes it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jozo-harness-auth-ref-'))
    const env = { XDG_CONFIG_HOME: directory }
    const { io, out } = collector('ref-value')

    const code = await runAuth(['ref', 'openrouter'], io, env)

    const path = join(directory, 'jzh', 'credentials.json')
    expect(code).toBe(0)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(await readFile(path, 'utf8')).toContain('"openrouter": "ref-value"')
    expect(out.join('')).toContain('stored the reference "openrouter"')
    expect(out.join('')).not.toContain('ref-value')
    await rm(directory, { recursive: true, force: true })
  })
})

describe('jzh auth add', () => {
  test('stores a provider key under its environment name', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jozo-harness-auth-provider-'))
    const env = { XDG_CONFIG_HOME: directory }
    const { io, out } = collector('key-value')

    const code = await runAuth(['add', 'ollama'], io, env)

    const path = join(directory, 'jzh', 'secrets.env')
    expect(code).toBe(0)
    expect(await readFile(path, 'utf8')).toBe('OLLAMA_API_KEY=key-value\n')
    expect(out.join('')).toContain('stored the ollama key')
    expect(out.join('')).not.toContain('key-value')
    await rm(directory, { recursive: true, force: true })
  })

  test('deepseek stores DEEPSEEK_API_KEY', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jozo-harness-auth-provider-'))
    const env = { XDG_CONFIG_HOME: directory }
    const { io, out } = collector('key-value')

    const code = await runAuth(['add', 'deepseek'], io, env)

    const path = join(directory, 'jzh', 'secrets.env')
    expect(code).toBe(0)
    expect(await readFile(path, 'utf8')).toBe('DEEPSEEK_API_KEY=key-value\n')
    expect(out.join('')).toContain('stored the deepseek key')
    await rm(directory, { recursive: true, force: true })
  })

  test('list names the service and the variable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jozo-harness-auth-provider-'))
    const env = { XDG_CONFIG_HOME: directory }
    await runAuth(['add', 'ollama'], collector('one').io, env)

    const list = collector('')
    await runAuth(['list'], list.io, env)

    expect(list.out.join('')).toBe('ollama (OLLAMA_API_KEY)\n')
    await rm(directory, { recursive: true, force: true })
  })

  test('an unknown provider only prints usage', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jozo-harness-auth-provider-'))
    const { io, err } = collector('x')

    expect(await runAuth(['add', 'nope'], io, { XDG_CONFIG_HOME: directory })).toBe(2)
    expect(err.join('')).toContain('jzh auth add PROVIDER')
    expect(err.join('')).toContain('ollama')
    await rm(directory, { recursive: true, force: true })
  })
})
