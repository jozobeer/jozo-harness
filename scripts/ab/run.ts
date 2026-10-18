/**
 * The A/B: the same three tasks, run through jozo-harness and dsh, measured from each
 * harness's own session log — tool calls, failed edits, re-reads, and turns.
 *
 * Run it from the repo root with both harnesses configured:
 *
 *   node scripts/ab/run.ts
 *
 * Both harnesses are pointed at the same Ollama Cloud model. jozo-harness reads the key
 * from ~/.config/jzh/secrets.env on its own; dsh is given it here (from the
 * environment, or from that same file) and runs from a workspace-local DSH_HOME
 * with scripts/ab/dsh-provider.patch.yml as its profile patch, because a harness
 * session may not write outside its workspace. A harness that cannot answer is
 * reported, not hidden.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { dshMetrics, jozoHarnessMetrics, type AbEvent, type AbMetrics } from './metrics.ts'
import { tableOf, type Cell } from './table.ts'
import { zstdText } from './zstd.ts'
import { TASKS, type AbTask } from './tasks.ts'

const ROUTE = process.env.JZH_AB_ROUTE ?? 'ollama-cloud/deepseek-v4.1-flash'
const MODEL = ROUTE.includes('/') ? ROUTE.slice(ROUTE.indexOf('/') + 1) : ROUTE
const TIMEOUT_MS = Number(process.env.JZH_AB_TIMEOUT_MS ?? '300000')
/** How many times each cell runs; one run cannot tell a harness difference from noise. */
const REPEATS = Math.max(1, Number(process.env.JZH_AB_REPEATS ?? '1'))
/** The tasks to run, by name and comma-separated; every task when unset. */
const ONLY = process.env.JZH_AB_TASKS?.split(',').map((name) => name.trim())
const tasks = TASKS.filter((task) => ONLY === undefined || ONLY.includes(task.name))
/** The harnesses to run; both when unset. */
const ONLY_HARNESS = process.env.JZH_AB_HARNESS?.split(',').map((name) => name.trim())
/**
 * jozo-harness compacts at the smaller of window × 0.8 and window − headroom: 16,000
 * tokens here, the same line dsh-provider.patch.yml gives dsh. A run that asks for the
 * profile's own budget skips the patch, so the line is the shipped one.
 */
const JZH_COMPACT = { contextWindow: 20_000, headroomTokens: 4_000 }
const SHIPPED_WINDOW = process.env.JZH_AB_SHIPPED_WINDOW === '1'
const root = process.cwd()
const abRoot = join(root, '.tmp', 'ab')
const dshTemplate = join(abRoot, 'dsh-template')
const dshEnv = Object.fromEntries(
  Object.entries(process.env).flatMap(([key, value]) =>
    value === undefined || ['DSH_SESSION_ID', 'DSH_PROFILE', 'DSH_PROFILE_DIR'].includes(key)
      ? []
      : [[key, value]],
  ),
) as Record<string, string>

/** The key the Ollama Cloud route needs: the environment first, then jozo-harness's own file. */
const ollamaKey = (): string | undefined => {
  if (process.env.OLLAMA_API_KEY !== undefined && process.env.OLLAMA_API_KEY !== '') {
    return process.env.OLLAMA_API_KEY
  }
  try {
    const text = readFileSync(join(homedir(), '.config', 'jzh', 'secrets.env'), 'utf8')
    return /^OLLAMA_API_KEY=(.+)$/m.exec(text)?.[1]?.trim()
  } catch {
    return undefined
  }
}

/** The newest file under a directory, matching a name and written after `since`. */
const newestFile = async (
  directory: string,
  matches: (name: string) => boolean,
  since: number,
): Promise<string | undefined> => {
  const found: Array<{ path: string; time: number }> = []
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) {
        await walk(child)
        continue
      }
      if (!matches(entry.name)) continue
      const time = (await stat(child)).mtimeMs
      if (time >= since) found.push({ path: child, time })
    }
  }
  await walk(directory)
  return found.sort((left, right) => right.time - left.time)[0]?.path
}

