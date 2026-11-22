import { spawn } from 'node:child_process'
import { Effect } from 'effect'
import type {
  DirEntry,
  FileStat,
  FileSystemFailure,
  FileSystemShape,
  Observation,
  StagedFile,
} from './index.ts'

/**
 * The file seam over a remote POSIX shell. Every question is a small shell
 * program and every answer is a tagged line, so nothing here parses a human
 * message, and a host whose tools spell their flags differently still answers
 * the same fields.
 */

/** How one shell program is run on a host, and where its work happens. */
export interface RemoteHost {
  /** The workspace on the host; the directory a program runs in. */
  readonly cwd: string
  /**
   * The argv that runs one POSIX shell program there. `ssh … sh -c <program>`
   * for a real host; a test passes a local shell, so the same programs run.
   */
  readonly shell: (program: string) => ReadonlyArray<string>
  /** The environment the local process gets. */
  readonly env?: NodeJS.ProcessEnv
  /** How long one round trip may take. Defaults to two minutes. */
  readonly timeoutMs?: number
}

export const REMOTE_DEFAULT_TIMEOUT_MS = 120_000

/** A remote call that did not finish: after this, no output can be trusted. */
export class RemoteError extends Error {
  readonly exitCode: number

  constructor(message: string, exitCode = 255) {
    super(message)
    this.name = 'RemoteError'
    this.exitCode = exitCode
  }
}

/** The marker a field line starts with. */
export const TAG = '__jzh__'

/** The marker that starts a body: every line after it is data, not a field. */
export const BODY = '__jzh__ data'

/** The exit code a program uses when the path is not there. */
export const ABSENT = 4
/** The exit code a program uses when the path is a directory where a file was wanted. */
export const IS_DIRECTORY = 5

export interface RemoteResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** Runs one shell program on the host, optionally handing it bytes on stdin. */
export const runRemote = (
  host: RemoteHost,
  program: string,
  input?: string,
): Promise<RemoteResult> =>
  new Promise((resolve, reject) => {
    const [file, ...args] = host.shell(program)
    if (file === undefined) {
      reject(new RemoteError('no program runs the remote shell'))
      return
    }
    const child = spawn(file, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: host.env,
    })
    // The readers start before any byte can arrive; a child whose exit is
    // reported before its output is drained would otherwise lose the output.
    const out: Array<Buffer> = []
    const err: Array<Buffer> = []
    child.stdout?.on('data', (chunk: Buffer) => out.push(Buffer.from(chunk)))
    child.stderr?.on('data', (chunk: Buffer) => err.push(Buffer.from(chunk)))
    child.stdin?.on('error', () => undefined)
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(
        new RemoteError('the remote call timed out after ' + String(timeoutOf(host)) + 'ms', 124),
      )
    }, timeoutOf(host))
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new RemoteError('cannot reach the remote host: ' + error.message))
    })
    child.once('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        exitCode: code ?? 255,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      })
    })
    if (input !== undefined) child.stdin?.write(input)
    child.stdin?.end()
  })

const timeoutOf = (host: RemoteHost): number => host.timeoutMs ?? REMOTE_DEFAULT_TIMEOUT_MS

/** A value as one shell word with nothing special left in it. */
export const shellQuote = (value: string): string => "'" + value.split("'").join("'\\''") + "'"

/** One field line a program prints. */
export const fieldLine = (key: string, value: string): string =>
  'printf "__jzh__ ' + key + ' %s\\n" ' + value

/** What a program's output holds: its fields, and the body after the marker. */
export interface RemoteRecord {
  readonly fields: Readonly<Record<string, string>>
  readonly body: string
}

export const recordOf = (stdout: string): RemoteRecord => {
  const at = stdout.indexOf(BODY)
  const header = at < 0 ? stdout : stdout.slice(0, at)
  const body = at < 0 ? '' : stdout.slice(at + BODY.length).replace(/^\n/, '')
  const fields: Record<string, string> = {}
  for (const line of header.split('\n')) {
    const match = /^__jzh__ (\w+) (.*)$/.exec(line)
    if (match === null) continue
    fields[match[1] ?? ''] = match[2] ?? ''
  }
  return { fields, body }
}

