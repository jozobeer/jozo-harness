/**
 * The window-filling A/B task that cannot be answered without reading: forty files of
 * about 8.6 KB each list claims about crates, every crate counted twice in a file. The
 * two counts agree everywhere but in one file — a shell can list the crate ids, but the
 * ids repeat by design, so telling the two counts apart means reading the numbers. The
 * session therefore carries the files the way a person would, past the shipped
 * window's line (128,000 × 0.8 against 128,000 - 65,536, so 62,464 tokens).
 *
 * Whether it is done is judged from answer.md against what this module generated, never
 * from what the model said about itself.
 */

import { readFile } from 'node:fs/promises'
import type { AbTask } from './tasks.ts'

const FILE_COUNT = 40
const CRATES_PER_FILE = 100
const FAULTY_FILE = 36
const FAULTY_CRATE = 41
/** What the two counts of the faulty crate say. */
const FAULTY_GAP = 7

const crateOf = (file: number, crate: number): string =>
  'C-' + String(file).padStart(2, '0') + String(crate).padStart(3, '0')

const unitsOf = (file: number, crate: number): number => 100 + ((file * 37 + crate * 11) % 900)

/** The same count said two ways, so the pair reads as two claims rather than a repeat. */
const first = (crate: string, units: number, claim: number): string =>
  `claim ${String(claim).padStart(3, '0')}: crate ${crate} holds ${String(units)} units.`

const second = (crate: string, units: number, claim: number): string =>
  claim % 4 === 0
    ? `claim ${String(claim).padStart(3, '0')}: the inventory for ${crate} was ${String(units)} units.`
    : claim % 4 === 1
      ? `claim ${String(claim).padStart(3, '0')}: ${crate} was counted at ${String(units)} units.`
      : claim % 4 === 2
        ? `claim ${String(claim).padStart(3, '0')}: ${String(units)} units sit in crate ${crate}.`
        : `claim ${String(claim).padStart(3, '0')}: crate ${crate} came to ${String(units)} units.`

const fileOf = (file: number): string => {
  const lines = ['# Crate claims, batch ' + String(file).padStart(2, '0'), '']
  for (let crate = 1; crate <= CRATES_PER_FILE; crate += 1) {
    const id = crateOf(file, crate)
    const units = unitsOf(file, crate)
    const faulty = file === FAULTY_FILE && crate === FAULTY_CRATE
    lines.push(first(id, units, crate * 2 - 1))
    lines.push(second(id, faulty ? units + FAULTY_GAP : units, crate * 2))
  }
  return lines.join('\n') + '\n'
}

const files = (): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Array.from({ length: FILE_COUNT }, (_, index) => [
      'data/c' + String(index + 1).padStart(2, '0') + '.txt',
      fileOf(index + 1),
    ]),
  )

const faultyName = 'data/c' + String(FAULTY_FILE).padStart(2, '0') + '.txt'
const faultyCrate = crateOf(FAULTY_FILE, FAULTY_CRATE)
const faultyUnits = unitsOf(FAULTY_FILE, FAULTY_CRATE)

export const findDisagreement: AbTask = {
  name: 'find-disagreement',
  prompt:
    'Every file in data/ lists claims about numbered crates. Each crate is counted twice ' +
    'in its file, and the two counts agree in every file except one. Find the file whose ' +
    'two counts disagree and write answer.md with three lines: the file path, the crate id, ' +
    'and the two counts, lowest first. Read the claims; they repeat by design, so their ' +
    'numbers are the only way to tell.',
  files: files(),
  regime: {
    difference:
      'toolCalls and turns show how much of the forty files each harness read before answering, ' +
      'compactions above zero means it compacted while holding the claims, and failedEdits above ' +
      'zero means a retry while writing answer.md.',
    flat: 'A tie means both read the same volume and found the one faulty crate, which says the fault is findable either way and nothing about which harness reads better under a window.',
  },
  timeoutMs: 1_200_000,
  done: async (workspace) => {
    const answer = await readFile(workspace + '/answer.md', 'utf8').catch(() => '')
    return (
      answer.includes(faultyName) &&
      answer.includes(faultyCrate) &&
      answer.includes(String(faultyUnits)) &&
      answer.includes(String(faultyUnits + FAULTY_GAP))
    )
  },
}
