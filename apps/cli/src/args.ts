export interface ParsedArgs {
  readonly profile: string
  /** The raw --profile, so a settings file can be overridden. */
  readonly profileFlag: string | undefined
  readonly patches: ReadonlyArray<string>
  readonly task: string | undefined
  /** `jzh models`: list what the provider offers instead of running. */
  readonly models: boolean
  /** `jzh web`: serve the browser UI instead of running a turn. */
  readonly web: boolean
  /** `jzh sessions [id]`: list the sessions, or read one back. */
  readonly sessions: boolean
  readonly sessionId?: string | undefined
  /** `jzh sessions --search <text>`: find sessions by what they say. */
  readonly search?: string | undefined
  /** `jzh sessions --all`: list the sessions nobody said anything in too. */
  readonly all: boolean
  /** Port for `jzh web`; 0 asks the system for a free one. */
  readonly port: number
  readonly resume: string | undefined
  /** Continue a resumed session even when this run's composition differs from its own. */
  readonly allowPresetChange: boolean
  readonly model: string
  /** The raw --model, so a settings file can be overridden. */
  readonly modelFlag: string | undefined
  readonly effort: string
  /** The raw --effort, so a settings file can be overridden. */
  readonly effortFlag: string | undefined
  /** Lets the model run tasks in child agents. */
  readonly subagents: boolean
  readonly dumpConfig: boolean
  readonly json: boolean
  /** Forces the terminal UI even when stdin is not a terminal. */
  readonly tui: boolean
  readonly config: string | undefined
  readonly help: boolean
  readonly errors: ReadonlyArray<string>
}

interface FlagSpec {
  readonly kind: 'boolean' | 'value'
}

const FLAGS: ReadonlyMap<string, FlagSpec> = new Map<string, FlagSpec>([
  ['--dump-config', { kind: 'boolean' }],
  ['--json', { kind: 'boolean' }],
  ['--tui', { kind: 'boolean' }],
  ['--help', { kind: 'boolean' }],
  ['--profile', { kind: 'value' }],
  ['--patch', { kind: 'value' }],
  ['--resume', { kind: 'value' }],
  ['--model', { kind: 'value' }],
  ['--effort', { kind: 'value' }],
  ['--config', { kind: 'value' }],
  ['--search', { kind: 'value' }],
  ['--port', { kind: 'value' }],
  ['--allow-preset-change', { kind: 'boolean' }],
  ['--subagents', { kind: 'boolean' }],
  ['--all', { kind: 'boolean' }],
])

/** The flags the parser knows, in the order it declares them. */
export const FLAG_NAMES: ReadonlyArray<string> = [...FLAGS.keys()]

interface ScannedArgs {
  values: Map<string, Array<string>>
  words: Array<string>
  errors: Array<string>
}

/** Applies one argument; returns how many further arguments it consumed. */
const scanOne = (argv: ReadonlyArray<string>, index: number, out: ScannedArgs): number => {
  const argument = argv[index] ?? ''
  if (!argument.startsWith('--')) {
    out.words.push(argument)
    return 0
  }
  const spec = FLAGS.get(argument)
  if (spec === undefined) {
    out.errors.push(`unknown option ${argument}`)
    return 0
  }
  if (spec.kind === 'boolean') {
    out.values.set(argument, ['true'])
    return 0
  }
  const value = argv[index + 1]
  if (value === undefined) {
    out.errors.push(`${argument} needs a value`)
    return 0
  }
  out.values.set(argument, [...(out.values.get(argument) ?? []), value])
  return 1
}

const scan = (argv: ReadonlyArray<string>): ScannedArgs => {
  const out: ScannedArgs = { values: new Map(), words: [], errors: [] }
  let index = 0
  while (index < argv.length) index += 1 + scanOne(argv, index, out)
  return out
}

const first = (values: ReadonlyMap<string, Array<string>>, flag: string): string | undefined =>
  values.get(flag)?.[0]

const portOf = (raw: string | undefined, errors: Array<string>): number => {
  if (raw === undefined) return 0
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    errors.push('--port needs a whole number between 0 and 65535')
    return 0
  }
  return port
}

/** What the positional words name: a subcommand, or the one-shot task. */
interface Words {
  readonly models: boolean
  readonly web: boolean
  readonly sessions: boolean
  readonly sessionId: string | undefined
  readonly task: string | undefined
}

const NOTHING: Omit<Words, 'task'> = {
  models: false,
  web: false,
  sessions: false,
  sessionId: undefined,
}

const wordsOf = (words: ReadonlyArray<string>): Words => {
  const first = words[0]
  if (words.length === 1 && first === 'models') return { ...NOTHING, models: true, task: undefined }
  if (words.length === 1 && first === 'web') return { ...NOTHING, web: true, task: undefined }
  // `jzh sessions` lists them; `jzh sessions <id>` reads one back.
  if (first === 'sessions' && words.length <= 2) {
    return { ...NOTHING, sessions: true, sessionId: words[1], task: undefined }
  }
  return { ...NOTHING, task: words.length === 0 ? undefined : words.join(' ') }
}

/** Parses `jzh` arguments. Positional words join into the one-shot task. */
export function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const { values, words, errors } = scan(argv)
  const port = portOf(first(values, '--port'), errors)
  return {
    ...wordsOf(words),
    profile: first(values, '--profile') ?? 'headless',
    profileFlag: first(values, '--profile'),
    patches: values.get('--patch') ?? [],
    port,
    resume: first(values, '--resume'),
    allowPresetChange: values.has('--allow-preset-change'),
    model: first(values, '--model') ?? '',
    modelFlag: first(values, '--model'),
    effort: first(values, '--effort') ?? '',
    effortFlag: first(values, '--effort'),
    subagents: values.has('--subagents'),
    dumpConfig: values.has('--dump-config'),
    json: values.has('--json'),
    tui: values.has('--tui'),
    config: first(values, '--config'),
    search: first(values, '--search'),
    all: values.has('--all'),
    help: values.has('--help'),
    errors,
  }
}
