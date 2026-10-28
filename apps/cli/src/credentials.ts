import { existsSync, readFileSync } from 'node:fs'
import { writeFileAtomic } from './atomic-write.ts'
import type { ModelEndpoint } from './models.ts'

/** 600: the store holds secret values, so only its owner may read it. */
export const CREDENTIALS_MODE = 0o600

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The reference names and values in one store. A file that is not a flat
 * object of strings is refused without quoting it: the text may be the secret
 * itself, so the error names the file and never the parse detail.
 */
export function parseCredentials(text: string, path: string): Readonly<Record<string, string>> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error(path + ' is not a JSON object of reference names to values')
  }
  if (!isRecord(raw)) throw new Error(path + ' is not a JSON object of reference names to values')
  const entries: Record<string, string> = {}
  for (const [ref, value] of Object.entries(raw)) {
    if (typeof value !== 'string') {
      throw new Error(path + ' holds a value that is not a string for the reference "' + ref + '"')
    }
    entries[ref] = value
  }
  return entries
}

/** The references a store holds; a store that is not there holds none. */
export function readCredentials(path: string): Readonly<Record<string, string>> {
  return existsSync(path) ? parseCredentials(readFileSync(path, 'utf8'), path) : {}
}

/** Adds or replaces one reference without disturbing the others. */
export function writeCredential(path: string, ref: string, value: string): void {
  const entries = readCredentials(path)
  const text = JSON.stringify({ ...entries, [ref]: value }, null, 2) + '\n'
  writeFileAtomic(path, text, { mode: CREDENTIALS_MODE })
}

/** One llm row's key variable and the reference that may fill it. */
export interface CredentialRef {
  readonly name: string
  readonly ref: string
  readonly store: string
}

/** What the reference did: nothing, wait for the environment chain, fill, or miss. */
export type CredentialRefResult =
  | { readonly kind: 'none' }
  | { readonly kind: 'present'; readonly credential: CredentialRef }
  | { readonly kind: 'filled'; readonly credential: CredentialRef }
  | { readonly kind: 'missing'; readonly credential: CredentialRef; readonly reason: string }

const hasValue = (value: string | undefined): boolean => value !== undefined && value !== ''

/**
 * Fills the llm row's key from the store, but only after the shell, the
 * nearest .env, and secrets.env had their chance: those loaders run first and
 * leave the name empty when they had nothing, so a reference is the last
 * source and the existing order does not change.
 */
export function resolveCredentialRef(
  endpoint: Pick<ModelEndpoint, 'apiKeyEnv' | 'apiKeyRef'> | undefined,
  env: Record<string, string | undefined>,
  store: string,
): CredentialRefResult {
  const ref = endpoint?.apiKeyRef
  if (endpoint === undefined || ref === undefined) return { kind: 'none' }
  const credential = { name: endpoint.apiKeyEnv, ref, store }
  if (hasValue(env[credential.name])) return { kind: 'present', credential }
  let entries: Readonly<Record<string, string>>
  try {
    entries = readCredentials(store)
  } catch (cause) {
    // The store's own error names the file and the reference, never a value.
    return {
      kind: 'missing',
      credential,
      reason: cause instanceof Error ? cause.message : String(cause),
    }
  }
  const value = entries[ref]
  if (!hasValue(value)) {
    return {
      kind: 'missing',
      credential,
      reason:
        'the credential reference "' +
        ref +
        '" has no value in ' +
        store +
        '; add it there or set ' +
        credential.name,
    }
  }
  env[credential.name] = value
  return { kind: 'filled', credential }
}
