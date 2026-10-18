/**
 * The long A/B task: forty-eight rule files, twelve of which do not do what
 * their header says. Finding them takes a read of every rule; a model that reads
 * only the rule at the top of each file still carries the session to about
 * 25,000 tokens, past the 16,000 line the A/B compacts at. Whether it is done is
 * judged by running the workspace's rules on inputs this module draws and
 * comparing them with its own reference, never with anything in the workspace.
 */

import { spawnSync } from 'node:child_process'
import type { AbTask } from './tasks.ts'

interface RuleKind {
  /** What the header promises, for one parameter. */
  readonly says: (k: number) => string
  readonly correct: (k: number) => string
  /** The same function with one fault the header contradicts. */
  readonly faulty: (k: number) => string
  readonly reference: (values: ReadonlyArray<number>, k: number) => number
}

const loop = (head: string, body: string, tail: string): string =>
  ['  ' + head, '  for (let i = 0; i < values.length; i += 1) {', body, '  }', '  ' + tail].join(
    '\n',
  )

const KINDS: ReadonlyArray<RuleKind> = [
  {
    says: (k) => `the sum of every value strictly greater than ${k}`,
    correct: (k) =>
      loop('let sum = 0', `    if (values[i]! > ${k}) sum += values[i]!`, 'return sum'),
    faulty: (k) =>
      loop('let sum = 0', `    if (values[i]! >= ${k}) sum += values[i]!`, 'return sum'),
    reference: (values, k) => values.filter((value) => value > k).reduce((a, b) => a + b, 0),
  },
  {
    says: (k) => `how many values are strictly less than ${k}`,
    correct: (k) => loop('let count = 0', `    if (values[i]! < ${k}) count += 1`, 'return count'),
    faulty: (k) => loop('let count = 0', `    if (values[i]! <= ${k}) count += 1`, 'return count'),
    reference: (values, k) => values.filter((value) => value < k).length,
  },
  {
    says: (k) => `the sum of every value that is a multiple of ${k}, the first value included`,
    correct: (k) =>
      loop('let sum = 0', `    if (values[i]! % ${k} === 0) sum += values[i]!`, 'return sum'),
    faulty: (k) =>
      loop(
        'let sum = 0',
        `    if (i > 0 && values[i]! % ${k} === 0) sum += values[i]!`,
        'return sum',
      ),
    reference: (values, k) => values.filter((value) => value % k === 0).reduce((a, b) => a + b, 0),
  },
  {
    says: (k) => `the largest value, or ${k} when there are no values; values may all be negative`,
    correct: (k) =>
      loop(
        `if (values.length === 0) return ${k}\n  let largest = -Infinity`,
        '    if (values[i]! > largest) largest = values[i]!',
        'return largest',
      ),
    faulty: (k) =>
      loop(
        `if (values.length === 0) return ${k}\n  let largest = 0`,
        '    if (values[i]! > largest) largest = values[i]!',
        'return largest',
      ),
    reference: (values, k) => (values.length === 0 ? k : Math.max(...values)),
  },
  {
    says: (k) => `the product of the first ${k} values (all of them when there are fewer)`,
    correct: (k) =>
      loop('let product = 1', `    if (i < ${k}) product *= values[i]!`, 'return product'),
    faulty: (k) =>
      loop('let product = 1', `    if (i <= ${k}) product *= values[i]!`, 'return product'),
    reference: (values, k) => values.slice(0, k).reduce((a, b) => a * b, 1),
  },
  {
    says: (k) => `how many values are exactly ${k} or exactly ${-k}`,
    correct: (k) =>
      loop(
        'let count = 0',
        `    if (values[i] === ${k} || values[i] === ${-k}) count += 1`,
        'return count',
      ),
    faulty: (k) => loop('let count = 0', `    if (values[i] === ${k}) count += 1`, 'return count'),
    reference: (values, k) => values.filter((value) => value === k || value === -k).length,
  },
  {
    says: (k) => `the sum of the squares of every value strictly less than ${k}`,
    correct: (k) =>
      loop(
        'let sum = 0',
        `    if (values[i]! < ${k}) sum += values[i]! * values[i]!`,
        'return sum',
      ),
    faulty: (k) =>
      loop('let sum = 0', `    if (values[i]! < ${k}) sum += values[i]! * 2`, 'return sum'),
    reference: (values, k) =>
      values.filter((value) => value < k).reduce((sum, value) => sum + value * value, 0),
  },
  {
    says: (k) => `the index of the last value strictly greater than ${k}, or -1 when there is none`,
    correct: (k) => loop('let found = -1', `    if (values[i]! > ${k}) found = i`, 'return found'),
    faulty: (k) =>
      loop(
        'let found = -1',
        `    if (values[i]! > ${k} && found === -1) found = i`,
        'return found',
      ),
    reference: (values, k) => values.findLastIndex((value) => value > k),
  },
]

