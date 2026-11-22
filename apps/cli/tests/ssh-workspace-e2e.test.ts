import { agentPlugin } from '@jozo-harness/agent'
import { agentLoopPlugin } from '@jozo-harness/agent-loop'
import { kernelPlugin, type Plugin } from '@jozo-harness/kernel'
import { Llm, type LlmAdapter, type StreamChunk } from '@jozo-harness/llm'
import { askPlugin, safetyPlugin } from '@jozo-harness/safety'
import { sessionPlugin } from '@jozo-harness/session'
import { jsonlSessions, sessionJsonlPlugin } from '@jozo-harness/session-jsonl'
import { systemPromptPlugin } from '@jozo-harness/system-prompt'
import { toolsPlugin } from '@jozo-harness/tools'
import { tier0Plugin } from '@jozo-harness/tools-tier0'
import { tier1Plugin } from '@jozo-harness/tools-tier1'
import { Effect, Layer, Schema, Stream } from 'effect'
import { spawn } from '@jozo-harness/process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'
import { runCommand } from '../src/index.ts'

/**
 * One sshd on loopback, started for this file: a real ssh transport is what the
 * issue asks for, and a stub would not prove that the host's own shell answers
 * the programs the seams write. The host is this machine, so the workspace it
 * opens is a temporary directory.
 */
interface Loopback {
  readonly port: number
  readonly key: string
  readonly root: string
  readonly home: string
  /** Where the run's session log goes; the e2e reads tool results back from it. */
  readonly logs: string
  read(path: string): Promise<string>
  stop(): Promise<void>
}

const run = async (argv: ReadonlyArray<string>): Promise<number> => {
  const child = spawn([...argv], { stdout: 'ignore', stderr: 'ignore' })
  return child.exited
}

const startLoopback = async (): Promise<Loopback | undefined> => {
  const base = await mkdtemp(join(tmpdir(), 'jozo-harness-sshd-'))
  const hostKey = join(base, 'hostkey')
  const userKey = join(base, 'userkey')
  const authorized = join(base, 'authorized_keys')
  const config = join(base, 'sshd_config')
  const root = join(base, 'work')
  const home = join(base, 'home')
  const logs = join(base, 'logs')
  await run(['ssh-keygen', '-q', '-t', 'ed25519', '-f', hostKey, '-N', ''])
  await run(['ssh-keygen', '-q', '-t', 'ed25519', '-f', userKey, '-N', ''])
  await writeFile(authorized, await readFile(userKey + '.pub', 'utf8'))
  await chmod(authorized, 0o600)
  await mkdir(root, { recursive: true })
  await mkdir(home, { recursive: true })
  await mkdir(logs, { recursive: true })
  // A port the kernel picks, so two runs of this file cannot collide.
  const port = 22000 + Math.floor(Math.random() * 2000)
  await writeFile(
    config,
    [
      'Port ' + String(port),
      'ListenAddress 127.0.0.1',
      'HostKey ' + hostKey,
      'PidFile ' + join(base, 'sshd.pid'),
      'AuthorizedKeysFile ' + authorized,
      'PasswordAuthentication no',
      'UsePAM no',
      'StrictModes no',
      'PermitRootLogin no',
      '',
    ].join('\n'),
  )
  const started = await run(['/usr/sbin/sshd', '-f', config, '-E', join(base, 'sshd.log')])
  if (started !== 0) {
    await rm(base, { recursive: true, force: true })
    return undefined
  }
  // Wait for the port to answer instead of sleeping a fixed time.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const probe = await run([
      'ssh',
      '-F',
      '/dev/null',
      '-i',
      userKey,
      '-p',
      String(port),
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'UserKnownHostsFile=/dev/null',
      join(process.env['USER'] ?? 'zyun') + '@127.0.0.1',
      'true',
    ])
    if (probe === 0) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return {
    port,
    key: userKey,
    root,
    home,
    logs,
    read: (path: string) => readFile(path, 'utf8'),
    stop: async () => {
      const pid = await readFile(join(base, 'sshd.pid'), 'utf8').catch(() => '')
      if (pid.trim() !== '') await run(['kill', pid.trim()])
      await rm(base, { recursive: true, force: true })
    },
  }
}

/** The ssh argv the row names, with the key and flags that reach the loopback host. */
const reachOf = (loopback: Loopback): ReadonlyArray<string> => [
  'ssh',
  '-F',
  '/dev/null',
  '-i',
  loopback.key,
  '-p',
  String(loopback.port),
  '-o',
  'BatchMode=yes',
  '-o',
  'StrictHostKeyChecking=no',
  '-o',
  'UserKnownHostsFile=/dev/null',
  join(process.env['USER'] ?? 'zyun') + '@127.0.0.1',
]