/** Why a remote call failed, in the host's own words when it had any. */
export const remoteFailure = (result: RemoteResult, what: string): string => {
  const reason = result.stderr.trim()
  return reason === ''
    ? what + ' failed on the remote host (exit ' + String(result.exitCode) + ')'
    : what + ': ' + reason
}

/**
 * The shell functions every program starts from. GNU and BSD spell `stat` and
 * `sha256` differently, so each tries both; a host with neither still answers a
 * path's kind, which is the question a confinement asks.
 */
export const LIB = [
  'jzh_kind() {',
  '  if [ -L "$1" ]; then echo l',
  '  elif [ -d "$1" ]; then echo d',
  '  elif [ -f "$1" ]; then echo f',
  '  elif [ -e "$1" ]; then echo o',
  '  else echo missing; fi',
  '}',
  'jzh_size() { stat -c %s "$1" 2>/dev/null || stat -f %z "$1" 2>/dev/null || echo 0; }',
  'jzh_mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0; }',
  'jzh_mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1" 2>/dev/null || echo 644; }',
  'jzh_encode() { base64 < "$1" 2>/dev/null | tr -d "\\n"; }',
  'jzh_decode() { base64 -d 2>/dev/null || base64 -D 2>/dev/null || openssl base64 -d -A; }',
  'jzh_digest() {',
  '  sha256sum "$1" 2>/dev/null | cut -d" " -f1 | grep . ||',
  '  shasum -a 256 "$1" 2>/dev/null | cut -d" " -f1 | grep . ||',
  '  echo unsupported',
  '}',
].join('\n')

/** One path's state, or the absent code when it is not there. */
export const statProgram = (path: string): string =>
  [
    LIB,
    'p=' + shellQuote(path),
    'k=$(jzh_kind "$p")',
    'case "$k" in missing) exit ' + String(ABSENT) + ' ;; esac',
    fieldLine('kind', '"$k"'),
    fieldLine('size', '"$(jzh_size "$p")"'),
    fieldLine('mtime', '"$(jzh_mtime "$p")"'),
    fieldLine('mode', '"$(jzh_mode "$p")"'),
  ].join('\n')

/** One file's bytes, base64 after the body marker. */
export const readProgram = (path: string): string =>
  [
    LIB,
    'p=' + shellQuote(path),
    'k=$(jzh_kind "$p")',
    'case "$k" in',
    '  missing) exit ' + String(ABSENT) + ' ;;',
    '  d) exit ' + String(IS_DIRECTORY) + ' ;;',
    'esac',
    'printf "' + BODY + '\\n"',
    'jzh_encode "$p"',
    'echo',
  ].join('\n')

/** The names directly under a directory, one tagged line each. */
export const listProgram = (path: string): string =>
  [
    LIB,
    'd=' + shellQuote(path),
    '[ "$(jzh_kind "$d")" = d ] || exit 0',
    'for entry in "$d"/* "$d"/.[!.]* "$d"/..?*; do',
    '  [ -e "$entry" ] || [ -L "$entry" ] || continue',
    '  printf "__jzh__ name %s %s\\n" "$(jzh_kind "$entry")" "${entry##*/}"',
    'done',
  ].join('\n')

/** What one look saw: the digest is taken on the host, so no bytes cross for it. */
export const observeProgram = (path: string): string =>
  [
    LIB,
    'p=' + shellQuote(path),
    'k=$(jzh_kind "$p")',
    'case "$k" in',
    '  missing) exit ' + String(ABSENT) + ' ;;',
    '  f) ;;',
    '  *) exit 0 ;;',
    'esac',
    fieldLine('bytes', '"$(jzh_size "$p")"'),
    fieldLine('mtime', '"$(jzh_mtime "$p")"'),
    fieldLine('digest', '"$(jzh_digest "$p")"'),
  ].join('\n')

/** The name a staged write uses beside its target. */
const tempPathFor = (path: string): string =>
  path.slice(0, path.lastIndexOf('/') + 1) +
  '.tmp-jzh-' +
  String(process.pid) +
  '-' +
  Math.random().toString(16).slice(2, 10)

const numberField = (record: RemoteRecord, key: string): number => {
  const value = record.fields[key]
  return value === undefined || value.trim() === '' ? 0 : Number(value)
}

