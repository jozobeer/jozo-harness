import type { FileDiff } from '@jozo-harness/tools'
import { linesOf } from './text.ts'

/** The 1-based line a character index falls on. */
const lineAt = (text: string, index: number): number => {
  let line = 1
  let found = text.indexOf('\n')
  while (found >= 0 && found < index) {
    line += 1
    found = text.indexOf('\n', found + 1)
  }
  return line
}

/**
 * One diff per occurrence of the old text. The caller has already refused a
 * missing or ambiguous match, so walking every occurrence is what an all
 * replacement changes, and the line delta keeps the new side honest.
 */
export const editDiffs = (
  path: string,
  source: string,
  oldString: string,
  newString: string,
): ReadonlyArray<FileDiff> => {
  const removed = linesOf(oldString)
  const added = linesOf(newString)
  const diffs: Array<FileDiff> = []
  let delta = 0
  let index = source.indexOf(oldString)
  while (index >= 0) {
    const oldStart = lineAt(source, index)
    diffs.push({ path, oldStart, newStart: oldStart + delta, removed, added })
    delta += added.length - removed.length
    index = source.indexOf(oldString, index + oldString.length)
  }
  return diffs
}

/**
 * The lines an overwrite changed, with the unchanged head and tail left out.
 * A file that was not there before is all added lines, so the pane can tell a
 * create from an overwrite that only moved the file's tail.
 */
export const writeDiffs = (
  path: string,
  before: string | undefined,
  after: string,
): ReadonlyArray<FileDiff> => {
  const newLines = linesOf(after)
  if (before === undefined) {
    return [{ path, oldStart: 1, newStart: 1, removed: [], added: newLines }]
  }
  const oldLines = linesOf(before)
  let prefix = 0
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1
  }
  const removed = oldLines.slice(prefix, oldLines.length - suffix)
  const added = newLines.slice(prefix, newLines.length - suffix)
  if (removed.length === 0 && added.length === 0) return []
  return [{ path, oldStart: prefix + 1, newStart: prefix + 1, removed, added }]
}
