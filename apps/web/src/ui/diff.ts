import { toolsOf, writtenPath, type TraceTurn } from './trace.ts'

/** The rows a diff draws before it folds: more than this keeps only the head and the tail. */
export const FOLD_AFTER = 16

/** One change a call made to one file, as the call's arguments carry it. */
export interface ChangeFragment {
  readonly turn: number
  readonly tool: string
  readonly result: string
  /** The lines the call took away; empty for a write. */
  readonly removed: ReadonlyArray<string>
  readonly added: ReadonlyArray<string>
}

/** One file the session changed, once, however many ways its path was spelled. */
export interface ChangedFile {
  readonly path: string
  readonly edits: number
  readonly added: number
  readonly removed: number
}

/** One line of a hunk: what it says, and where it stood on each side. */
export interface DiffLine {
  readonly kind: 'del' | 'add'
  readonly text: string
  /** The old line number; undefined for a line the change added. */
  readonly oldLine: number | undefined
  /** The new line number; undefined for a line the change removed. */
  readonly newLine: number | undefined
}

/** A run of changed lines under one `@@` header. */
export interface DiffHunk {
  readonly header: string
  readonly lines: ReadonlyArray<DiffLine>
}

/** A row as the pane draws it: a hunk header, a changed line, or the gap between hunks. */
export type DiffRow =
  | { readonly kind: 'hunk'; readonly header: string }
  | DiffLine
  | { readonly kind: 'gap' }

/** The head and the tail of a long diff, and how many rows wait between them. */
export interface FoldedDiff {
  readonly head: ReadonlyArray<DiffRow>
  readonly tail: ReadonlyArray<DiffRow>
  readonly hidden: number
}

const argsOf = (args: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(args)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** The first field of a set of spellings that holds a string; empty when none does. */
const textField = (args: Record<string, unknown>, keys: ReadonlyArray<string>): string => {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string') return value
  }
  return ''
}

const linesOf = (text: string): ReadonlyArray<string> => (text === '' ? [] : text.split('\n'))

/** The change a writing call made, or nothing when the call is not one or its path is unreadable. */
const fragmentOf = (turn: TraceTurn, tool: { name: string; args: string; result: string }) => {
  const path = writtenPath(tool.name, tool.args)
  if (path === undefined) return undefined
  const args = argsOf(tool.args)
  return {
    path,
    fragment: {
      turn: turn.turn,
      tool: tool.name,
      result: tool.result,
      // The edit tool names its strings in camelCase; an older log spells them with underscores.
      removed: linesOf(textField(args, ['oldString', 'old_string'])),
      added: linesOf(textField(args, ['newString', 'new_string', 'content'])),
    },
  }
}

/** One step of a path: a name is kept, a `..` takes the last name back, and the rest is noise. */
const stepPath = (parts: Array<string>, part: string, absolute: boolean): void => {
  if (part === '' || part === '.') return
  if (part !== '..') {
    parts.push(part)
    return
  }
  const last = parts[parts.length - 1]
  if (last !== undefined && last !== '..') {
    parts.pop()
    return
  }
  if (!absolute) parts.push('..')
}

/** A slash path with its `.` and `..` folded away, absolute when it started so. */
const resolvedPath = (path: string): string => {
  const absolute = path.startsWith('/')
  const parts: Array<string> = []
  for (const part of path.split('/')) stepPath(parts, part, absolute)
  return (absolute ? '/' : '') + parts.join('/')
}

/**
 * The path the way the session's cwd shows it, so a file named relatively and
 * absolutely is one file. A path outside the cwd keeps its own spelling.
 */
export const pathInWorkspace = (cwd: string, path: string): string => {
  const target = resolvedPath(path)
  const root = resolvedPath(cwd)
  if (root === '' || root === '/') return target
  if (target === root) return '.'
  const prefix = root + '/'
  return target.startsWith(prefix) ? target.slice(prefix.length) : target
}