/** The last non-empty line of a harness's output: why it stopped, in its own words. */
const lastLine = (text: string): string =>
  text
    .trim()
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(-1)[0]
    ?.slice(0, 240) ?? ''

/** The lines that parsed, in the order the log wrote them. */
const jsonl = (text: string): ReadonlyArray<AbEvent> =>
  text.split('\n').flatMap((line): ReadonlyArray<AbEvent> => {
    if (line.trim() === '') return []
    try {
      return [JSON.parse(line) as AbEvent]
    } catch {
      return []
    }
  })

/** The dsh log is zstd, one frame per append; zstdText reads every frame. */
const zstdJsonl = (path: string): ReadonlyArray<AbEvent> => jsonl(zstdText(readFileSync(path)))

/** A log that cannot be counted spoils its own run, not the runs still to come. */
const countedOf = (count: () => AbMetrics): AbMetrics | Error => {
  try {
    return count()
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

/** Why a run has no numbers or did not exit cleanly; undefined when there is nothing to say. */
const noteOf = (
  counted: AbMetrics | Error | undefined,
  code: number | undefined,
  output: string,
): string | undefined => {
  if (counted === undefined) return 'no session log: ' + lastLine(output)
  if (counted instanceof Error) return 'not counted: ' + counted.message
  return code === 0 ? undefined : lastLine(output)
}

const spawn = (
  argv: ReadonlyArray<string>,
  cwd: string,
  env: Record<string, string>,
  timeout: number,
): { code: number | undefined; output: string } => {
  const [command, ...rest] = argv
  const run = spawnSync(command ?? '', rest, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    killSignal: 'SIGKILL',
  })
  return {
    code: run.status ?? undefined,
    output: (run.stdout?.toString() ?? '') + (run.stderr?.toString() ?? ''),
  }
}

const jozoHarnessPatch = (sessions: string): string =>
  [
    'name: ab',
    'plugins:',
    '  - id: session-jsonl',
    "    name: '@jozo-harness/session-jsonl'",
    '    config:',
    '      root: ' + sessions,
    ...(SHIPPED_WINDOW
      ? []
      : [
          '  - id: agent-loop',
          "    name: '@jozo-harness/agent-loop'",
          '    config:',
          '      contextWindow: ' + String(JZH_COMPACT.contextWindow),
          '      headroomTokens: ' + String(JZH_COMPACT.headroomTokens),
        ]),
    '',
  ].join('\n')

const runJozoHarness = async (
  task: AbTask,
  workspace: string,
  sessions: string,
): Promise<Omit<Cell, 'repeat'>> => {
  const patch = join(workspace, '.ab-patch.yml')
  await writeFile(patch, jozoHarnessPatch(sessions))
  const started = Date.now()
  const { code, output } = spawn(
    [
      process.execPath,
      join(root, 'apps', 'cli', 'src', 'run.ts'),
      '--patch',
      patch,
      '--model',
      ROUTE,
      task.prompt,
    ],
    workspace,
    process.env as Record<string, string>,
    task.timeoutMs ?? TIMEOUT_MS,
  )
  const log = await newestFile(sessions, (name) => name === 'session.v1.jsonl', started)
  const events = log === undefined ? undefined : jsonl(await readFile(log, 'utf8'))
  const counted = events === undefined ? undefined : countedOf(() => jozoHarnessMetrics(events))
  return {
    harness: 'jozo-harness',
    task: task.name,
    code,
    done: await task.done(workspace),
    metrics: counted instanceof Error ? undefined : counted,
    note: noteOf(counted, code, output),
  }
}

const runDsh = async (
  task: AbTask,
  workspace: string,
  dshHome: string,
): Promise<Omit<Cell, 'repeat'>> => {
  const started = Date.now()
  const key = ollamaKey()
  const { code, output } = spawn(
    ['dsh', 'headless', task.prompt],
    workspace,
    {
      ...dshEnv,
      DSH_HOME: dshHome,
      ...(key === undefined ? {} : { OLLAMA_API_KEY: key }),
    },
    task.timeoutMs ?? TIMEOUT_MS,
  )
  const log = await newestFile(
    join(dshHome, 'sessions'),
    (name) => name.endsWith('.jsonl.zstd'),
    started,
  )
  const counted = log === undefined ? undefined : countedOf(() => dshMetrics(zstdJsonl(log)))
  return {
    harness: 'dsh',
    task: task.name,
    code,
    done: await task.done(workspace),
    metrics: counted instanceof Error ? undefined : counted,
    note: noteOf(counted, code, output),
  }
}

/** One dsh home per run: a profile copy plus the route both harnesses share. */
const prepareDshHome = async (dshHome: string): Promise<void> => {
  const home = join(homedir(), '.dsh')
  await mkdir(dshHome, { recursive: true })
  await cp(join(home, 'profiles'), join(dshHome, 'profiles'), { recursive: true }).catch(
    () => undefined,
  )
  await cp(join(home, '.anonymous-user-id'), join(dshHome, '.anonymous-user-id')).catch(
    () => undefined,
  )
  // The route both harnesses run on, written over the profile the copy brought.
  const patch = (await readFile(join(root, 'scripts', 'ab', 'dsh-provider.patch.yml'), 'utf8'))
    .split('deepseek-v4.1-flash')
    .join(MODEL)
  await writeFile(join(dshHome, 'cordis.patch.yml'), patch)
}

const prepare = async (): Promise<void> => {
  await rm(abRoot, { recursive: true, force: true })
  await mkdir(abRoot, { recursive: true })
  await prepareDshHome(dshTemplate)
}

const cellOf = async (
  harness: 'jozo-harness' | 'dsh',
  task: AbTask,
  repeat: number,
): Promise<Cell> => {
  const runRoot = join(abRoot, 'runs', harness + '-' + task.name + '-' + String(repeat + 1))
  const workspace = join(runRoot, 'workspace')
  const sessions = join(runRoot, 'sessions')
  await mkdir(workspace, { recursive: true })
  await mkdir(sessions, { recursive: true })
  if (harness === 'dsh') await cp(dshTemplate, join(runRoot, 'dsh-home'), { recursive: true })
  for (const [path, text] of Object.entries(task.files)) {
    await mkdir(dirname(join(workspace, path)), { recursive: true })
    await writeFile(join(workspace, path), text)
  }
  const result =
    harness === 'jozo-harness'
      ? await runJozoHarness(task, workspace, sessions)
      : await runDsh(task, workspace, join(runRoot, 'dsh-home'))
  return { ...result, repeat }
}

const HARNESSES: ReadonlyArray<'jozo-harness' | 'dsh'> = ['jozo-harness', 'dsh'].filter(
  (name) => ONLY_HARNESS === undefined || ONLY_HARNESS.includes(name),
) as ReadonlyArray<'jozo-harness' | 'dsh'>

await prepare()
const cells: Array<Cell> = []
for (const task of tasks) {
  for (const harness of HARNESSES) {
    for (let repeat = 0; repeat < REPEATS; repeat += 1) {
      process.stdout.write(
        'running ' +
          harness +
          ' on ' +
          task.name +
          ' (' +
          String(repeat + 1) +
          '/' +
          String(REPEATS) +
          ')...\n',
      )
      cells.push(await cellOf(harness, task, repeat))
    }
  }
}

const groups = tasks.flatMap((task) =>
  HARNESSES.map((harness) =>
    cells.filter((cell) => cell.harness === harness && cell.task === task.name),
  ),
)

process.stdout.write(tableOf(cells, groups))