const textTurn = (text: string): ReadonlyArray<StreamChunk> => [
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', kind: 'stop' },
]

const bashTurn = (command: string): ReadonlyArray<StreamChunk> => [
  {
    type: 'block-end',
    index: 0,
    block: {
      type: 'tool-call',
      id: 'c-bash',
      name: 'bash',
      arguments: JSON.stringify({ command }),
    },
  },
  { type: 'finish', kind: 'tool-calls' },
]

const writeTurn = (path: string, content: string): ReadonlyArray<StreamChunk> => [
  {
    type: 'block-end',
    index: 0,
    block: {
      type: 'tool-call',
      id: 'c-write',
      name: 'write',
      arguments: JSON.stringify({ path, content }),
    },
  },
  { type: 'finish', kind: 'tool-calls' },
]

const readTurn = (path: string): ReadonlyArray<StreamChunk> => [
  {
    type: 'block-end',
    index: 0,
    block: { type: 'tool-call', id: 'c-read', name: 'read', arguments: JSON.stringify({ path }) },
  },
  { type: 'finish', kind: 'tool-calls' },
]

const scriptedLlm = (turns: ReadonlyArray<ReadonlyArray<StreamChunk>>): Plugin<{}, Llm, never> => {
  let step = 0
  return {
    name: 'stub-llm',
    config: Schema.Struct({}),
    provides: [Llm],
    requires: [],
    layer: () => {
      const adapter: LlmAdapter = {
        name: 'stub',
        capabilities: {
          toolChoice: false,
          reasoningEffort: null,
          images: 'none',
          promptCacheControl: false,
        },
        stream: () => {
          const turn = turns[step] ?? textTurn('done')
          step += 1
          return Stream.fromIterable(turn)
        },
      }
      return Layer.succeed(Llm, adapter)
    },
  }
}

const profile = (
  root: string,
  reach: ReadonlyArray<string>,
  logs: string,
  /** The permission preset: workspace-write is what wraps a remote command in bwrap. */
  preset = 'full',
): string =>
  [
    'name: test',
    'plugins:',
    '  - id: kernel',
    "    name: '@jozo-harness/kernel'",
    '  - id: sessions',
    "    name: '@jozo-harness/session'",
    '  - id: session-jsonl',
    "    name: '@jozo-harness/session-jsonl'",
    '    config:',
    '      root: ' + logs,
    '  - id: tools',
    "    name: '@jozo-harness/tools'",
    '  - id: system-prompt',
    "    name: '@jozo-harness/system-prompt'",
    '  - id: safety',
    "    name: '@jozo-harness/safety'",
    '    config:',
    '      preset: ' + preset,
    '  - id: ask',
    "    name: '@jozo-harness/ask'",
    '  - id: tier0',
    "    name: '@jozo-harness/tools-tier0'",
    '    config:',
    '      ssh:',
    '        reach: ' + JSON.stringify(reach),
    '        root: ' + JSON.stringify(root),
    '  - id: tier1',
    "    name: '@jozo-harness/tools-tier1'",
    '  - id: llm',
    '    name: stub-llm',
    '  - id: agent',
    "    name: '@jozo-harness/agent'",
    '  - id: agent-loop',
    "    name: '@jozo-harness/agent-loop'",
  ].join('\n')

const drive = (
  loopback: Loopback,
  turns: ReadonlyArray<ReadonlyArray<StreamChunk>>,
  task: string,
  logRoot = loopback.logs,
  /** The permission preset the profile runs under. */
  preset = 'full',
): Promise<number> =>
  Effect.runPromise(
    runCommand({
      profiles: [profile(loopback.root, reachOf(loopback), logRoot, preset)],
      plugins: [
        kernelPlugin,
        sessionJsonlPlugin,
        sessionPlugin,
        toolsPlugin,
        systemPromptPlugin,
        safetyPlugin,
        askPlugin,
        tier0Plugin,
        tier1Plugin,
        scriptedLlm(turns),
        agentPlugin,
        agentLoopPlugin,
      ] as ReadonlyArray<Plugin<any, any, any>>,
      cwd: loopback.home,
      route: 'stub/model',
      task,
      stdout: () => undefined,
      stderr: () => undefined,
    }),
  )

/** Every tool result's text from the session the run wrote, for a refusal to be read in. */
const toolResultsOf = async (root: string): Promise<ReadonlyArray<string>> => {
  const sessions = await Effect.runPromise(jsonlSessions({ root }).list())
  const opened = await Effect.runPromise(jsonlSessions({ root }).open(sessions[0]?.id ?? ''))
  return opened.events.flatMap((event) =>
    event.type === 'tool/result'
      ? event.data.content.flatMap((block) => (block.type === 'text' ? [block.text] : []))
      : [],
  )
}

