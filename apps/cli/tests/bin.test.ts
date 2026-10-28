import { describe, expect, test } from 'vitest'
import { Effect } from 'effect'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseArgs } from '../src/args.ts'
import { main } from '../src/bin.ts'
/** Writes a file, making the directories above it, because the file may not be there yet. */
const writeFileDeep = async (path: string, text: string | Uint8Array): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

describe('parseArgs', () => {
  test('collects profile, patches, task, and flags', () => {
    const parsed = parseArgs([
      '--profile',
      'repl',
      '--patch',
      'a.yml',
      '--patch',
      'b.yml',
      '--model',
      'ollama-cloud/deepseek-v4.1-flash',
      '--effort',
      'high',
      '--json',
      'do',
      'the',
      'thing',
    ])

    expect(parsed.profile).toBe('repl')
    expect(parsed.patches).toEqual(['a.yml', 'b.yml'])
    expect(parsed.model).toBe('ollama-cloud/deepseek-v4.1-flash')
    expect(parsed.effort).toBe('high')
    expect(parsed.effortFlag).toBe('high')
    expect(parsed.json).toBe(true)
    expect(parsed.task).toBe('do the thing')
    expect(parsed.errors).toEqual([])
  })

  test('reports unknown options and missing values', () => {
    expect(parseArgs(['--nope']).errors).toEqual(['unknown option --nope'])
    expect(parseArgs(['--resume']).errors).toEqual(['--resume needs a value'])
  })

  test('reads the https origin jzh web may be published under', () => {
    const parsed = parseArgs([
      'web',
      '--port',
      '4310',
      '--public-url',
      'https://myhost.tailnet.ts.net',
    ])
    expect(parsed.web).toBe(true)
    expect(parsed.portFlag).toBe(4310)
    expect(parsed.publicUrl).toEqual({
      host: 'myhost.tailnet.ts.net',
      origin: 'https://myhost.tailnet.ts.net',
    })
    expect(parsed.errors).toEqual([])
    // A trailing slash is the same origin after the URL parser normalizes it.
    expect(parseArgs(['web', '--public-url', 'https://myhost.tailnet.ts.net/']).errors).toEqual([])
  })

  test('refuses a public url that is not a bare https origin', () => {
    const message = '--public-url needs an https origin such as https://host.tailnet.ts.net'
    const errorsOf = (value: string): ReadonlyArray<string> =>
      parseArgs(['web', '--public-url', value]).errors
    expect(errorsOf('http://myhost.tailnet.ts.net')).toEqual([message])
    expect(errorsOf('https://myhost.tailnet.ts.net/ui')).toEqual([message])
    expect(errorsOf('https://myhost.tailnet.ts.net/?session=s-1')).toEqual([message])
    expect(errorsOf('https://myhost.tailnet.ts.net/#top')).toEqual([message])
    expect(errorsOf('https://user@myhost.tailnet.ts.net')).toEqual([message])
    expect(errorsOf('not a url')).toEqual([message])
  })

  test('refuses a public url outside jzh web', () => {
    const parsed = parseArgs([
      '--public-url',
      'https://myhost.tailnet.ts.net',
      'do',
      'the',
      'thing',
    ])
    expect(parsed.web).toBe(false)
    expect(parsed.publicUrl).toBeUndefined()
    expect(parsed.errors).toEqual(['--public-url is only for `jzh web`'])
  })

  test('defaults to the headless profile', () => {
    const parsed = parseArgs([])
    expect(parsed.profile).toBe('headless')
    expect(parsed.task).toBeUndefined()
    // No effort anywhere: the provider chooses.
    expect(parsed.effort).toBe('')
    expect(parsed.effortFlag).toBeUndefined()
    // No port anywhere, and 0 is a port someone may ask for.
    expect(parsed.portFlag).toBeUndefined()
    expect(parseArgs(['web', '--port', '0']).portFlag).toBe(0)
  })
})

