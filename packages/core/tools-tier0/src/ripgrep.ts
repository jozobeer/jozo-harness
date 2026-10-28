import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { spawn } from '@jozo-harness/process'

/** What one ripgrep run left behind. */
export interface RipgrepRun {
  readonly exitCode: number
  readonly stderr: string
  /** True when the consumer stopped the child at its own limit. */
  readonly stopped: boolean
}

/**
 * The seam the search tools use to run ripgrep. Tests provide a fake so the
 * behaviour does not depend on a real rg being installed.
 */
export interface Ripgrep {
  /** The executable found when this value was made, or undefined when PATH had none. */
  readonly executable: string | undefined
  /** Runs rg, offering each stdout line to `onLine`; false stops the child. */
  run(
    argv: ReadonlyArray<string>,
    cwd: string,
    onLine: (line: string) => boolean,
  ): Promise<RipgrepRun>
}

/** A match as ripgrep reports it, before the tool decides how much of the line to keep. */
export interface RipgrepMatch {
  readonly file: string
  readonly line: number
  readonly text: string
}

export interface ListRequest {
  readonly cwd: string
  readonly start: string
  readonly limit: number
  /**
   * Keeps only the paths the tool's own pattern matches. Ripgrep globs are not
   * used for that: an explicit positive glob re-includes files the ignore
   * files excluded, which would defeat nested .gitignore handling.
   */
  readonly accept?: (path: string) => boolean
}

export interface ListOutcome {
  readonly files: ReadonlyArray<string>
  /** Why the walker has to run instead, when ripgrep could not answer. */
  readonly fallback?: string
}

export interface MatchRequest {
  readonly cwd: string
  readonly start: string
  readonly pattern: string
  readonly limit: number
  /** The same path filter as ListRequest.accept; ripgrep globs would override the ignore rules. */
  readonly accept?: (path: string) => boolean
}

export interface MatchOutcome {
  readonly matches: ReadonlyArray<RipgrepMatch>
  readonly fallback?: string
}

const isExecutable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * The rg on PATH, or undefined. Windows names the program with an extension,
 * so both spellings are tried there.
 */
const programNames = (): ReadonlyArray<string> =>
  process.platform === 'win32' ? ['rg.exe', 'rg.cmd'] : ['rg']

const inDirectory = (
  directory: string,
  names: ReadonlyArray<string>,
  executable: (path: string) => boolean,
): string | undefined => {
  for (const name of names) {
    const candidate = join(directory, name)
    if (executable(candidate)) return candidate
  }
  return undefined
}

