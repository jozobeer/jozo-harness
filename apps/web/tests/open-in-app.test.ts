import { afterEach, describe, expect, test } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { Effect } from 'effect'
import {
  detectOpenApps,
  makeOpenInApp,
  noOpenInApp,
  nodeOpenAppHost,
  openAppsViewOf,
  openWorkspacePath,
  resolveWorkspacePath,
  spawnLaunch,
  type OpenAppHost,
  type Launch,
} from '../src/server/open-in-app.ts'

const macHost = (bundles: ReadonlyArray<string> = []): OpenAppHost => ({
  platform: 'darwin',
  home: '/Users/me',
  exists: (path) =>
    path === '/System/Applications/Utilities/Terminal.app' || bundles.includes(path),
  onPath: () => false,
})

const linuxHost = (commands: ReadonlyArray<string>): OpenAppHost => ({
  platform: 'linux',
  home: '/home/me',
  exists: () => false,
  onPath: (command) => commands.includes(command),
})

const roots: Array<string> = []

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'jzh-open-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const launchInto =
  (calls: Array<{ command: string; args: ReadonlyArray<string> }>): Launch =>
  async (command, args) => {
    calls.push({ command, args })
  }

describe('open in app', () => {
  test('offers Finder first on a bare macOS, with Terminal from the system folder', () => {
    expect(detectOpenApps(macHost()).map((app) => app.id)).toEqual(['finder', 'terminal'])
  })

  test('offers the macOS apps whose bundles are installed', () => {
    const host = macHost([
      '/Applications/Visual Studio Code.app',
      '/Applications/Cursor.app',
      '/Users/me/Applications/iTerm.app',
    ])
    expect(detectOpenApps(host).map((app) => app.id)).toEqual([
      'finder',
      'vscode',
      'cursor',
      'terminal',
      'iterm',
    ])
  })

  test('offers the Linux commands found on PATH', () => {
    expect(detectOpenApps(linuxHost(['xdg-open', 'code'])).map((app) => app.id)).toEqual([
      'files',
      'vscode',
    ])
  })

  test('says why no app is offered when the machine has none', () => {
    const view = openAppsViewOf(linuxHost([]))
    expect(view.apps).toEqual([])
    expect(view.reason).toBe('no app on this machine can open a workspace with a folder')
  })

  test('offers nothing on a platform without a known launcher', () => {
    expect(
      detectOpenApps({
        platform: 'win32',
        home: 'C:/Users/me',
        exists: () => true,
        onPath: () => true,
      }),
    ).toEqual([])
  })

  test('opens the workspace root with Finder as one path argument', async () => {
    const root = await makeRoot()
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = []
    await openWorkspacePath(
      { host: macHost(), launch: launchInto(calls) },
      { app: 'finder', root, path: '' },
    )
    expect(calls).toEqual([{ command: 'open', args: [await realpath(root)] }])
  })

  test('opens a folder under the workspace with the chosen app named by its bundle', async () => {
    const root = await makeRoot()
    const folder = join(root, 'project')
    await mkdir(folder)
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = []
    await openWorkspacePath(
      { host: macHost(['/Applications/Visual Studio Code.app']), launch: launchInto(calls) },
      { app: 'vscode', root, path: 'project' },
    )
    expect(calls).toEqual([
      { command: 'open', args: ['-a', 'Visual Studio Code', await realpath(folder)] },
    ])
  })

  test('opens a file under the workspace', async () => {
    const root = await makeRoot()
    await writeFile(join(root, 'note.txt'), 'hello')
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = []
    await openWorkspacePath(
      { host: macHost(), launch: launchInto(calls) },
      { app: 'finder', root, path: 'note.txt' },
    )
    expect(calls[0] === undefined ? undefined : calls[0].args).toEqual([
      await realpath(join(root, 'note.txt')),
    ])
  })

  test('refuses an absolute path before launching anything', async () => {
    const root = await makeRoot()
    const calls: Array<unknown> = []
    await expect(resolveWorkspacePath(root, '/etc/passwd')).rejects.toThrow(
      'only a path inside the workspace can be opened',
    )
    await expect(
      openWorkspacePath(
        { host: macHost(), launch: launchInto(calls as Array<never>) },
        { app: 'finder', root, path: '/etc/passwd' },
      ),
    ).rejects.toThrow('only a path inside the workspace can be opened')
    expect(calls).toEqual([])
  })

  test('refuses a path that climbs out of the workspace', async () => {
    const root = await makeRoot()
    const outside = await mkdtemp(join(tmpdir(), 'jzh-open-outside-'))
    roots.push(outside)
    await expect(resolveWorkspacePath(root, relative(root, outside))).rejects.toThrow(
      'that path is outside the workspace',
    )
  })

  test('refuses a symlink that points outside the workspace', async () => {
    const root = await makeRoot()
    const outside = await mkdtemp(join(tmpdir(), 'jzh-open-outside-'))
    roots.push(outside)
    await symlink(outside, join(root, 'escape'), 'dir')
    await expect(resolveWorkspacePath(root, 'escape')).rejects.toThrow(
      'that path is outside the workspace',
    )
  })

  test('refuses a path that carries a control character', async () => {
    const root = await makeRoot()
    await expect(resolveWorkspacePath(root, 'a\u0000b')).rejects.toThrow(
      'the path holds a control character',
    )
    await expect(resolveWorkspacePath(root, 'a\nb')).rejects.toThrow(
      'the path holds a control character',
    )
  })

  test('refuses a path that carries a shell metacharacter', async () => {
    const root = await makeRoot()
    await expect(resolveWorkspacePath(root, 'a;b')).rejects.toThrow(
      'the path holds a shell metacharacter',
    )
    await expect(resolveWorkspacePath(root, 'a$(whoami)')).rejects.toThrow(
      'the path holds a shell metacharacter',
    )
  })

  test('keeps a folder with spaces as one argument', async () => {
    const root = await makeRoot()
    await mkdir(join(root, 'my project'))
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = []
    await openWorkspacePath(
      { host: macHost(), launch: launchInto(calls) },
      { app: 'finder', root, path: 'my project' },
    )
    expect(calls).toEqual([{ command: 'open', args: [join(await realpath(root), 'my project')] }])
  })

  test('refuses an app the page made up', async () => {
    const root = await makeRoot()
    const calls: Array<unknown> = []
    await expect(
      openWorkspacePath(
        { host: macHost(), launch: launchInto(calls as Array<never>) },
        { app: 'sh', root, path: '' },
      ),
    ).rejects.toThrow('that app cannot open a workspace on this machine')
    expect(calls).toEqual([])
  })

  test('reports the reason a launcher failed instead of claiming the app opened', async () => {
    const root = await makeRoot()
    await expect(
      openWorkspacePath(
        {
          host: macHost(),
          launch: async () => {
            throw new Error('open: command not found')
          },
        },
        { app: 'finder', root, path: '' },
      ),
    ).rejects.toThrow('could not open the workspace: open: command not found')
  })

  test('reports through the port, so a page sees the reason as the call error', async () => {
    const root = await makeRoot()
    const port = makeOpenInApp(linuxHost([]), async () => undefined)
    const reason = await Effect.runPromise(
      port.open({ app: 'files', root, path: '' }).pipe(Effect.flip),
    )
    expect(reason).toBe('that app cannot open a workspace on this machine')
    expect(port.apps().reason).toBe('no app on this machine can open a workspace with a folder')
  })

  test('reports a command that is not there instead of a silent success', async () => {
    await expect(spawnLaunch('jzh-no-such-command-394', [])).rejects.toThrow()
  })

  test('resolves once the app has started, without waiting for it to exit', async () => {
    await expect(spawnLaunch(process.execPath, ['-e', ''])).resolves.toBeUndefined()
  })

  test('the no-app default says why and refuses to open', async () => {
    expect(noOpenInApp.apps()).toEqual({
      apps: [],
      reason: 'this run has no app to open a workspace with',
    })
    const reason = await Effect.runPromise(
      noOpenInApp.open({ app: 'finder', root: '/', path: '' }).pipe(Effect.flip),
    )
    expect(reason).toBe('no app is available to open this workspace')
  })

  test('the real host reads this machine and does not invent a command', () => {
    const host = nodeOpenAppHost()
    expect(host.platform).toBe(process.platform)
    expect(host.home).not.toBe('')
    expect(host.exists('/')).toBe(true)
    expect(host.onPath('jzh-no-such-command-394')).toBe(false)
  })
})