/** Helpers every file carries and no rule calls: the reading a real module asks for. */
const helpers = (id: string, k: number): string =>
  [
    `/** Keeps a value inside [low, high]; a low above high is swapped first. */`,
    `export const clamp${id} = (value: number, low: number, high: number): number => {`,
    `  const [min, max] = low <= high ? [low, high] : [high, low]`,
    `  return Math.min(max, Math.max(min, value))`,
    `}`,
    ``,
    `/** The arithmetic mean, or 0 for no values, so a caller never divides by zero. */`,
    `export const mean${id} = (values: ReadonlyArray<number>): number =>`,
    `  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length`,
    ``,
    `/** Splits values into runs of ${k}; the last run may be shorter. */`,
    `export const chunk${id} = (values: ReadonlyArray<number>): ReadonlyArray<ReadonlyArray<number>> => {`,
    `  const runs: Array<ReadonlyArray<number>> = []`,
    `  for (let start = 0; start < values.length; start += ${k}) runs.push(values.slice(start, start + ${k}))`,
    `  return runs`,
    `}`,
    ``,
    `/** Values in first-seen order with repeats dropped. */`,
    `export const unique${id} = (values: ReadonlyArray<number>): ReadonlyArray<number> => [...new Set(values)]`,
    ``,
    `/** Neighbouring pairs: [a, b, c] gives [[a, b], [b, c]]. */`,
    `export const pairs${id} = (values: ReadonlyArray<number>): ReadonlyArray<readonly [number, number]> =>`,
    `  values.slice(1).map((value, index) => [values[index]!, value] as const)`,
    ``,
    `/** The middle value of the sorted values, or the mean of the two middle ones. */`,
    `export const median${id} = (values: ReadonlyArray<number>): number => {`,
    `  if (values.length === 0) return 0`,
    `  const sorted = [...values].sort((left, right) => left - right)`,
    `  const middle = Math.floor(sorted.length / 2)`,
    `  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2`,
    `}`,
    ``,
    `/** How far each value moved from the one before it; the first value has no step. */`,
    `export const steps${id} = (values: ReadonlyArray<number>): ReadonlyArray<number> =>`,
    `  pairs${id}(values).map(([before, after]) => after - before)`,
    ``,
    `/** A label for logs: the values joined with commas, cut to ${k * 8} characters. */`,
    `export const label${id} = (values: ReadonlyArray<number>): string => {`,
    `  const text = values.join(', ')`,
    `  return text.length <= ${k * 8} ? text : text.slice(0, ${k * 8 - 3}) + '...'`,
    `}`,
    ``,
    `/** Every value scaled by ${k}, rounded toward zero so integers stay integers. */`,
    `export const scale${id} = (values: ReadonlyArray<number>): ReadonlyArray<number> =>`,
    `  values.map((value) => Math.trunc(value * ${k}))`,
    ``,
    `/** Whether the values never go down from one to the next. */`,
    `export const rising${id} = (values: ReadonlyArray<number>): boolean =>`,
    `  steps${id}(values).every((step) => step >= 0)`,
  ].join('\n')

const RULE_COUNT = 48

interface Rule {
  readonly id: string
  readonly kind: RuleKind
  readonly k: number
  readonly faulty: boolean
}

const RULES: ReadonlyArray<Rule> = Array.from({ length: RULE_COUNT }, (_, index) => {
  const kind = index % KINDS.length
  const row = Math.floor(index / KINDS.length)
  return {
    id: String(index + 1).padStart(2, '0'),
    kind: KINDS[kind]!,
    k: 2 + ((index * 3) % 7),
    // Two kinds per row of eight, shifting each row, so every kind is faulty somewhere.
    faulty: (kind + row) % 4 === 1,
  }
})

