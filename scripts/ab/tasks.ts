/**
 * The coding tasks both harnesses are asked to do. Each one starts from a
 * fresh workspace, and whether it is done is judged from the files afterwards —
 * never from what the model said about itself.
 */

import { readFile } from 'node:fs/promises'
import { findDisagreement } from './find-task.ts'
import { longPrompt } from './prompt-task.ts'
import { readReport } from './read-task.ts'
import { recoverAmbiguousEdit } from './recover-task.ts'
import { fixRules } from './rules-task.ts'

/**
 * Where a harness difference would show for a task, and what a tie then means. Both halves
 * are required: a task whose counters tie tells the reader nothing unless the task says so
 * in advance, and a difference is only readable against the counters metrics.ts keeps.
 */
export interface AbRegime {
  /** Where the two harnesses would part, named on this task's own counters. */
  readonly difference: string
  /** What an equal result means: what this task then fails to tell apart. */
  readonly flat: string
}

export interface AbTask {
  readonly name: string
  /** What the task asks for, verbatim, to both harnesses. */
  readonly prompt: string
  /** Files the workspace starts with, keyed by a path relative to it. */
  readonly files: Readonly<Record<string, string>>
  /** How long one run may take; the run script's default when absent. */
  readonly timeoutMs?: number
  readonly regime: AbRegime
  /** Whether the work landed, read from the workspace. */
  readonly done: (workspace: string) => Promise<boolean>
}

const textOf = async (path: string): Promise<string> => readFile(path, 'utf8').catch(() => '')

export const TASKS: ReadonlyArray<AbTask> = [
  {
    name: 'fix-add',
    prompt:
      'src/math.ts has a bug: add subtracts instead of adding. Fix src/math.ts so add returns the sum of its two arguments. Change nothing else.',
    files: {
      'src/math.ts':
        'export const add = (a: number, b: number): number => a - b\n' +
        'export const multiply = (a: number, b: number): number => a * b\n',
    },
    regime: {
      difference:
        'failedEdits or reReads above zero, or a toolCalls count above the single read and edit a correct fix needs, means one harness spent an attempt on a fix with one right line; equal counters mean both land it the same way.',
      flat: 'A tie says only that both harnesses fix a one-line arithmetic bug the same way, which is the floor both already clear; no quality difference can be read from this task alone.',
    },
    done: async (workspace) => {
      const text = await textOf(workspace + '/src/math.ts')
      return text.includes('a + b') && text.includes('a * b') && !text.includes('a - b')
    },
  },
  {
    name: 'write-notes',
    prompt:
      'Create a file notes.md in the working directory. It must contain a level-1 heading with the text Notes, then a line that reads exactly: status: ready',
    files: {},
    regime: {
      difference:
        'turns or toolCalls above the one write the task needs, or failedEdits from attempting the note before reading what is already there, means a harness made extra steps of a one-file task; equal counters mean both write it in one call.',
      flat: 'A tie means both can create a short file from scratch, so the task separates neither harness and should not be read as evidence either way.',
    },
    done: async (workspace) => {
      const text = await textOf(workspace + '/notes.md')
      return text.includes('# Notes') && text.includes('status: ready')
    },
  },
  {
    name: 'rename-function',
    prompt:
      'Rename the exported function fetchValue to readValue everywhere under src/, updating every place that imports or calls it. Leave no mention of fetchValue behind.',
    files: {
      'src/util.ts': 'export const fetchValue = (): number => 1\n',
      'src/use.ts':
        "import { fetchValue } from './util'\n\nexport const use = (): number => fetchValue()\n",
    },
    regime: {
      difference:
        'reReads or failedEdits above zero, or toolCalls above the four reads and edits the rename needs across two files, means a harness re-read or retried a rename it did not carry through in one pass; equal counters mean both rename both files the same way.',
      flat: 'A tie means both track an identifier across a two-file rename, so the task says nothing about how each harness would hold a rename across a larger tree.',
    },
    done: async (workspace) => {
      const util = await textOf(workspace + '/src/util.ts')
      const use = await textOf(workspace + '/src/use.ts')
      return (
        util.includes('readValue') &&
        use.includes('readValue') &&
        !util.includes('fetchValue') &&
        !use.includes('fetchValue')
      )
    },
  },
  fixRules,
  readReport,
  longPrompt,
  findDisagreement,
  recoverAmbiguousEdit,
]
