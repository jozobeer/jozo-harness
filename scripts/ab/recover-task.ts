/**
 * The recovery A/B task: last is broken, and the line that has to change is byte for byte the
 * line the correct helper also has — so an edit carrying only that line as its old string is
 * refused as ambiguous by both harnesses, and the run has to read the file again and say which
 * function it means. Nothing here asks the model to do anything unusual: only what it does
 * with a refused edit differs.
 *
 * Whether it is done is judged from the file on disk, never from what the model said about
 * itself, and the failed attempt is read from the session log by metrics.ts rather than
 * demanded by the judge: a run that never made the ambiguous attempt can still finish.
 */

import { readFile } from 'node:fs/promises'
import type { AbTask } from './tasks.ts'

export const LIST_PATH = 'src/list.ts'

const FIRST = 'export const first'
const LAST = 'export const last'

/** The two helpers the judge reads; each one is independently right or wrong. */
export const HELPERS = ['first', 'last'] as const
export type Helper = (typeof HELPERS)[number]

/** Whether a body hands back the list's first element. */
const returnsFirstElement = (body: string): boolean =>
  /values\s*\[\s*0\s*\]/.test(body) || /values\.at\(\s*0\s*\)/.test(body)

/**
 * Whether a body hands back the list's last element. The two idioms a model reaches for are
 * the ones accepted: anything else — a reversed copy, an index built elsewhere — reads as not
 * done, which keeps the judge from passing a body that does not name the last element at all.
 */
const returnsLastElement = (body: string): boolean =>
  /values\s*\[\s*values\.length\s*-\s*1\s*\]/.test(body) || /values\.at\(\s*-\s*1\s*\)/.test(body)

/** The body of one helper, up to the start of the next one; empty when it is gone. */
const bodyOf = (text: string, helper: Helper): string => {
  const marker = 'export const ' + helper
  const start = text.indexOf(marker)
  if (start === -1) return ''
  const ends = HELPERS.map((name) =>
    text.indexOf('export const ' + name, start + marker.length),
  ).filter((at) => at !== -1)
  return text.slice(start, ends.length === 0 ? text.length : Math.min(...ends))
}

/** What the workspace still gets wrong: the judgement, not a guess at what the run did. */
export const wrongListHelpers = async (workspace: string): Promise<ReadonlyArray<Helper>> => {
  const text = await readFile(workspace + '/' + LIST_PATH, 'utf8').catch(() => '')
  const wrong: Array<Helper> = []
  if (!returnsFirstElement(bodyOf(text, 'first'))) wrong.push('first')
  if (!returnsLastElement(bodyOf(text, 'last'))) wrong.push('last')
  return wrong
}

/** The file both harnesses start from: last's body is a copy of first's, which is the bug. */
export const ambiguousList = (): string =>
  '/** The first element, or 0 when the list is empty. */\n' +
  FIRST +
  ' = (values: ReadonlyArray<number>): number => {\n' +
  '  if (values.length === 0) return 0\n' +
  '  return values[0]!\n' +
  '}\n' +
  '\n' +
  '/** The last element, or 0 when the list is empty. */\n' +
  LAST +
  ' = (values: ReadonlyArray<number>): number => {\n' +
  '  if (values.length === 0) return 0\n' +
  '  return values[0]!\n' +
  '}\n'

export const recoverAmbiguousEdit: AbTask = {
  name: 'recover-ambiguous-edit',
  prompt:
    'src/list.ts has a bug: last returns the first element instead of the last one. Fix src/list.ts ' +
    "so last returns the list's final element, and 0 when the list is empty. Do not change first: " +
    'it already returns the first element and must keep doing so.',
  files: { [LIST_PATH]: ambiguousList() },
  regime: {
    difference:
      'failedEdits of at least one followed by a reReads count that repeats the same file shows the ' +
      'refused edit and the recovery, and failedEdits without that repeat shows the ambiguous edit ' +
      'was applied to the wrong match instead of being read again.',
    flat: 'A tie in failedEdits and reReads with an empty wrongListHelpers means both harnesses refused the ambiguous edit and both recovered, so a flat result here says nothing about which harness is better.',
  },
  done: async (workspace) => (await wrongListHelpers(workspace)).length === 0,
}