const kindOf = (kind: string): Omit<FileStat, 'size' | 'mtimeMs' | 'mode'> => ({
  isFile: kind === 'f',
  isDirectory: kind === 'd',
  isSymbolicLink: kind === 'l',
})

/** One remote path's state, or undefined when the host says it is not there. */
export const statRemote = async (host: RemoteHost, path: string): Promise<FileStat | undefined> => {
  const result = await runRemote(host, statProgram(path))
  if (result.exitCode === ABSENT) return undefined
  if (result.exitCode !== 0) throw new RemoteError(remoteFailure(result, 'cannot read ' + path))
  const record = recordOf(result.stdout)
  return {
    ...kindOf(record.fields['kind'] ?? 'missing'),
    size: numberField(record, 'size'),
    mtimeMs: numberField(record, 'mtime') * 1000,
    mode: Number.parseInt(record.fields['mode'] ?? '644', 8) || 0o644,
  }
}

/** One remote file's bytes. */
export const readRemote = async (host: RemoteHost, path: string): Promise<Uint8Array> => {
  const result = await runRemote(host, readProgram(path))
  if (result.exitCode === ABSENT) throw new RemoteError('no such file on the remote host: ' + path)
  if (result.exitCode === IS_DIRECTORY) throw new RemoteError('is a directory: ' + path)
  if (result.exitCode !== 0) throw new RemoteError(remoteFailure(result, 'cannot read ' + path))
  const body = recordOf(result.stdout).body.trim()
  return new Uint8Array(body === '' ? [] : Buffer.from(body, 'base64'))
}

/** The names directly under a remote directory; a missing one reads as empty. */
export const readdirRemote = async (
  host: RemoteHost,
  path: string,
): Promise<ReadonlyArray<DirEntry>> => {
  const result = await runRemote(host, listProgram(path))
  if (result.exitCode !== 0) throw new RemoteError(remoteFailure(result, 'cannot list ' + path))
  return result.stdout.split('\n').flatMap((line) => {
    const match = /^__jzh__ name (\w) (.*)$/.exec(line)
    if (match === null) return []
    return [{ name: match[2] ?? '', ...kindOf(match[1] ?? '') }]
  })
}

/** Creates a remote directory and its parents; an existing one is not a failure. */
export const mkdirpRemote = async (host: RemoteHost, path: string): Promise<void> => {
  const result = await runRemote(host, 'mkdir -p ' + shellQuote(path))
  if (result.exitCode !== 0) throw new RemoteError(remoteFailure(result, 'cannot create ' + path))
}

/** What one remote look saw. */
export const observeRemote = async (
  host: RemoteHost,
  path: string,
): Promise<Observation | undefined> => {
  const result = await runRemote(host, observeProgram(path))
  if (result.exitCode === ABSENT) return undefined
  if (result.exitCode !== 0) throw new RemoteError(remoteFailure(result, 'cannot read ' + path))
  const record = recordOf(result.stdout)
  if (record.fields['digest'] === undefined) return undefined
  return {
    bytes: numberField(record, 'bytes'),
    mtimeMs: numberField(record, 'mtime') * 1000,
    digest: record.fields['digest'],
  }
}

/**
 * Stages the bytes beside the target on the host and returns the step that
 * publishes them. Until that step runs, the host still holds the old file, so a
 * caller can refuse the write without leaving a half-written file behind.
 */
export const stageRemote = async (
  host: RemoteHost,
  path: string,
  content: string,
): Promise<StagedFile> => {
  const temp = tempPathFor(path)
  const discard = (): Promise<void> =>
    runRemote(host, 'rm -f ' + shellQuote(temp)).then(
      () => undefined,
      () => undefined,
    )
  const written = await runRemote(
    host,
    [LIB, 'jzh_decode > ' + shellQuote(temp), 'chmod 644 ' + shellQuote(temp)].join('\n'),
    Buffer.from(content, 'utf8').toString('base64'),
  )
  if (written.exitCode !== 0) {
    await discard()
    throw new RemoteError(remoteFailure(written, 'cannot write ' + path))
  }
  return {
    commit: Effect.tryPromise({
      try: async () => {
        const moved = await runRemote(host, 'mv -f ' + shellQuote(temp) + ' ' + shellQuote(path))
        if (moved.exitCode !== 0)
          throw new RemoteError(remoteFailure(moved, 'cannot write ' + path))
      },
      catch: (error) =>
        failureOf('io', error instanceof Error ? error.message : 'cannot write ' + path),
    }),
    discard: Effect.promise(discard),
  }
}

