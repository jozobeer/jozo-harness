import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import { loadConfigFile, parseConfigText } from '../src/index.ts'
import { main, type MainIo } from '../src/bin.ts'
/** Writes a file, making the directories above it, because the file may not be there yet. */
const writeFileDeep = async (path: string, text: string | Uint8Array): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

const io = (sink: Array<string>, errs: Array<string>): MainIo => ({
  stdout: (text) => void sink.push(text),
  stderr: (text) => void errs.push(text),
  cwd: '/tmp',
})

describe('parseConfigText', () => {
  test('reads defaults and plugin rows', async () => {
    const config = await Effect.runPromise(
      parseConfigText(
        [
          'model: my-cloud/some-model',
          'profile: repl',
          'port: 4310',
          'search: deepseek',
          'deepseekToolsBaseUrl: https://example.com/v1/tools',
          'skills:',
          '  - /tmp/skills',
          'unknown_key: ignored',
          'plugins:',
          '  - id: safety',
          "    name: '@jozo-harness/safety'",
          '    config:',
          '      preset: full',
        ].join('\n'),
      ),
    )

    expect(config.model).toBe('my-cloud/some-model')
    expect(config.profile).toBe('repl')
    expect(config.port).toBe(4310)
    expect(config.search).toBe('deepseek')
    expect(config.deepseekToolsBaseUrl).toBe('https://example.com/v1/tools')
    expect(config.skills).toEqual(['/tmp/skills'])
    expect(config.plugins?.length).toBe(1)
    expect(config.plugins?.[0]?.id).toBe('safety')
  })

  test('accepts exa and perplexity as the search provider', async () => {
    for (const search of ['exa', 'perplexity'] as const) {
      const config = await Effect.runPromise(parseConfigText('search: ' + search))
      expect(config.search).toBe(search)
    }
  })

  test('refuses a port outside 0..65535 or not a whole number', async () => {
    const messageOf = async (text: string): Promise<string> =>
      await Effect.runPromise(
        Effect.match(parseConfigText(text), {
          onFailure: (error) => error.message,
          onSuccess: () => 'parsed',
        }),
      )

    expect(await messageOf('port: 70000')).toContain('between 0 and 65535')
    expect(await messageOf('port: -1')).toContain('between 0 and 65535')
    expect(await messageOf('port: 1.5')).toContain('integer')
  })

  test('reports invalid YAML as a config error', async () => {
    const failed = await Effect.runPromise(
      Effect.match(parseConfigText('model: [unclosed'), {
        onFailure: (error) => error.code + ': ' + error.message.slice(0, 30),
        onSuccess: () => 'parsed',
      }),
    )

    expect(failed).toContain('config:')
  })

  test('a missing file is no settings', async () => {
    const config = await Effect.runPromise(
      loadConfigFile('/tmp/jozo-harness-no-settings-here.yaml'),
    )

    expect(config).toEqual({})
  })

  test('an empty file, or one with only comments, is no settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jozo-harness-settings-empty-'))
    const path = join(directory, 'config.yaml')

    await writeFileDeep(path, '')
    expect(await Effect.runPromise(loadConfigFile(path))).toEqual({})

    await writeFileDeep(path, '# nothing but a comment\n')
    expect(await Effect.runPromise(loadConfigFile(path))).toEqual({})
    await rm(directory, { recursive: true, force: true })
  })
})

describe('the settings file through the command', () => {
  test('its plugin rows join the profile and --dump-config shows them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jozo-harness-settings-'))
    const xdg = join(directory, 'jzh')
    await writeFileDeep(
      join(directory, 'config.yaml'),
      [
        'plugins:',
        '  - id: safety',
        "    name: '@jozo-harness/safety'",
        '    config:',
        '      preset: full',
      ].join('\n'),
    )
    void xdg

    const out: Array<string> = []
    const errs: Array<string> = []
    const code = await Effect.runPromise(
      main(['--dump-config', '--config', join(directory, 'config.yaml')], io(out, errs)),
    )

    expect(code).toBe(0)
    expect(out.join('')).toContain('"preset":"full"')
    await rm(directory, { recursive: true, force: true })
  })

  test('--dump-config names the settings file and shows what it holds', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jozo-harness-settings-path-'))
    const path = join(directory, 'config.yaml')
    await writeFileDeep(path, 'model: my-cloud/some-model\n')

    const out: Array<string> = []
    const code = await Effect.runPromise(main(['--dump-config', '--config', path], io(out, [])))

    const text = out.join('')
    expect(code).toBe(0)
    expect(text).toContain('settings (' + path + '):')
    expect(text).toContain('  - model: my-cloud/some-model ')
    expect(text).toContain('model in effect: my-cloud/some-model')
    await rm(directory, { recursive: true, force: true })
  })

  test('a malformed settings file stops the run with a message', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jozo-harness-settings-bad-'))
    const path = join(directory, 'config.yaml')
    await writeFileDeep(path, 'model: [unclosed')

    const out: Array<string> = []
    const errs: Array<string> = []
    const code = await Effect.runPromise(main(['--dump-config', '--config', path], io(out, errs)))

    expect(code).toBe(1)
    expect(errs.join('')).toContain('settings are not valid YAML')
    await rm(directory, { recursive: true, force: true })
  })
})
