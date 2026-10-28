import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'
import { configPaths, loadSecrets } from '../src/index.ts'
/** Writes a file, making the directories above it, because the file may not be there yet. */
const writeFileDeep = async (path: string, text: string | Uint8Array): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

describe('configPaths', () => {
  test('honours XDG_CONFIG_HOME', () => {
    const paths = configPaths({ XDG_CONFIG_HOME: '/tmp/xdg' })

    expect(paths.directory).toBe('/tmp/xdg/jzh')
    expect(paths.config).toBe('/tmp/xdg/jzh/config.yaml')
    expect(paths.secrets).toBe('/tmp/xdg/jzh/secrets.env')
    expect(paths.schedules).toBe('/tmp/xdg/jzh/schedules.json')
  })

  test('falls back to the home directory', () => {
    const paths = configPaths({})

    expect(paths.config.endsWith('/.config/jzh/config.yaml')).toBe(true)
  })
})

describe('loadSecrets', () => {
  const setup = async (mode: number) => {
    const directory = await mkdtemp(join(tmpdir(), 'jozo-harness-secrets-'))
    const path = join(directory, 'secrets.env')
    await writeFileDeep(path, 'API_KEY=from-file\nSHARED=from-file\n')
    await chmod(path, mode)
    return { directory, path }
  }

  test('fills what the environment lacks', async () => {
    const { directory, path } = await setup(0o600)
    const env: Record<string, string | undefined> = { SHARED: 'from-shell' }

    const loaded = loadSecrets(path, env)

    expect(loaded).toEqual(['API_KEY'])
    expect(env['API_KEY']).toBe('from-file')
    expect(env['SHARED']).toBe('from-shell')
    await rm(directory, { recursive: true, force: true })
  })

  test('reports a file others can read', async () => {
    const { directory, path } = await setup(0o644)
    const warnings: Array<string> = []

    loadSecrets(path, {}, (message) => void warnings.push(message))

    expect(warnings.join('')).toContain('chmod 600')
    await rm(directory, { recursive: true, force: true })
  })

  test('a missing file is not an error', () => {
    expect(loadSecrets('/tmp/definitely-not-there-jozo-harness.env', {})).toEqual([])
  })
})
