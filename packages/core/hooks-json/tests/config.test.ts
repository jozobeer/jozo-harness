import { afterEach, describe, expect, test } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { matchesTool, parseHooksConfig, parseHooksText, readHooksFile } from '../src/config.ts'

const dirs: Array<string> = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'jzh-hooks-config-'))
  dirs.push(dir)
  return dir
}

const eventsOf = (raw: unknown): ReadonlyArray<string> => {
  const file = parseHooksConfig(raw)
  return file.kind === 'ok' ? file.commands.map((command) => command.event) : []
}

describe('hooks.json parsing', () => {
  test('reads a wrapped event map and a bare one alike', () => {
    const command = 'echo hi'
    const wrapped = { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command }] }] } }
    const bare = { PreToolUse: [{ hooks: [{ command }] }] }

    expect(eventsOf(wrapped)).toEqual(['PreToolUse'])
    expect(eventsOf(bare)).toEqual(['PreToolUse'])
  })

  test('keeps the matcher and converts a timeout in seconds to milliseconds', () => {
    const file = parseHooksConfig({
      hooks: {
        PostToolUse: [{ matcher: 'Bash', hooks: [{ command: 'echo done', timeout: 2 }] }],
      },
    })

    expect(file).toEqual({
      kind: 'ok',
      commands: [{ event: 'PostToolUse', matcher: 'Bash', command: 'echo done', timeoutMs: 2000 }],
    })
  })

  test('takes bare command strings and single command objects', () => {
    const file = parseHooksConfig({
      PreToolUse: ['first', { matcher: 'Read', command: 'second' }],
    })

    expect(file.kind).toBe('ok')
    if (file.kind !== 'ok') return
    expect(file.commands.map((command) => command.command)).toEqual(['first', 'second'])
  })

  test('ignores events the tool pipeline cannot place', () => {
    expect(eventsOf({ Stop: [{ hooks: [{ command: 'echo stop' }] }] })).toEqual([])
  })

  test('reports a document that is not an object', () => {
    expect(parseHooksConfig([])).toEqual({
      kind: 'invalid',
      reason: 'the document is not a JSON object',
    })
  })

  test('reports text that is not JSON with its path', () => {
    const file = parseHooksText('{ nope', '.claude/hooks.json')

    expect(file.kind).toBe('invalid')
    if (file.kind !== 'invalid') return
    expect(file.reason).toContain('.claude/hooks.json')
    expect(file.reason).toContain('not valid JSON')
  })

  test('reads a missing file as no hooks at all', async () => {
    const dir = await tempDir()

    await expect(Effect.runPromise(readHooksFile(join(dir, 'absent.json')))).resolves.toEqual({
      kind: 'missing',
    })
  })

  test('reads a file that cannot be read as invalid', async () => {
    const dir = await tempDir()

    const file = await Effect.runPromise(readHooksFile(dir))

    expect(file.kind).toBe('invalid')
  })

  test('reads a valid file from disk', async () => {
    const dir = await tempDir()
    const path = join(dir, 'hooks.json')
    await writeFile(path, JSON.stringify({ PreToolUse: [{ hooks: [{ command: 'true' }] }] }))

    const file = await Effect.runPromise(readHooksFile(path))

    expect(file.kind).toBe('ok')
  })
})

describe('matcher', () => {
  test('selects every tool when the matcher is absent, empty, or a star', () => {
    expect(matchesTool(undefined, 'bash')).toBe(true)
    expect(matchesTool('', 'bash')).toBe(true)
    expect(matchesTool('*', 'bash')).toBe(true)
  })

  test("reaches jzh's lowercase tool from a reference's capitalized matcher", () => {
    expect(matchesTool('Bash', 'bash')).toBe(true)
    expect(matchesTool('Edit|Write', 'write')).toBe(true)
  })

  test('anchors the expression to the whole tool name', () => {
    expect(matchesTool('ash', 'bash')).toBe(false)
    expect(matchesTool('^read$', 'read')).toBe(true)
  })

  test('selects nothing when the expression is invalid', () => {
    expect(matchesTool('[', 'bash')).toBe(false)
  })
})