/** One rule's file, with its fault in place or fixed. */
const ruleFile = (rule: Rule, faulty: boolean): string =>
  [
    `/**`,
    ` * Rule ${rule.id}.`,
    ` *`,
    ` * rule${rule.id}(values) returns ${rule.kind.says(rule.k)}.`,
    ` * The helpers below belong to the same module and are not used by the rule.`,
    ` */`,
    `export const rule${rule.id} = (values: ReadonlyArray<number>): number => {`,
    faulty ? rule.kind.faulty(rule.k) : rule.kind.correct(rule.k),
    `}`,
    ``,
    helpers(rule.id, rule.k),
    ``,
  ].join('\n')

const pathOf = (rule: Rule): string => `src/rules/r${rule.id}.ts`

/** A small fixed-seed generator: the inputs vary, and a rerun sees the same ones. */
const inputsOf = (seed: number): ReadonlyArray<ReadonlyArray<number>> => {
  let state = seed
  const next = (bound: number): number => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state % bound
  }
  const drawn = Array.from({ length: 60 }, () =>
    Array.from({ length: next(12) }, () => next(19) - 9),
  )
  return [[], [-3, -7, -1], ...drawn]
}

/**
 * Runs every rule the workspace holds on the same inputs and returns what each
 * gave, by rule id. A rule that throws or is missing gives null.
 */
const answersOf = (
  workspace: string,
  inputs: ReadonlyArray<ReadonlyArray<number>>,
): Record<string, ReadonlyArray<number | null>> => {
  const script = [
    `const inputs = JSON.parse(process.argv[1])`,
    `const ids = JSON.parse(process.argv[2])`,
    `const answers = {}`,
    `for (const id of ids) {`,
    `  try {`,
    `    const rule = (await import(process.cwd() + '/src/rules/r' + id + '.ts'))['rule' + id]`,
    `    answers[id] = inputs.map((values) => { try { return rule(values) } catch { return null } })`,
    `  } catch { answers[id] = inputs.map(() => null) }`,
    `}`,
    `console.log(JSON.stringify(answers))`,
  ].join('\n')
  const run = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      script,
      JSON.stringify(inputs),
      JSON.stringify(RULES.map((rule) => rule.id)),
    ],
    { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 },
  )
  try {
    return JSON.parse(run.stdout?.toString() ?? '') as Record<string, ReadonlyArray<number | null>>
  } catch {
    return {}
  }
}

/** The ids of the rules whose answers differ from the reference on the drawn inputs. */
export const wrongRules = (workspace: string): ReadonlyArray<string> => {
  const inputs = inputsOf(RULE_COUNT)
  const answers = answersOf(workspace, inputs)
  return RULES.flatMap((rule) => {
    const given = answers[rule.id]
    const right = inputs.every(
      (values, index) => given?.[index] === rule.kind.reference(values, rule.k),
    )
    return right ? [] : [rule.id]
  })
}

/** The rules the workspace starts with wrong, by id. */
export const FAULTY_RULES = RULES.filter((rule) => rule.faulty).map((rule) => rule.id)

/** Every rule file as the workspace starts with it, or with chosen rules fixed. */
export const ruleFiles = (fixed: ReadonlySet<string> = new Set()): Record<string, string> =>
  Object.fromEntries(
    RULES.map((rule) => [pathOf(rule), ruleFile(rule, rule.faulty && !fixed.has(rule.id))]),
  )

export const fixRules: AbTask = {
  name: 'fix-rules',
  prompt: `Every file in src/rules/ exports one rule function (rule01 to rule${RULE_COUNT}) whose header comment says exactly what it returns. Some rule functions do not do what their comment says. Find every rule function that disagrees with its comment and fix it so it does what the comment says. Do not change the helper functions or the rules that are already right.`,
  regime: {
    difference:
      'reReads or failedEdits above zero means a harness went back over a rule it had already ' +
      'seen or retried an edit, and a toolCalls count below the reads the twelve hidden faults ' +
      'force means it answered without covering every file.',
    flat: 'A tie means both read enough of the forty-eight files to find the twelve faults, so the task cannot separate how each harness decided which files to open.',
  },
  files: ruleFiles(),
  timeoutMs: 1_200_000,
  done: async (workspace) => wrongRules(workspace).length === 0,
}
