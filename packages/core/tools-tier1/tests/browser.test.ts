import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import { noneSandbox, type SandboxShape } from '@jozo-harness/safety'
import type { ToolError } from '@jozo-harness/tools'
import {
  browserCommand,
  makeBrowserTool,
  textOfDom,
  type BrowserHost,
  type BrowserValue,
} from '../src/index.ts'

const hostOf = (
  programs: ReadonlyArray<string>,
  run: BrowserHost['run'] = async () => ({ exitCode: 0, stdout: '', stderr: '' }),
): BrowserHost => ({
  platform: 'linux',
  hasProgram: (program) => programs.includes(program),
  run,
})

interface BrowserOutcome {
  readonly value: BrowserValue | undefined
  readonly error: ToolError | undefined
}

const browse = (
  args: { url: string; action?: 'text' },
  host: BrowserHost,
  sandbox: SandboxShape = noneSandbox,
): Promise<BrowserOutcome> =>
  Effect.runPromise(
    Effect.match(
      makeBrowserTool(sandbox, host).execute(args, { sessionId: 's1', cwd: '/work', callId: 'c1' }),
      {
        onFailure: (error) => ({ value: undefined, error }),
        onSuccess: (value) => ({ value, error: undefined }),
      },
    ),
  )

describe('textOfDom', () => {
  test('keeps the visible text and drops script, style, and head contents', () => {
    const html =
      '<html><head><title>t</title><style>body { color: red }</style></head>' +
      '<body><h1>Hello</h1><p>World <b>now</b></p><script>alert(1)</script>' +
      '<p>a &amp; b &lt;c&gt;</p><!-- note --></body></html>'

    expect(textOfDom(html)).toBe('Hello\nWorld now\na & b <c>')
  })

  test('keeps inline text on one line and collapses the spacing around tags', () => {
    expect(textOfDom('<p>one <b>two</b>   three</p>')).toBe('one two three')
  })

  test('returns an empty string for a page with nothing to read', () => {
    expect(textOfDom('<html><head><title>only a title</title></head><body> </body></html>')).toBe(
      '',
    )
  })
})

describe('browserCommand', () => {
  test('runs the first installed chrome with --headless --dump-dom and the url', () => {
    const command = browserCommand(
      'https://example.com/',
      'linux',
      (program) => program === 'chromium',
    )

    expect(command).toEqual(['chromium', '--headless', '--dump-dom', 'https://example.com/'])
  })

  test('has no command where neither chrome nor chromium is installed', () => {
    expect(browserCommand('https://example.com/', 'linux', () => false)).toBeUndefined()
  })
})

describe('browser tool', () => {
  test('returns the text of the page the headless browser dumped', async () => {
    const host = hostOf(['google-chrome'], async () => ({
      exitCode: 0,
      stdout: '<html><body><h1>Hi</h1><p>there</p></body></html>',
      stderr: '',
    }))

    const { value, error } = await browse({ url: 'https://example.com/' }, host)

    expect(error).toBeUndefined()
    expect(value).toEqual({ url: 'https://example.com/', text: 'Hi\nthere', truncated: false })
  })

  test('defaults action to text and refuses a different action', async () => {
    const host = hostOf(['chromium'], async () => ({ exitCode: 0, stdout: '<p>x</p>', stderr: '' }))

    const ok = await browse({ url: 'http://example.com/', action: 'text' }, host)
    expect(ok.value?.text).toBe('x')

    let ran = 0
    const counting = hostOf(['chromium'], async () => {
      ran += 1
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    const bad = await browse({ url: 'http://example.com/', action: 'click' as 'text' }, counting)
    expect(bad.error?.code).toBe('invalid-arguments')
    expect(ran).toBe(0)
  })

  test('refuses a url that is not http(s)', async () => {
    let ran = 0
    const host = hostOf(['chromium'], async () => {
      ran += 1
      return { exitCode: 0, stdout: '', stderr: '' }
    })

    for (const url of ['file:///etc/passwd', 'data:text/html,hi', 'not a url']) {
      const { error } = await browse({ url }, host)
      expect(error?.code).toBe('invalid-arguments')
    }
    expect(ran).toBe(0)
  })

  test('says which commands it looked for where no headless browser is installed', async () => {
    let ran = 0
    const host = hostOf([], async () => {
      ran += 1
      return { exitCode: 0, stdout: '', stderr: '' }
    })

    const { error } = await browse({ url: 'https://example.com/' }, host)

    expect(error?.code).toBe('unavailable')
    expect(error?.message).toContain('google-chrome')
    expect(error?.message).toContain('chromium')
    expect(ran).toBe(0)
  })

  test('wraps the browser command with the run sandbox before running it', async () => {
    const seen: { argv?: ReadonlyArray<string>; cwd?: string } = {}
    const sandbox: SandboxShape = {
      ...noneSandbox,
      name: 'recording',
      confines: true,
      mode: 'workspace-write',
      wrap: (command) =>
        Effect.sync(() => {
          seen.argv = command.argv
          seen.cwd = command.cwd
          return {
            argv: ['sh', '-c', 'exit 1'],
            cwd: command.cwd,
            mode: 'workspace-write',
            denialSignatures: [],
          }
        }),
    }
    const host = hostOf(['chromium'], async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'Failed to move to new namespace',
    }))

    const { value, error } = await browse({ url: 'https://example.com/' }, host, sandbox)

    expect(seen.cwd).toBe('/work')
    expect(seen.argv).toEqual(['chromium', '--headless', '--dump-dom', 'https://example.com/'])
    expect(value).toBeUndefined()
    expect(error?.code).toBe('unavailable')
    expect(error?.message).toContain('Failed to move to new namespace')
  })
})
