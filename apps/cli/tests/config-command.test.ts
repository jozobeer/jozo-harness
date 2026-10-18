import { describe, expect, test } from 'vitest'
import { Effect } from 'effect'
import { mkdtemp, rm } from 'node:fs/promises'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { runConfig } from '../src/config-command.ts'
import { loadConfigFile } from '../src/config-file.ts'

const collector = () => {
  const out: Array<string> = []
  const errs: Array<string> = []
  return {
    io: {
      stdout: (text: string) => void out.push(text),
      stderr: (text: string) => void errs.push(text),
    },
    out,
    errs,
  }
}

const withHome = async (body: (env: Record<string, string>, path: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), 'jozo-harness-config-'))
  try {
    await body({ XDG_CONFIG_HOME: directory }, join(directory, 'jzh', 'config.yaml'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('jzh config', () => {
  test('shows where the settings live and what they hold', async () => {
    await withHome(async (env, path) => {
      const sink = collector()

      const code = await runConfig([], sink.io, env)

      const text = sink.out.join('')
      expect(code).toBe(0)
      expect(text).toContain('settings (' + path + '):')
      expect(text).toContain('- model: not set')
      expect(text).toContain('jzh config set model')
      expect(text).toContain('jzh config init')
    })
  })

  test('shows the values a settings file holds', async () => {
    await withHome(async (env, path) => {
      const sink = collector()
      await runConfig(['set', 'model', 'my-cloud/some-model'], sink.io, env)
      const shown = collector()

      const code = await runConfig([], shown.io, env)

      expect(code).toBe(0)
      expect(shown.out.join('')).toContain('- model: my-cloud/some-model ')
      expect(readFileSync(path, 'utf8')).toContain('model: my-cloud/some-model')
    })
  })

  test('sets a key in a file it creates', async () => {
    await withHome(async (env, path) => {
      const sink = collector()

      const code = await runConfig(['set', 'model', 'my-cloud/some-model'], sink.io, env)

      expect(code).toBe(0)
      expect(sink.out.join('')).toContain('model: my-cloud/some-model')
      const settings = await Effect.runPromise(loadConfigFile(path))
      expect(settings.model).toBe('my-cloud/some-model')
    })
  })

  test('keeps the other lines and the comments', async () => {
    await withHome(async (env, path) => {
      const sink = collector()
      await runConfig(['set', 'profile', 'repl'], sink.io, env)
      const first = readFileSync(path, 'utf8')

      const code = await runConfig(['set', 'model', 'my-cloud/next'], sink.io, env)

      const text = readFileSync(path, 'utf8')
      expect(code).toBe(0)
      expect(text).toContain('profile: repl')
      expect(text).toContain('model: my-cloud/next')
      expect(text.startsWith(first)).toBe(true)
    })
  })

  test('sets the reasoning effort to a word only the endpoint judges', async () => {
    await withHome(async (env, path) => {
      const sink = collector()

      const code = await runConfig(['set', 'effort', 'max'], sink.io, env)

      expect(sink.errs.join('')).toBe('')
      expect(code).toBe(0)
      expect(readFileSync(path, 'utf8')).toContain('effort: max')
      const settings = await Effect.runPromise(loadConfigFile(path))
      expect(settings.effort).toBe('max')
    })
  })

  test('refuses a key the settings file does not take', async () => {
    await withHome(async (env) => {
      const sink = collector()

      const code = await runConfig(['set', 'nope', 'x'], sink.io, env)

      expect(code).toBe(2)
      expect(sink.errs.join('')).toContain(
        'model, effort, profile, search, deepseekToolsBaseUrl, skills, plugins',
      )
    })
  })

  test('refuses to set a key that holds a list and points at add', async () => {
    await withHome(async (env) => {
      const sink = collector()

      const code = await runConfig(['set', 'skills', '/tmp/skills'], sink.io, env)

      expect(code).toBe(2)
      expect(sink.errs.join('')).toContain('jzh config add skills <dir>')
    })
  })

  test('answers a help request without an error', async () => {
    await withHome(async (env) => {
      const sink = collector()

      const code = await runConfig(['--help'], sink.io, env)

      expect(code).toBe(0)
      expect(sink.out.join('')).toContain('jzh config set K V')
    })
  })

  test('refuses a model that is not provider/model', async () => {
    await withHome(async (env) => {
      const sink = collector()

      const code = await runConfig(['set', 'model', 'nonsense'], sink.io, env)

      expect(code).toBe(2)
      expect(sink.errs.join('')).toContain('provider/model')
    })
  })

  test('refuses a profile that is not bundled', async () => {
    await withHome(async (env) => {
      const sink = collector()

      const code = await runConfig(['set', 'profile', 'nope'], sink.io, env)

      expect(code).toBe(2)
      expect(sink.errs.join('')).toContain('no bundled profile named nope')
    })
  })

  test('init writes a starting file with every key commented out', async () => {
    await withHome(async (env, path) => {
      const sink = collector()

      const code = await runConfig(['init'], sink.io, env)

      expect(code).toBe(0)
      expect(sink.out.join('')).toContain(path)
      const text = readFileSync(path, 'utf8')
      for (const key of ['model', 'profile', 'skills', 'plugins']) {
        expect(text).toContain('# ' + key + ':')
      }
      const settings = await Effect.runPromise(loadConfigFile(path))
      expect(settings).toEqual({})
    })
  })

  test('init does not overwrite a file that is there', async () => {
    await withHome(async (env, path) => {
      const sink = collector()
      await runConfig(['set', 'model', 'my-cloud/some-model'], sink.io, env)

      const code = await runConfig(['init'], sink.io, env)

      expect(code).toBe(1)
      expect(sink.errs.join('')).toContain('already exists')
      expect(readFileSync(path, 'utf8')).toContain('my-cloud/some-model')
    })
  })
})

describe('jzh config add and remove', () => {
  /** A directory that is there, since the command checks before it writes. */
  const skillsDir = (path: string): string => {
    const dir = join(dirname(path), 'skills')
    mkdirSync(dir, { recursive: true })
    return dir
  }

  test('adds a directory and writes the block', async () => {
    await withHome(async (env, path) => {
      const sink = collector()
      const dir = skillsDir(path)

      const code = await runConfig(['add', 'skills', dir], sink.io, env)

      expect(code).toBe(0)
      expect(readFileSync(path, 'utf8')).toBe('skills:\n  - ' + dir + '\n')
      expect(sink.out.join('')).toContain('added ' + dir)
    })
  })

  test('leaves the file alone when the directory is already there', async () => {
    await withHome(async (env, path) => {
      const sink = collector()
      const dir = skillsDir(path)
      await runConfig(['add', 'skills', dir], sink.io, env)
      const first = readFileSync(path, 'utf8')

      const code = await runConfig(['add', 'skills', dir], sink.io, env)

      expect(code).toBe(0)
      expect(sink.out.join('')).toContain('already in skills')
      expect(readFileSync(path, 'utf8')).toBe(first)
    })
  })

  test('refuses a directory that is not there', async () => {
    await withHome(async (env, path) => {
      const sink = collector()

      const code = await runConfig(['add', 'skills', join(dirname(path), 'nope')], sink.io, env)

      expect(code).toBe(2)
      expect(sink.errs.join('')).toContain('is not a directory')
      expect(() => readFileSync(path, 'utf8')).toThrow()
    })
  })

  test('removes a directory it added', async () => {
    await withHome(async (env, path) => {
      const sink = collector()
      const dir = skillsDir(path)
      await runConfig(['add', 'skills', dir], sink.io, env)

      const code = await runConfig(['remove', 'skills', dir], sink.io, env)

      expect(code).toBe(0)
      expect(readFileSync(path, 'utf8')).toBe('')
      expect(sink.out.join('')).toContain('removed ' + dir)
    })
  })

  test('refuses to remove a directory the file does not hold', async () => {
    await withHome(async (env) => {
      const sink = collector()

      const code = await runConfig(['remove', 'skills', '/tmp/nope'], sink.io, env)

      expect(code).toBe(2)
      expect(sink.errs.join('')).toContain('no such directory')
    })
  })

  test('writes a row key for a row the profile provides', async () => {
    await withHome(async (env, path) => {
      const sink = collector()

      const code = await runConfig(['set', 'plugins.safety.preset', 'full'], sink.io, env)

      expect(code).toBe(0)
      const settings = await Effect.runPromise(loadConfigFile(path))
      expect(settings.plugins).toEqual([
        { id: 'safety', name: '@jozo-harness/safety', config: { preset: 'full' } },
      ])
    })
  })

  test('adds a plugin row and then a key under it', async () => {
    await withHome(async (env, path) => {
      const sink = collector()

      const added = await runConfig(['add', 'plugins', '@jozo-harness/mcp'], sink.io, env)
      const written = await runConfig(['set', 'plugins.mcp.command', '[npx, -y]'], sink.io, env)

      expect(added).toBe(0)
      expect(written).toBe(0)
      const settings = await Effect.runPromise(loadConfigFile(path))
      expect(settings.plugins).toEqual([
        { id: 'mcp', name: '@jozo-harness/mcp', config: { command: ['npx', '-y'] } },
      ])
    })
  })

  test('refuses a plugin this build does not have', async () => {
    await withHome(async (env) => {
      const sink = collector()

      const code = await runConfig(['add', 'plugins', '@jozo-harness/nope'], sink.io, env)

      expect(code).toBe(2)
      expect(sink.errs.join('')).toContain('unknown plugin @jozo-harness/nope')
    })
  })

  test('points a plugin the profile provides at the set command', async () => {
    await withHome(async (env) => {
      const sink = collector()

      const code = await runConfig(['add', 'plugins', '@jozo-harness/safety'], sink.io, env)

      expect(code).toBe(2)
      expect(sink.errs.join('')).toContain('plugins.safety.')
    })
  })

  test('refuses a key the plugin does not take', async () => {
    await withHome(async (env, path) => {
      const sink = collector()

      const code = await runConfig(['set', 'plugins.tier0.preset', 'full'], sink.io, env)

      expect(code).toBe(2)
      expect(sink.errs.join('')).toContain('preset')
      expect(() => readFileSync(path, 'utf8')).toThrow()
    })
  })

  test('refuses a value the key does not take', async () => {
    await withHome(async (env, path) => {
      const sink = collector()

      const code = await runConfig(['set', 'plugins.safety.preset', 'everything'], sink.io, env)

      expect(code).toBe(2)
      expect(() => readFileSync(path, 'utf8')).toThrow()
    })
  })

  test('writes disabled for a row the profile provides', async () => {
    await withHome(async (env, path) => {
      const sink = collector()

      const code = await runConfig(['set', 'plugins.ask.disabled', 'true'], sink.io, env)

      expect(code).toBe(0)
      const settings = await Effect.runPromise(loadConfigFile(path))
      expect(settings.plugins).toEqual([{ id: 'ask', name: '@jozo-harness/ask', disabled: true }])
    })
  })

  test('refuses a disabled value that is not true or false', async () => {
    await withHome(async (env) => {
      const sink = collector()

      const code = await runConfig(['set', 'plugins.ask.disabled', 'maybe'], sink.io, env)

      expect(code).toBe(2)
      expect(sink.errs.join('')).toContain('true or false')
    })
  })

  test('asks for the row before a key under a plugin the profile lacks', async () => {
    await withHome(async (env) => {
      const sink = collector()

      const code = await runConfig(['set', 'plugins.mcp.command', '[npx]'], sink.io, env)

      expect(code).toBe(2)
      expect(sink.errs.join('')).toContain('jzh config add plugins')
    })
  })

  test('refuses to remove a row the settings file does not hold', async () => {
    await withHome(async (env) => {
      const sink = collector()

      const code = await runConfig(['remove', 'plugins', 'safety'], sink.io, env)

      expect(code).toBe(2)
      expect(sink.errs.join('')).toContain('no row safety')
    })
  })

  test('answers a half-typed command with the usage', async () => {
    await withHome(async (env) => {
      const sink = collector()

      const code = await runConfig(['add', 'skills'], sink.io, env)

      expect(code).toBe(2)
      expect(sink.errs.join('')).toContain('jzh config add skills <dir>')
    })
  })

  test('reports a settings file it cannot read in one line', async () => {
    await withHome(async (env, path) => {
      const sink = collector()
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, 'model: [unclosed\n')

      const code = await runConfig([], sink.io, env)

      expect(code).toBe(1)
      expect(sink.errs.join('')).toContain('not valid YAML')
      expect(sink.errs.join('')).not.toContain('at ')
    })
  })
})
