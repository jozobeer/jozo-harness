import { describe, expect, test } from 'vitest'
import {
  childEnvironment,
  logManagedEnv,
  managedEnv,
  managedEnvOf,
  managedNamesOf,
} from '../src/managed-env.ts'

describe('managed environment registry', () => {
  test('accepts only names in the reserved prefix', () => {
    expect(managedEnv({ JZH_PROFILE: 'base', JZH_A1: 'one' })).toEqual({
      JZH_PROFILE: 'base',
      JZH_A1: 'one',
    })
    expect(() => managedEnv({ PATH: '/tmp' })).toThrow(/JZH_/)
    expect(() => managedEnv({ 'JZH_BAD NAME': 'x' })).toThrow()
    expect(() => managedEnv({ 'JZH_BAD=VALUE': 'x' })).toThrow()
    expect(() => managedEnv({ JZH_NUMBER: 1 })).toThrow(/string/)
  })

  test('reads the tier0 row and keeps a run without the key at none', () => {
    const row = (config: unknown) => ({
      id: 'tier0',
      name: '@jozo-harness/tools-tier0',
      config,
    })

    expect(managedEnvOf([row({ env: { JZH_PROFILE: 'repl' } })])).toEqual({
      JZH_PROFILE: 'repl',
    })
    expect(managedEnvOf([])).toEqual({})
    expect(managedEnvOf([row({})])).toEqual({})
    expect(() => managedEnvOf([row({ env: { PATH: '/tmp' } })])).toThrow(/JZH_/)
  })

  test('drops an ambient managed name and lets the managed map win', () => {
    process.env.JZH_AMBIENT = 'outside'
    try {
      const environment = childEnvironment(
        { JZH_KEPT: 'managed' },
        { JZH_KEPT: 'caller', PLAIN: 'kept' },
      )

      expect(environment.JZH_KEPT).toBe('managed')
      expect(environment.PLAIN).toBe('kept')
      expect(environment.JZH_AMBIENT).toBeUndefined()
    } finally {
      delete process.env.JZH_AMBIENT
    }
  })

  test('logs the sorted names and never the values', () => {
    const lines: Array<string> = []
    const environment = childEnvironment({ JZH_TOKEN: 's3cret-value', JZH_PROFILE: 'base' })

    logManagedEnv(environment, (line) => lines.push(line))

    expect(lines.join('\n')).toBe('[managed env] JZH_PROFILE, JZH_TOKEN')
    expect(lines.join('\n')).not.toContain('s3cret-value')
    expect(managedNamesOf({ JZH_B: 'x', PATH: '/', JZH_A: 'y' })).toEqual(['JZH_A', 'JZH_B'])
  })
})
