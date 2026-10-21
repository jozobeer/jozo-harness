import { existsSync, readFileSync } from 'node:fs'
import { writeFileAtomic } from './atomic-write.ts'
import { parseEnvFile } from './env-file.ts'

/** 600: only the user may read the file that holds secrets. */
export const SECRETS_MODE = 0o600

const readLines = (path: string): ReadonlyArray<string> =>
  existsSync(path) ? readFileSync(path, 'utf8').split('\n') : []

const write = (path: string, lines: ReadonlyArray<string>): void => {
  const text = lines.join('\n').replace(/\n+$/, '') + '\n'
  writeFileAtomic(path, text, { mode: SECRETS_MODE })
}

/** Adds or replaces one secret without disturbing the others. */
export function writeSecret(path: string, name: string, value: string): void {
  const lines = readLines(path)
  const updated = lines.map((line) => {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) return line
    const equals = trimmed.indexOf('=')
    return equals > 0 && trimmed.slice(0, equals).trim() === name ? name + '=' + value : line
  })
  const replaced = updated.some((line, index) => line !== lines[index])
  const kept = replaced
    ? updated
    : [...lines.filter((line) => line.trim() !== ''), name + '=' + value]
  write(path, kept)
}

/** The names a secrets file defines; never the values. */
export function listSecrets(path: string): ReadonlyArray<string> {
  return parseEnvFile(readLines(path).join('\n')).map(([name]) => name)
}

/** Removes one secret; true when it was there. */
export function removeSecret(path: string, name: string): boolean {
  const lines = readLines(path)
  const kept = lines.filter((line) => {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) return true
    const equals = trimmed.indexOf('=')
    return equals <= 0 || trimmed.slice(0, equals).trim() !== name
  })
  const removed = kept.length !== lines.length
  if (removed) write(path, kept)
  return removed
}