/** Every file the session wrote, once, with the edits and `+n`/`−n` summed over its calls. */
export const fileChangesOf = (
  turns: ReadonlyArray<TraceTurn>,
  cwd: string,
): ReadonlyArray<ChangedFile> => {
  const files = new Map<string, { edits: number; added: number; removed: number }>()
  for (const turn of turns) {
    for (const tool of toolsOf(turn)) {
      const change = fragmentOf(turn, tool)
      if (change === undefined) continue
      const path = pathInWorkspace(cwd, change.path)
      const seen = files.get(path) ?? { edits: 0, added: 0, removed: 0 }
      files.set(path, {
        edits: seen.edits + 1,
        added: seen.added + change.fragment.added.length,
        removed: seen.removed + change.fragment.removed.length,
      })
    }
  }
  return [...files].map(([path, counts]) => ({ path, ...counts }))
}

/** Every change the session made to one file, oldest first, under its normalized path. */
export const changesOf = (
  turns: ReadonlyArray<TraceTurn>,
  path: string,
  cwd: string,
): ReadonlyArray<ChangeFragment> =>
  turns.flatMap((turn) =>
    toolsOf(turn).flatMap((tool) => {
      const change = fragmentOf(turn, tool)
      return change !== undefined && pathInWorkspace(cwd, change.path) === path
        ? [change.fragment]
        : []
    }),
  )

const headerOf = (oldStart: number, oldCount: number, newStart: number, newCount: number): string =>
  '@@ -' +
  String(oldStart) +
  ',' +
  String(oldCount) +
  ' +' +
  String(newStart) +
  ',' +
  String(newCount) +
  ' @@'

/**
 * The hunks a file's changes make, in call order. A call carries only the text it
 * replaced, so a hunk starts where the calls before it left off: the gutters count
 * the lines the arguments account for, not the lines of the file on disk.
 */
export const hunksOf = (fragments: ReadonlyArray<ChangeFragment>): ReadonlyArray<DiffHunk> => {
  let oldLine = 1
  let newLine = 1
  const hunks: Array<DiffHunk> = []
  for (const fragment of fragments) {
    const oldCount = fragment.removed.length
    const newCount = fragment.added.length
    if (oldCount === 0 && newCount === 0) continue
    const oldStart = oldLine
    const newStart = newLine
    hunks.push({
      header: headerOf(oldStart, oldCount, newStart, newCount),
      lines: [
        ...fragment.removed.map((text, index) => ({
          kind: 'del' as const,
          text,
          oldLine: oldStart + index,
          newLine: undefined,
        })),
        ...fragment.added.map((text, index) => ({
          kind: 'add' as const,
          text,
          oldLine: undefined,
          newLine: newStart + index,
        })),
      ],
    })
    oldLine = oldStart + oldCount
    newLine = newStart + newCount
  }
  return hunks
}

/** The rows of a diff: each hunk header over its lines, with a gap between hunks. */
export const diffRowsOf = (hunks: ReadonlyArray<DiffHunk>): ReadonlyArray<DiffRow> =>
  hunks.flatMap((hunk, index) =>
    index === 0
      ? [{ kind: 'hunk' as const, header: hunk.header }, ...hunk.lines]
      : [{ kind: 'gap' as const }, { kind: 'hunk' as const, header: hunk.header }, ...hunk.lines],
  )

/**
 * The head and the tail a long diff keeps while it is folded. A diff no longer
 * than the fold draws whole, so the reader sees no button for nothing.
 */
export const foldRows = (rows: ReadonlyArray<DiffRow>, keep = FOLD_AFTER): FoldedDiff => {
  if (rows.length <= keep) return { head: rows, tail: [], hidden: 0 }
  const headCount = Math.ceil(keep / 2)
  const tailCount = keep - headCount
  return {
    head: rows.slice(0, headCount),
    tail: tailCount === 0 ? [] : rows.slice(rows.length - tailCount),
    hidden: rows.length - keep,
  }
}

/** The `+n` and `−n` of a set of changes, each line counted once per call that touched it. */
export const totalsOf = (
  fragments: ReadonlyArray<ChangeFragment>,
): { added: number; removed: number } =>
  fragments.reduce(
    (totals, fragment) => ({
      added: totals.added + fragment.added.length,
      removed: totals.removed + fragment.removed.length,
    }),
    { added: 0, removed: 0 },
  )