const failureOf = (code: FileSystemFailure['code'], message: string): FileSystemFailure => ({
  code,
  message,
})

/**
 * The file seam over one host. A state the host could not answer reads as "not
 * there", the same way the Node seam treats a path it cannot stat: a
 * confinement then walks on instead of refusing work the host would accept.
 */
export const remoteFileSystem = (host: RemoteHost): FileSystemShape => ({
  readBytes: (path) =>
    Effect.tryPromise({
      try: () => readRemote(host, path),
      catch: (error) =>
        failureOf('io', error instanceof Error ? error.message : 'cannot read ' + path),
    }),
  stat: (path) =>
    Effect.tryPromise({ try: () => statRemote(host, path), catch: (error) => error }).pipe(
      Effect.orElseSucceed(() => undefined),
    ),
  readdir: (path) => Effect.promise(() => readdirRemote(host, path).catch(() => [])),
  mkdirp: (path) =>
    Effect.tryPromise({
      try: () => mkdirpRemote(host, path),
      catch: (error) =>
        failureOf('io', error instanceof Error ? error.message : 'cannot create ' + path),
    }),
  stage: (path, content) =>
    Effect.tryPromise({
      try: () => stageRemote(host, path, content),
      catch: (error) =>
        failureOf('io', error instanceof Error ? error.message : 'cannot write ' + path),
    }),
  observe: (path) =>
    Effect.tryPromise({ try: () => observeRemote(host, path), catch: (error) => error }).pipe(
      Effect.orElseSucceed(() => undefined),
    ),
  lstat: (path) =>
    Effect.tryPromise({ try: () => statRemote(host, path), catch: (error) => error }).pipe(
      Effect.orElseSucceed(() => undefined),
    ),
})

/**
 * One host a session may work on instead of this machine: the ssh invocation
 * that reaches it, the workspace there, and whether its bwrap can hold a
 * command. Both seams a Tier 0 tool needs are built from this description.
 */
export interface SshHostOptions {
  /** The workspace on the remote host; every tool path is read against it. */
  readonly root: string
  /** The argv before `sh -c <program>`: `ssh` and the flags that pick the host. */
  readonly reach: ReadonlyArray<string>
  /** The mode commands run under. Defaults to workspace-write. */
  readonly mode?: 'read-only' | 'workspace-write' | 'danger-full-access'
  /** The environment the local ssh process gets. */
  readonly env?: NodeJS.ProcessEnv
  /** How long one round trip may take. Defaults to two minutes. */
  readonly timeoutMs?: number
  /**
   * Whether the host can run bwrap. The caller probes it once with
   * `probeSshBwrap`; a host that cannot is reported rather than run unconfined.
   */
  readonly confines: boolean
}

/**
 * The host as the file seam reads it. ssh joins its own arguments with spaces and
 * hands the result to the host's shell, so the program is quoted once for that
 * shell; without the quote the host runs `sh -c` on the program's first word.
 */
export const sshHost = (options: SshHostOptions): RemoteHost => ({
  cwd: options.root,
  shell: (program) => [...options.reach, 'sh', '-c', shellQuote(program)],
  ...(options.env === undefined ? {} : { env: options.env }),
  ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
})

/** The file seam over the host. */
export const sshFileSystem = (options: SshHostOptions): FileSystemShape =>
  remoteFileSystem(sshHost(options))

/**
 * Whether the host can run bwrap. A version check alone is not enough: bwrap can
 * be installed and still be unable to make the namespaces it needs, so the probe
 * also runs one minimal command inside it. A host that cannot be reached answers
 * false, the same answer a host without bwrap gives.
 */
export const probeSshBwrap = async (options: SshHostOptions): Promise<boolean> => {
  const host = sshHost(options)
  const result = await runRemote(
    host,
    'bwrap --version >/dev/null 2>&1 && bwrap --ro-bind / / --dev /dev --proc /proc true',
  ).catch(() => undefined)
  return result !== undefined && result.exitCode === 0
}
