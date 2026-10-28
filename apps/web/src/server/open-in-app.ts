import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path'
import { Effect } from 'effect'
import type { OpenAppView, OpenAppsView } from '../shared/rpc.ts'

/** The machine facts detection reads, injected so a test never looks at the host. */
export interface OpenAppHost {
  readonly platform: NodeJS.Platform
  readonly home: string
  readonly exists: (path: string) => boolean
  /** True when the command is an executable on PATH. */
  readonly onPath: (command: string) => boolean
}

/** One path inside the workspace, named the way the tree names it; '' is the root. */
export interface OpenWorkspaceRequest {
  readonly app: string
  readonly root: string
  /** Relative to the root. Absolute paths and control characters are refused. */
  readonly path: string
}

/** Starts one external program. The args are passed as an array, never through a shell. */
export type Launch = (command: string, args: ReadonlyArray<string>) => Promise<void>

interface Launcher {
  readonly app: OpenAppView
  readonly command: string
  readonly args: ReadonlyArray<string>
}

const darwinLaunchers = (host: OpenAppHost): ReadonlyArray<Launcher> => {
  const inApps = (name: string, dirs: ReadonlyArray<string>): boolean =>
    dirs.some((dir) => host.exists(join(dir, name)))
  const applications = ['/Applications', join(host.home, 'Applications')]
  const launchers: Array<Launcher> = [
    // Finder needs no bundle check: it is part of every macOS install.
    { app: { id: 'finder', label: 'Finder' }, command: 'open', args: [] },
  ]
  if (inApps('Visual Studio Code.app', applications)) {
    launchers.push({
      app: { id: 'vscode', label: 'Visual Studio Code' },
      command: 'open',
      args: ['-a', 'Visual Studio Code'],
    })
  }
  if (inApps('Cursor.app', applications)) {
    launchers.push({
      app: { id: 'cursor', label: 'Cursor' },
      command: 'open',
      args: ['-a', 'Cursor'],
    })
  }
  if (host.exists('/System/Applications/Utilities/Terminal.app')) {
    launchers.push({
      app: { id: 'terminal', label: 'Terminal' },
      command: 'open',
      args: ['-a', 'Terminal'],
    })
  }
  if (inApps('iTerm.app', applications)) {
    launchers.push({ app: { id: 'iterm', label: 'iTerm' }, command: 'open', args: ['-a', 'iTerm'] })
  }
  return launchers
}

const linuxLaunchers = (host: OpenAppHost): ReadonlyArray<Launcher> => {
  const launchers: Array<Launcher> = []
  if (host.onPath('xdg-open')) {
    launchers.push({ app: { id: 'files', label: 'Files' }, command: 'xdg-open', args: [] })
  }
  if (host.onPath('code')) {
    launchers.push({
      app: { id: 'vscode', label: 'Visual Studio Code' },
      command: 'code',
      args: [],
    })
  }
  if (host.onPath('cursor')) {
    launchers.push({ app: { id: 'cursor', label: 'Cursor' }, command: 'cursor', args: [] })
  }
  return launchers
}

/** The fixed app commands this platform may run; nothing the client sends becomes a command. */
const launchersOf = (host: OpenAppHost): ReadonlyArray<Launcher> => {
  if (host.platform === 'darwin') return darwinLaunchers(host)
  if (host.platform === 'linux') return linuxLaunchers(host)
  return []
}

/** The apps this machine can open a workspace with, in the order the page offers them. */
export const detectOpenApps = (host: OpenAppHost): ReadonlyArray<OpenAppView> =>
  launchersOf(host).map((launcher) => launcher.app)

/** What a page shows: the detected apps, or the reason the machine has none. */
export const openAppsViewOf = (host: OpenAppHost): OpenAppsView => {
  const apps = detectOpenApps(host)
  return apps.length === 0
    ? { apps, reason: 'no app on this machine can open a workspace with a folder' }
    : { apps }
}

/** True for the control characters a shell or a terminal may read as a separator. */
const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

/** Shell metacharacters are refused even though the launch never goes through a shell. */
const SHELL_METACHARACTERS = new Set([';', '&', '|', '$', '`', '"', "'", '<', '>'])

const hasShellMetacharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    if (SHELL_METACHARACTERS.has(value.charAt(index))) return true
  }
  return false
}

const inside = (root: string, target: string): boolean =>
  target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)

/**
 * Resolves one path the page named to the real path inside the workspace. Absolute
 * paths, control and shell characters, and anything a symlink points outside the
 * root are refused before any app sees them.
 */
export const resolveWorkspacePath = async (root: string, path: string): Promise<string> => {
  if (hasControlCharacter(path)) throw new Error('the path holds a control character')
  if (hasShellMetacharacter(path)) throw new Error('the path holds a shell metacharacter')
  if (isAbsolute(path)) throw new Error('only a path inside the workspace can be opened')
  const canonicalRoot = await realpath(root)
  const target = await realpath(resolve(canonicalRoot, path))
  if (!inside(canonicalRoot, target)) throw new Error('that path is outside the workspace')
  const info = await stat(target)
  if (!info.isDirectory() && !info.isFile()) {
    throw new Error('only a file or folder can be opened')
  }
  return target
}

/**
 * Opens one workspace path with one detected app. The app is looked up in the
 * fixed list rather than trusted from the page, and the path is checked again
 * after symlinks resolve; the launch itself is argv-only, with no shell.
 */
export const openWorkspacePath = async (
  deps: { readonly host: OpenAppHost; readonly launch: Launch },
  request: OpenWorkspaceRequest,
): Promise<void> => {
  const launcher = launchersOf(deps.host).find((one) => one.app.id === request.app)
  if (launcher === undefined) throw new Error('that app cannot open a workspace on this machine')
  const target = await resolveWorkspacePath(request.root, request.path)
  try {
    await deps.launch(launcher.command, [...launcher.args, target])
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error('could not open the workspace: ' + reason)
  }
}

/**
 * The port the Web server holds. Detection runs once per call so a page opened
 * after an app was installed sees it; the launch happens outside the sandbox,
 * as the human's own action, because the server process is theirs.
 */
export interface OpenInAppPort {
  readonly apps: () => OpenAppsView
  readonly open: (request: OpenWorkspaceRequest) => Effect.Effect<void, string>
}

/** The real host: process facts, and executables found on PATH. */
export const nodeOpenAppHost = (): OpenAppHost => ({
  platform: process.platform,
  home: homedir(),
  exists: (path) => existsSync(path),
  onPath: (command) =>
    (process.env['PATH'] ?? '')
      .split(delimiter)
      .filter((dir) => dir !== '')
      .some((dir) => existsSync(join(dir, command))),
})

/** Starts the app detached, so the server does not wait for it or reap it. */
export const spawnLaunch: Launch = (command, args) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], { detached: true, stdio: 'ignore', shell: false })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolvePromise()
    })
  })

export const makeOpenInApp = (
  host: OpenAppHost = nodeOpenAppHost(),
  launch: Launch = spawnLaunch,
): OpenInAppPort => ({
  apps: () => openAppsViewOf(host),
  open: (request) =>
    Effect.tryPromise({
      try: () => openWorkspacePath({ host, launch }, request),
      catch: (error) => (error instanceof Error ? error.message : String(error)),
    }),
})

/** The port a run without a detector keeps: the page says no app is available. */
export const noOpenInApp: OpenInAppPort = {
  apps: () => ({ apps: [], reason: 'this run has no app to open a workspace with' }),
  open: () => Effect.fail('no app is available to open this workspace'),
}