export const findRipgrep = (
  searchPath: string | undefined = process.env.PATH,
  executable: (path: string) => boolean = isExecutable,
): string | undefined => {
  if (searchPath === undefined) return undefined
  const names = programNames()
  for (const directory of searchPath.split(delimiter)) {
    const found = inDirectory(directory, names, executable)
    if (found !== undefined) return found
  }
  return undefined
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** Keeps a failure's message a reason rather than a transcript. */
const reasonOf = (stderr: string): string => {
  const trimmed = stderr.trim()
  if (trimmed === '') return 'no reason given'
  return trimmed.length > 300 ? trimmed.slice(0, 300) + '…' : trimmed
}

/** One decoded stdout chunk split into lines, with the unfinished tail kept for the next chunk. */
const feedLines = (
  buffered: string,
  chunk: string,
  onLine: (line: string) => boolean,
): { readonly rest: string; readonly stopped: boolean } => {
  const lines = (buffered + chunk).split('\n')
  const rest = lines.pop() ?? ''
  for (const line of lines) {
    if (!onLine(line)) return { rest: '', stopped: true }
  }
  return { rest, stopped: false }
}

const runWith = async (
  executable: string,
  argv: ReadonlyArray<string>,
  cwd: string,
  onLine: (line: string) => boolean,
): Promise<RipgrepRun> => {
  const child = spawn([executable, ...argv], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const stderr = new Response(child.stderr).text()
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let rest = ''
  let stopped = false
  try {
    while (!stopped) {
      const chunk = await reader.read()
      if (chunk.done) break
      const fed = feedLines(rest, decoder.decode(chunk.value, { stream: true }), onLine)
      rest = fed.rest
      stopped = fed.stopped
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    child.kill()
    await child.exited.catch(() => undefined)
    await stderr.catch(() => '')
    throw error
  }
  if (stopped) {
    await reader.cancel().catch(() => undefined)
    child.kill()
  }
  const [exitCode, stderrText] = await Promise.all([child.exited, stderr])
  return { exitCode, stderr: stderrText, stopped }
}

/**
 * The seam over one executable. Tests point it at any program that prints
 * lines, so streaming and stopping can run without an installed rg.
 */
export const ripgrepAt = (executable: string | undefined): Ripgrep => ({
  executable,
  run: (argv, cwd, onLine) =>
    executable === undefined
      ? Promise.resolve({ exitCode: 127, stderr: 'rg is not on PATH', stopped: false })
      : runWith(executable, argv, cwd, onLine),
})

const located = findRipgrep()

export const defaultRipgrep: Ripgrep = ripgrepAt(located)

/** The note a result carries when the built-in walker stood in for ripgrep. */
export const fallbackNote = (reason: string): string =>
  'note: ripgrep (rg) ' +
  reason +
  '; fell back to the built-in walker, which reads only the workspace-root .gitignore and .ignore and cannot honour nested ignore files.'

const withLimit = (values: ReadonlyArray<string>, limit: number): ReadonlyArray<string> =>
  values.length <= limit ? values : values.slice(0, limit)

const listArguments = (request: ListRequest): ReadonlyArray<string> => [
  '--files',
  '--hidden',
  '--no-require-git',
  '--no-ignore-parent',
  '--glob',
  '!.git',
  '--glob',
  '!node_modules',
  ...(request.start === '' ? [] : ['--', request.start]),
]

/** Lists files with ripgrep, or says why the caller must walk the tree itself. */
export const listWithRipgrep = async (
  request: ListRequest,
  ripgrep: Ripgrep = defaultRipgrep,
): Promise<ListOutcome> => {
  if (ripgrep.executable === undefined) return { files: [], fallback: 'is not on PATH' }
  const files: Array<string> = []
  try {
    const run = await ripgrep.run(listArguments(request), request.cwd, (line) => {
      if (line === '' || (request.accept !== undefined && !request.accept(line))) return true
      files.push(line)
      return files.length < request.limit
    })
    if (!run.stopped && run.exitCode !== 0) {
      return { files: [], fallback: 'failed: ' + reasonOf(run.stderr) }
    }
    return { files: withLimit(files, request.limit) }
  } catch (error) {
    return { files: [], fallback: 'failed: ' + messageOf(error) }
  }
}

const grepArguments = (request: MatchRequest): ReadonlyArray<string> => [
  '--json',
  '--hidden',
  '--no-require-git',
  '--no-ignore-parent',
  '--glob',
  '!.git',
  '--glob',
  '!node_modules',
  '--regexp',
  request.pattern,
  ...(request.start === '' ? [] : ['--', request.start]),
]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const textAt = (value: unknown, key: string): string | undefined => {
  if (!isRecord(value)) return undefined
  const text = value[key]
  return typeof text === 'string' ? text : undefined
}

const pathText = (data: unknown): string | undefined =>
  isRecord(data) ? textAt(data.path, 'text') : undefined

/** One JSON match event, or undefined when the event carries no usable line. */
const matchOf = (data: unknown): RipgrepMatch | undefined => {
  if (!isRecord(data)) return undefined
  const file = pathText(data)
  const text = textAt(data.lines, 'text')
  const line = data.line_number
  if (file === undefined || text === undefined || typeof line !== 'number') return undefined
  return { file, line, text: text.endsWith('\n') ? text.slice(0, -1) : text }
}

/** A file ripgrep found a NUL in ends with a byte offset; its matches are not text. */
const binaryEnd = (data: unknown): boolean =>
  isRecord(data) && typeof data.binary_offset === 'number'

interface PendingFile {
  readonly file: string
  readonly matches: Array<RipgrepMatch>
}

interface MatchCollector {
  readonly found: Array<RipgrepMatch>
  accept(line: string): boolean
}

const parseEvent = (line: string): unknown => {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

/**
 * Reads ripgrep's JSON events. A file's matches are kept only once its end
 * event says the file was text; ripgrep reports matches before it reaches the
 * NUL that marks a binary file.
 */
interface CollectorState {
  pending: PendingFile | undefined
}

const startFile = (state: CollectorState, data: unknown): void => {
  const file = pathText(data)
  state.pending = file === undefined ? undefined : { file, matches: [] }
}

const takeMatch = (state: CollectorState, data: unknown): void => {
  const pending = state.pending
  if (pending === undefined) return
  const match = matchOf(data)
  if (match !== undefined && match.file === pending.file) pending.matches.push(match)
}

const finishFile = (
  state: CollectorState,
  data: unknown,
  keep: ((file: string) => boolean) | undefined,
  found: Array<RipgrepMatch>,
  limit: number,
): boolean => {
  const pending = state.pending
  state.pending = undefined
  if (pending === undefined) return true
  if (!binaryEnd(data) && (keep === undefined || keep(pending.file))) {
    found.push(...pending.matches)
  }
  return found.length <= limit
}

const matchCollector = (limit: number, keep?: (file: string) => boolean): MatchCollector => {
  const found: Array<RipgrepMatch> = []
  const state: CollectorState = { pending: undefined }
  const accept = (line: string): boolean => {
    const event = parseEvent(line)
    if (!isRecord(event)) return true
    if (event.type === 'begin') {
      startFile(state, event.data)
      return true
    }
    if (event.type === 'match') {
      takeMatch(state, event.data)
      return true
    }
    if (event.type === 'end') return finishFile(state, event.data, keep, found, limit)
    return true
  }
  return { found, accept }
}

/** Every text match ripgrep reported, or why the caller must search with the walker. */
export const findMatchesWithRipgrep = async (
  request: MatchRequest,
  ripgrep: Ripgrep = defaultRipgrep,
): Promise<MatchOutcome> => {
  if (ripgrep.executable === undefined) return { matches: [], fallback: 'is not on PATH' }
  const collector = matchCollector(request.limit, request.accept)
  try {
    const run = await ripgrep.run(grepArguments(request), request.cwd, (line) =>
      collector.accept(line),
    )
    // ripgrep exits 1 when it found nothing; only 2 and above are failures.
    if (!run.stopped && run.exitCode !== 0 && run.exitCode !== 1) {
      return { matches: [], fallback: 'failed: ' + reasonOf(run.stderr) }
    }
    return { matches: collector.found.slice(0, request.limit) }
  } catch (error) {
    return { matches: [], fallback: 'failed: ' + messageOf(error) }
  }
}
