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

  test('defaults to the headless profile', () => {
    const parsed = parseArgs([])
    expect(parsed.profile).toBe('headless')
    expect(parsed.task).toBeUndefined()
    // No effort anywhere: the provider chooses.
    expect(parsed.effort).toBe('')
    expect(parsed.effortFlag).toBeUndefined()
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
      '@jozo-harness/safety: preset (required, one of read-only|workspace-write|full), sandbox (optional, one of none|seatbelt|bwrap|auto), writableRoots (optional, string[])',
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
