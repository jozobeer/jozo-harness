import { describe, expect, test } from 'vitest'
import { credentialSource, resolveSettings } from '../src/settings.ts'

const resolve = (overrides: Partial<Parameters<typeof resolveSettings>[0]> = {}) =>
  resolveSettings({
    flags: {},
    settings: {},
    settingsPath: '/home/me/.config/jzh/config.yaml',
    fallbackProfile: 'headless',
    fallbackRoute: 'ollama-cloud/default',
    ...overrides,
  })

describe('what is in effect, and why', () => {
  test('a flag wins over the settings file and over the fallback', () => {
    const resolved = resolve({
      flags: { profile: 'repl', model: 'other/cheap' },
      settings: { profile: 'headless', model: 'ollama-cloud/big' },
    })

    expect(resolved.profile).toEqual({
      value: 'repl',
      source: 'flag',
      from: 'the --profile on the command line',
    })
    expect(resolved.route.value).toBe('other/cheap')
    expect(resolved.route.source).toBe('flag')
  })

  test('the settings file wins over the fallback, and names itself', () => {
    const resolved = resolve({ settings: { profile: 'repl', model: 'ollama-cloud/big' } })

    expect(resolved.profile).toEqual({
      value: 'repl',
      source: 'settings',
      from: '/home/me/.config/jzh/config.yaml',
    })
    expect(resolved.route.value).toBe('ollama-cloud/big')
    expect(resolved.route.source).toBe('settings')
  })

  test('the fallback is a default, and says it is one', () => {
    const resolved = resolve()

    expect(resolved.profile.source).toBe('default')
    expect(resolved.profile.value).toBe('headless')
    expect(resolved.route.value).toBe('ollama-cloud/default')
    expect(resolved.skills).toEqual({
      value: [],
      source: 'default',
      from: 'no skills configured, so the skill tool is off',
    })
    expect(resolved.plugins.value).toEqual([])
  })

  test('the effort comes from the flag, the file, or the fallback, in that order', () => {
    const flagged = resolve({
      flags: { effort: 'high' },
      settings: { effort: 'low' },
      fallbackEffort: 'medium',
    })

    expect(flagged.effort).toEqual({
      value: 'high',
      source: 'flag',
      from: 'the --effort on the command line',
    })

    const filed = resolve({ settings: { effort: 'low' }, fallbackEffort: 'medium' })

    expect(filed.effort).toEqual({
      value: 'low',
      source: 'settings',
      from: '/home/me/.config/jzh/config.yaml',
    })
  })

  test('no effort anywhere is a default: the provider chooses', () => {
    const resolved = resolve()

    expect(resolved.effort.value).toBe('')
    expect(resolved.effort.source).toBe('default')
  })

  test('the port comes from the flag, the file, or 0, in that order', () => {
    expect(resolve().port).toEqual({
      value: 0,
      source: 'default',
      from: 'no port is named, so the system picks a free one',
    })

    expect(resolve({ settings: { port: 4310 } }).port).toEqual({
      value: 4310,
      source: 'settings',
      from: '/home/me/.config/jzh/config.yaml',
    })

    // 0 in the flag is a choice, not an absent flag, so it wins over the file.
    expect(resolve({ flags: { port: 0 }, settings: { port: 4310 } }).port).toEqual({
      value: 0,
      source: 'flag',
      from: 'the --port on the command line',
    })
  })

  test('a settings file may hold lists, and then it is their source', () => {
    const resolved = resolve({
      settings: {
        skills: ['/home/me/skills'],
        plugins: [{ id: 'mcp', name: '@jozo-harness/mcp' }],
      },
    })

    expect(resolved.skills.value).toEqual(['/home/me/skills'])
    expect(resolved.skills.source).toBe('settings')
    expect(resolved.plugins.value).toHaveLength(1)
    expect(resolved.plugins.source).toBe('settings')
  })

  test('an empty flag is the same as no flag at all', () => {
    const resolved = resolve({ flags: { profile: '' }, settings: { profile: 'repl' } })

    expect(resolved.profile.value).toBe('repl')
    expect(resolved.profile.source).toBe('settings')
  })
})

describe('where a credential came from', () => {
  test('the shell wins, then .env, then secrets.env', () => {
    const environment = { OLLAMA_API_KEY: 'from-shell', OTHER_KEY: 'x' }

    expect(
      credentialSource({ name: 'OLLAMA_API_KEY', environment, fromDotenv: [], fromSecrets: [] }),
    ).toBe('environment')
    expect(
      credentialSource({
        name: 'DOTENV_KEY',
        environment: { DOTENV_KEY: 'x' },
        fromDotenv: ['DOTENV_KEY'],
        fromSecrets: [],
      }),
    ).toBe('dotenv')
    expect(
      credentialSource({
        name: 'SECRET_KEY',
        environment: { SECRET_KEY: 'x' },
        fromDotenv: [],
        fromSecrets: ['SECRET_KEY'],
      }),
    ).toBe('secrets')
  })

  test('a variable nothing defines has no source', () => {
    expect(
      credentialSource({ name: 'MISSING_KEY', environment: {}, fromDotenv: [], fromSecrets: [] }),
    ).toBeUndefined()
    expect(
      credentialSource({
        name: 'EMPTY_KEY',
        environment: { EMPTY_KEY: '' },
        fromDotenv: [],
        fromSecrets: [],
      }),
    ).toBeUndefined()
  })
})