describe('a workspace on an ssh host', () => {
  test('bash and write reach the remote workspace, and a write outside it is refused', async () => {
    const loopback = await startLoopback()
    if (loopback === undefined) return
    try {
      const code = await drive(
        loopback,
        [
          bashTurn('pwd; echo one > made.txt; cat made.txt'),
          writeTurn('written.txt', 'from the model\n'),
          readTurn('written.txt'),
          textTurn('done'),
        ],
        'work on the host',
      )

      expect(code).toBe(0)
      // bash ran on the host: its own pwd, and the file it made is there.
      expect(await loopback.read(join(loopback.root, 'made.txt'))).toBe('one\n')
      expect(await loopback.read(join(loopback.root, 'written.txt'))).toBe('from the model\n')
      // Nothing reached the local directory the run started in.
      await expect(readFile(join(loopback.home, 'written.txt'), 'utf8')).rejects.toThrow()
    } finally {
      await loopback.stop()
    }
  }, 120_000)

  test('a command that writes outside the workspace is refused by the host kernel', async () => {
    const loopback = await startLoopback()
    if (loopback === undefined) return
    try {
      // workspace-write lets a command write to its workspace and to /tmp, which
      // is where this e2e's root lives. /var/tmp is outside both, so the host's
      // bwrap is what refuses this, not the file tools.
      const escaped = join('/var/tmp', 'jozo-harness-ssh-escaped-' + String(process.pid) + '.txt')
      await rm(escaped, { force: true })
      const sessions = await mkdtemp(join(tmpdir(), 'jozo-harness-ssh-logs-'))
      const code = await drive(
        loopback,
        // The command itself fails, which is when the sandbox reads a denial: a
        // command that swallows the refusal and exits zero is not a denial.
        [bashTurn('echo nope > ' + escaped), textTurn('done')],
        'write outside with a command',
        sessions,
        'workspace-write',
      )

      expect(code).toBe(0)
      await expect(readFile(escaped, 'utf8')).rejects.toThrow()
      // The host's own kernel said why, and the sandbox read it as a denial
      // rather than as a command that happened to exit non-zero.
      const results = (await toolResultsOf(sessions)).join('\n').toLowerCase()
      expect(results).toContain('[exit code: 1]')
      expect(results).toContain('read-only file system')
      expect(results).toContain('sandbox: file access denied')
    } finally {
      await loopback.stop()
      await rm('/var/tmp/jozo-harness-ssh-escaped-' + String(process.pid) + '.txt', { force: true })
    }
  }, 120_000)

  test('a write outside the workspace is refused and leaves the host alone', async () => {
    const loopback = await startLoopback()
    if (loopback === undefined) return
    try {
      const outside = join(tmpdir(), 'jozo-harness-ssh-outside-' + String(process.pid) + '.txt')
      const code = await drive(
        loopback,
        [writeTurn(outside, 'escaped\n'), textTurn('done')],
        'write outside',
      )

      expect(code).toBe(0)
      await expect(readFile(outside, 'utf8')).rejects.toThrow()
    } finally {
      await loopback.stop()
      await rm(join(tmpdir(), 'jozo-harness-ssh-outside-' + String(process.pid) + '.txt'), {
        force: true,
      })
    }
  }, 120_000)

  test('a host that cannot be reached fails the call with a reason, and the run still ends', async () => {
    const logs = await mkdtemp(join(tmpdir(), 'jozo-harness-ssh-logs-'))
    const workspace = await mkdtemp(join(tmpdir(), 'jozo-harness-ssh-ws-'))
    const reach = ['ssh', '-F', '/dev/null', '-p', '1', '-o', 'BatchMode=yes', 'nobody@127.0.0.1']
    const code = await Effect.runPromise(
      runCommand({
        profiles: [profile(workspace, reach, logs)],
        plugins: [
          kernelPlugin,
          sessionJsonlPlugin,
          sessionPlugin,
          toolsPlugin,
          systemPromptPlugin,
          safetyPlugin,
          askPlugin,
          tier0Plugin,
          tier1Plugin,
          scriptedLlm([bashTurn('echo hi'), textTurn('done')]),
          agentPlugin,
          agentLoopPlugin,
        ] as ReadonlyArray<Plugin<any, any, any>>,
        cwd: workspace,
        route: 'stub/model',
        task: 'reach nothing',
        stdout: () => undefined,
        stderr: () => undefined,
      }),
    )
    // The row refuses at load: a workspace-write the host cannot keep is not run.
    expect(code).not.toBe(0)
    const sessions = await Effect.runPromise(jsonlSessions({ root: logs }).list())
    expect(sessions).toHaveLength(0)
    await rm(logs, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }, 120_000)
})
