import { Effect } from 'effect'
import type {
  DirEntry,
  FileStat,
  FileSystemFailure,
  FileSystemShape,
  Observation,
  StagedFile,
} from './index.ts'

/** The path as a store key: no `.`, no `..`, no doubled separators. */
const normalized = (path: string): string => {
  const absolute = path.startsWith('/')
  const parts: Array<string> = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      parts.pop()
      continue
    }
    parts.push(part)
  }
  return (absolute ? '/' : '') + parts.join('/')
}

const parentOf = (path: string): string => {
  const cut = path.lastIndexOf('/')
  return cut <= 0 ? '/' : path.slice(0, cut)
}

/** A short fingerprint of one string. A store with no hash function still notices a change. */
const digestOf = (content: string): string => {
  let hash = 0x811c9dc5
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

interface Entry {
  readonly content: string
  readonly mtimeMs: number
}

const missing = (path: string): FileSystemFailure => ({
  code: 'not-found',
  message: 'no such file: ' + path,
})

/**
 * A workspace that lives in this process only. The browser run holds its files
 * here, so closing the page is the end of them, and a test can drive the tools
 * without a temporary directory.
 *
 * @param initial - files to start with, keyed by path.
 */
export const makeMemoryFileSystem = (
  initial: Readonly<Record<string, string>> = {},
): FileSystemShape => {
  const files = new Map<string, Entry>()
  const directories = new Set<string>(['/'])
  let clock = 1

  const touch = (): number => {
    clock += 1
    return clock
  }

  const addDirectory = (path: string): void => {
    let current = path
    for (;;) {
      directories.add(current)
      if (current === '/') return
      current = parentOf(current)
    }
  }

  const put = (path: string, content: string): void => {
    const key = normalized(path)
    addDirectory(parentOf(key))
    files.set(key, { content, mtimeMs: touch() })
  }

  const statOf = (key: string): FileStat | undefined => {
    const file = files.get(key)
    if (file !== undefined) {
      return {
        size: file.content.length,
        mtimeMs: file.mtimeMs,
        mode: 0o644,
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
      }
    }
    return directories.has(key)
      ? {
          size: 0,
          mtimeMs: 0,
          mode: 0o755,
          isFile: false,
          isDirectory: true,
          isSymbolicLink: false,
        }
      : undefined
  }

  const readdir = (path: string): ReadonlyArray<DirEntry> => {
    const key = normalized(path)
    const names = new Map<string, DirEntry>()
    for (const file of files.keys()) {
      if (parentOf(file) !== key) continue
      names.set(file.slice(key === '/' ? 1 : key.length + 1), {
        name: file.slice(key === '/' ? 1 : key.length + 1),
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
      })
    }
    for (const directory of directories) {
      if (directory === key || parentOf(directory) !== key) continue
      const name = directory.slice(key === '/' ? 1 : key.length + 1)
      names.set(name, { name, isFile: false, isDirectory: true, isSymbolicLink: false })
    }
    return [...names.values()]
  }

  for (const [path, content] of Object.entries(initial)) put(path, content)

  return {
    readBytes: (path) => {
      const key = normalized(path)
      const file = files.get(key)
      if (file === undefined) return Effect.fail(missing(path))
      return Effect.succeed(new TextEncoder().encode(file.content))
    },
    stat: (path) => Effect.sync(() => statOf(normalized(path))),
    readdir: (path) => Effect.sync(() => readdir(path)),
    mkdirp: (path) =>
      Effect.sync(() => {
        addDirectory(normalized(path))
      }),
    stage: (path, content) => {
      const key = normalized(path)
      let published = false
      const commit = Effect.sync(() => {
        if (published) return
        published = true
        put(key, content)
      })
      return Effect.succeed<StagedFile>({ commit, discard: Effect.void })
    },
    observe: (path) => {
      const key = normalized(path)
      const file = files.get(key)
      if (file === undefined) {
        return Effect.succeed(
          statOf(key)?.isFile === true
            ? ({ bytes: 0, mtimeMs: 0, digest: 'unreadable' } satisfies Observation)
            : undefined,
        )
      }
      return Effect.succeed({
        bytes: file.content.length,
        mtimeMs: file.mtimeMs,
        digest: digestOf(file.content),
      } satisfies Observation)
    },
    lstat: (path) => statOf(normalized(path)),
  }
}