describe('main', () => {
  test('--dump-config prints the bundled base profile', async () => {
    const out: Array<string> = []
    const code = await Effect.runPromise(
      main(['--dump-config'], {
        stdout: (text) => out.push(text),
        stderr: () => undefined,
        cwd: '/work',
      }),
    )

    expect(code).toBe(0)
    expect(out.join('')).toContain('id=agent-loop')
    expect(out.join('')).toContain('config={"baseUrl":"https://ollama.com/v1"')
  })

  test('--dump-config tells what each row may carry', async () => {
    const out: Array<string> = []
    const code = await Effect.runPromise(
      main(['--dump-config'], {
        stdout: (text) => out.push(text),
        stderr: () => undefined,
        cwd: '/work',
      }),
    )

    const text = out.join('')
    expect(code).toBe(0)
    expect(text).toContain('model in effect:')
    // What a run resolves and why, in the same place as the keys themselves.
    expect(text).toContain('in effect for a run from here:')
    expect(text).toContain('profile: headless — default')
    expect(text).toContain('OLLAMA_API_KEY:')
    expect(text).toContain(
      '@jozo-harness/safety: preset (required, one of read-only|workspace-write|auto|full), sandbox (optional, one of none|seatbelt|bwrap|auto), writableRoots (optional, string[])',
    )
    expect(text).toContain('@jozo-harness/kernel: none')
    expect(text).toContain(
      '- planMode (the @jozo-harness/safety row): true hides the tools that change the workspace',
    )
    expect(text).toContain('- effort (any row): the reasoning effort to ask the provider for')
    expect(text).toContain('effort in effect:')
    expect(text).toContain('- effort: not set, so the provider chooses')
    expect(text).toContain(
      'effort: not set — default (no effort is named, so the provider chooses)',
    )
  })

  test('--dump-config resolves the web port and names what decided it', async () => {
    const dir = join(import.meta.dirname, '.tmp')
    await mkdir(dir, { recursive: true })
    const path = join(dir, `port-${crypto.randomUUID()}.yaml`)
    await writeFileDeep(path, 'port: 4310\n')
    const run = async (argv: ReadonlyArray<string>): Promise<string> => {
      const out: Array<string> = []
      const code = await Effect.runPromise(
        main([...argv, '--dump-config', '--config', path], {
          stdout: (text) => out.push(text),
          stderr: () => undefined,
          cwd: '/work',
        }),
      )
      expect(code).toBe(0)
      return out.join('')
    }

    expect(await run([])).toContain('port: 4310 — settings (' + path + ')')
    expect(await run(['--port', '0'])).toContain('port: 0 — flag (the --port on the command line)')
    await rm(path, { force: true })
  })

  test('--patch overlays one row by id', async () => {
    const dir = join(import.meta.dirname, '.tmp')
    await mkdir(dir, { recursive: true })
    const path = join(dir, `patch-${crypto.randomUUID()}.yml`)
    await writeFileDeep(
      path,
      [
        'name: patch',
        'plugins:',
        '  - id: llm',
        "    name: '@jozo-harness/llm-openai'",
        '    config:',
        '      baseUrl: http://127.0.0.1:11434/v1',
      ].join('\n'),
    )

    const out: Array<string> = []
    const code = await Effect.runPromise(
      main(['--dump-config', '--patch', path], {
        stdout: (text) => out.push(text),
        stderr: () => undefined,
        cwd: '/work',
      }),
    )
    await rm(path, { force: true })

    expect(code).toBe(0)
    expect(out.join('')).toContain('"baseUrl":"http://127.0.0.1:11434/v1"')
  })
})

// The notice names the seatbelt, so there is nothing to say on a platform that has none.
describe.skipIf(process.platform !== 'darwin')('startup probe', () => {
  test('keeps starting after naming a seatbelt that cannot be applied', async () => {
    const err: Array<string> = []
    const code = await Effect.runPromise(
      main([], {
        stdout: () => undefined,
        stderr: (text) => err.push(text),
        cwd: '/work',
        seatbeltProbe: () => 'refused',
      }),
    )

    // Nothing to do is still the reason this run ends; the probe only warns.
    expect(code).toBe(2)
    expect(err).toHaveLength(2)
    expect(err[0]).toContain('the seatbelt cannot be applied inside another sandbox')
    expect(err[1]).toContain('nothing to do')
  })

  test('says nothing when the probe applies the profile', async () => {
    const err: Array<string> = []
    const code = await Effect.runPromise(
      main([], {
        stdout: () => undefined,
        stderr: (text) => err.push(text),
        cwd: '/work',
        seatbeltProbe: () => 'applies',
      }),
    )

    expect(code).toBe(2)
    expect(err).toEqual(['nothing to do: pass a task or run on a terminal'])
  })
})
