import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Effect } from 'effect'

/** An identity that is stable for one home and never derived from the machine. */
export interface AnonymousIdentity {
  readonly id: string
  readonly path: string
}

export interface IdentityOptions {
  readonly path: string
  /** Replaced by tests so an id can be predicted. */
  readonly random?: () => string
}

const readIdentity = (path: string): Effect.Effect<AnonymousIdentity, Error> =>
  Effect.tryPromise({
    try: async () => {
      const id = (await readFile(path, 'utf8')).trim()
      if (id === '') throw new Error('the identity file is empty')
      return { id, path }
    },
    catch: (cause) => new Error('cannot read the anonymous id at ' + path + ': ' + String(cause)),
  })

const isErrno = (cause: unknown, code: string): boolean =>
  cause instanceof Error && 'code' in cause && cause.code === code

const createIdentity = (
  path: string,
  random: () => string,
): Effect.Effect<AnonymousIdentity, Error> =>
  Effect.gen(function* () {
    const id = random()
    return yield* Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, id + '\n', { mode: 0o600, flag: 'wx' })
        return { id, path }
      },
      catch: (cause) => cause,
    })
  }).pipe(
    // Another process won the race between reading and creating; its id is ours too.
    Effect.catch((cause) => (isErrno(cause, 'EEXIST') ? readIdentity(path) : Effect.fail(cause))),
    Effect.mapError(
      (cause) => new Error('cannot keep the anonymous id at ' + path + ': ' + String(cause)),
    ),
  )

/**
 * Reads the id a home already has, or writes a new one. The write is exclusive, so
 * two runs starting together settle on one id.
 */
export const anonymousUserIdentity = (
  options: IdentityOptions,
): Effect.Effect<AnonymousIdentity, Error> =>
  readIdentity(options.path).pipe(
    Effect.catch(() => createIdentity(options.path, options.random ?? randomUUID)),
  )
