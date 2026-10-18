/**
 * The read-heavy A/B task: sixteen files of about 24 KB each, every one ending in a line
 * that names it. Whether it is done is judged by the report on disk, never by what the
 * model said about itself.
 *
 * It does not fill a window on its own: in the 2026-10-15 run at the shipped 62,464-token
 * line, the model read the first eight files whole and took the rest with an offset, so
 * requests peaked at 53,253 tokens and no compaction fired. Pair it with long-prompt when
 * the line has to be crossed.
 */

import { readFile } from 'node:fs/promises'
import type { AbTask } from './tasks.ts'

const FILE_COUNT = 16
const LINES_PER_FILE = 340

const nameOf = (index: number): string => 'f' + String(index + 1).padStart(2, '0')

/** The line the report has to repeat for one file. */
const markerOf = (index: number): string => nameOf(index) + ' last line'

const fileOf = (index: number): string =>
  Array.from(
    { length: LINES_PER_FILE },
    (_, line) => nameOf(index) + ' line ' + String(line + 1) + ': ' + 'x'.repeat(60),
  ).join('\n') +
  '\n' +
  markerOf(index) +
  '\n'

const files = (): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Array.from({ length: FILE_COUNT }, (_, index) => [
      'data/' + nameOf(index) + '.txt',
      fileOf(index),
    ]),
  )

export const readReport: AbTask = {
  name: 'read-report',
  prompt:
    'Every file in data/ ends with one line that says "<name> last line", where <name> is ' +
    'the file name without its extension. Read every file in data/ and write report.md with ' +
    'one line per file, in file order, each line being exactly that ending line. Read the ' +
    'files; do not guess their contents.',
  files: files(),
  regime: {
    difference:
      'toolCalls and turns separate a harness that reads all sixteen files from one that skips ' +
      'some, reReads above zero means it went back over a file it had already read, and ' +
      'compactions above zero means the run crossed the line the pair was built to stay under.',
    flat: 'A tie means both read the same volume and neither compacted, so this task alone cannot separate them; only the pair with long-prompt then shows what a crossing costs.',
  },
  timeoutMs: 1_200_000,
  done: async (workspace) => {
    const report = await readFile(workspace + '/report.md', 'utf8').catch(() => '')
    return Array.from({ length: FILE_COUNT }, (_, index) => markerOf(index)).every((marker) =>
      report.includes(marker),
    )
  },
}
