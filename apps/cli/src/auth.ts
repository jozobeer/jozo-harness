import { configPaths, type ConfigPaths } from './config.ts'
import { writeCredential } from './credentials.ts'
import { PROVIDERS, providerByEnv, providerByName } from './providers.ts'
import { listSecrets, removeSecret, writeSecret } from './secrets-file.ts'

export interface AuthIo {
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
  /** Reads one secret; a terminal hides what is typed. */
  readonly readLine: (prompt: string) => Promise<string>
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

const usage = (io: AuthIo): number => {
  io.stderr(
    'jzh auth add PROVIDER  store the key for a service (' +
      PROVIDERS.map((p) => p.name).join(', ') +
      ')\n',
  )
  io.stderr('jzh auth set NAME      store one secret under an exact name\n')
  io.stderr('jzh auth ref NAME      store a referenced secret in credentials.json\n')
  io.stderr('jzh auth list          show which services have a key\n')
  io.stderr('jzh auth remove NAME   forget one secret\n')
  return 2
}

type AuthCommand = (argv: ReadonlyArray<string>, io: AuthIo, paths: ConfigPaths) => Promise<number>

/** Reads one secret, rejects an empty read, and stores it under one exact name. */
const storeSecret = async (
  paths: ConfigPaths,
  io: AuthIo,
  name: string,
  prompt: string,
  label: string,
): Promise<number> => {
  const value = (await io.readLine(prompt)).trim()
  if (value === '') {
    io.stderr('jzh: nothing was read, so nothing was stored\n')
    return 2
  }
  writeSecret(paths.secrets, name, value)
  io.stdout('jzh: stored ' + label + ' in ' + paths.secrets + '\n')
  return 0
}

const addProvider: AuthCommand = async (argv, io, paths) => {
  const provider = providerByName(argv[0] ?? '')
  if (provider === undefined) return usage(io)
  return storeSecret(paths, io, provider.env, provider.env + ': ', 'the ' + provider.name + ' key')
}

const setName: AuthCommand = async (argv, io, paths) => {
  const name = argv[0] ?? ''
  if (!NAME.test(name)) return usage(io)
  return storeSecret(paths, io, name, name + ': ', name)
}

/** Stores a value the settings reach by name instead of by environment variable. */
const setReference: AuthCommand = async (argv, io, paths) => {
  const name = argv[0] ?? ''
  if (!NAME.test(name)) return usage(io)
  const value = (await io.readLine('reference ' + name + ': ')).trim()
  if (value === '') {
    io.stderr('jzh: nothing was read, so nothing was stored\n')
    return 2
  }
  writeCredential(paths.credentials, name, value)
  io.stdout('jzh: stored the reference "' + name + '" in ' + paths.credentials + '\n')
  return 0
}

const listNames: AuthCommand = async (_argv, io, paths) => {
  const names = listSecrets(paths.secrets)
  if (names.length === 0) {
    io.stdout('jzh: no secrets stored\n')
    return 0
  }
  for (const name of names) {
    const provider = providerByEnv(name)
    io.stdout(provider === undefined ? name + '\n' : provider.name + ' (' + name + ')\n')
  }
  return 0
}

const removeName: AuthCommand = async (argv, io, paths) => {
  const name = argv[0] ?? ''
  if (!NAME.test(name)) return usage(io)
  const removed = removeSecret(paths.secrets, name)
  io.stdout(removed ? 'jzh: removed ' + name + '\n' : 'jzh: ' + name + ' was not stored\n')
  return removed ? 0 : 1
}

const COMMANDS: Readonly<Record<string, AuthCommand | undefined>> = {
  add: addProvider,
  set: setName,
  ref: setReference,
  list: listNames,
  remove: removeName,
}

/**
 * Keeps secrets out of shell history: the value is read from the terminal (or
 * from stdin) and written to the secrets file, never echoed back.
 */
export async function runAuth(
  argv: ReadonlyArray<string>,
  io: AuthIo,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  const paths = configPaths(env)
  const handle = COMMANDS[argv[0] ?? '']
  return handle === undefined ? usage(io) : await handle(argv.slice(1), io, paths)
}
