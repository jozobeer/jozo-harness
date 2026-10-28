import { describe, expect, test } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from '@jozo-harness/process'
/** Writes a file, making the directories above it, because the file may not be there yet. */
const writeFileDeep = async (path: string, text: string | Uint8Array): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

const entry = join(import.meta.dirname, '../src/run.ts')

describe('the tui through a real process', () => {
  test('--tui paints the screen and ctrl-d restores the terminal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jozo-harness-tui-process-'))
    const patch = join(dir, 'sessions.yml')
    await writeFileDeep(
      patch,
      [
        'name: sessions',
        'plugins:',
        '  - id: session-jsonl',
        "    name: '@jozo-harness/session-jsonl'",
        '    config:',
        '      root: ' + join(dir, 'sessions'),
        // The test process may itself be sandboxed; this checks the terminal, not commands.
        '  - id: safety',
        "    name: '@jozo-harness/safety'",
        '    config:',
        '      sandbox: none',
      ].join('\n'),
    )
    const child = spawn(
      [process.execPath, entry, '--tui', '--model', 'stub/model', '--patch', patch],
      {
        cwd: dir,
        env: { ...process.env, XDG_CONFIG_HOME: dir },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    child.stdin.write('\u0004')
    child.stdin.end()
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])

    expect(code).toBe(0)
    expect(err).toBe('')
    expect(out).toContain('\u001b[?1049h')
    expect(out).toContain('jozo-harness · stub/model')
    // The wheel reaches the UI only while the terminal is told to report the mouse.
    expect(out).toContain('\u001b[?1000h\u001b[?1006h')
    expect(out).toContain('\u001b[?1006l\u001b[?1000l')
    expect(out).toContain('\u001b[?1049l')
    await rm(dir, { recursive: true, force: true })
  })
})
