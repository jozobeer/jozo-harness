import { Schema, Effect } from 'effect'
import { APPROVAL_ANSWER, type AskShape } from '@jozo-harness/safety'
import { ToolError, type ToolDefinition } from '@jozo-harness/tools'
import { askOrFail } from './ask.ts'

/** One row of the composition, as a human reads it. */
export interface PluginRowSummary {
  readonly id: string
  readonly name: string
  readonly disabled: boolean
}

/** The one change a call asks for. */
export type PluginChange =
  | { readonly kind: 'add'; readonly id: string; readonly name: string }
  | { readonly kind: 'remove'; readonly id: string }
  | {
      readonly kind: 'set-disabled'
      readonly id: string
      readonly name: string
      readonly disabled: boolean
    }

/** What one change left behind: the rows the settings hold, and what was wired now. */
export interface PluginChangeOutcome {
  readonly rows: ReadonlyArray<PluginRowSummary>
  /** Tools this change added to the running registry; empty when it waits for the next start. */
  readonly mounted: ReadonlyArray<string>
}

/**
 * The composition as the session knows it: the rows it was built from, the plugin
 * names this build has, and the one place a change can be written (the settings),
 * which is what the next start reads. A host that can build a row over the
 * running services wires its tools here instead of waiting for the next start.
 */
export interface PluginHost {
  readonly rows: () => ReadonlyArray<PluginRowSummary>
  readonly known: () => ReadonlyArray<string>
  readonly change: (change: PluginChange) => Effect.Effect<PluginChangeOutcome, ToolError>
  readonly ask: AskShape
}

const ACTIONS = ['list', 'add', 'remove', 'set'] as const

const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({
    description:
      'list shows the rows this run was built from; add, remove, and set change the settings for the next start. An added row for an opt-in plugin may also be wired into this run.',
  }),
  id: Schema.optionalKey(
    Schema.String.annotate({
      description: 'The row id to add, remove, or change, e.g. mcp. Copy it from list.',
    }),
  ),
  name: Schema.optionalKey(
    Schema.String.annotate({
      description: 'The plugin package to add, e.g. @jozo-harness/mcp. Required with add.',
    }),
  ),
  disabled: Schema.optionalKey(
    Schema.Boolean.annotate({ description: 'With set: whether the row is switched off.' }),
  ),
})

export type PluginArgs = Schema.Schema.Type<typeof Parameters>

/** What a plugin call leaves behind. */
export interface PluginValue {
  readonly action: string
  readonly changed: boolean
  readonly rows: ReadonlyArray<PluginRowSummary>
  /** What the human should know: whether the change landed, and when it takes effect. */
  readonly note: string
}

const OPTIONS: ReadonlyArray<string> = [APPROVAL_ANSWER, 'keep the rows as they are']

const refuse = (message: string) => new ToolError({ code: 'invalid-arguments', message })

const rowLine = (row: PluginRowSummary): string =>
  row.id + ' ' + row.name + (row.disabled ? ' (off)' : '')

const listText = (rows: ReadonlyArray<PluginRowSummary>): string =>
  rows.length === 0 ? '(no rows)' : rows.map((row) => rowLine(row)).join('\n')

/** The row a call names, or a refusal naming the ids there are. */
const rowOf = (
  rows: ReadonlyArray<PluginRowSummary>,
  id: string | undefined,
): PluginRowSummary | ToolError => {
  const found = rows.find((row) => row.id === id)
  if (found !== undefined) return found
  return refuse(
    'no row with that id: ' + String(id) + '; there is ' + rows.map((row) => row.id).join(', '),
  )
}

/** A row can only be added for a plugin this build already carries. */
const addChange = (args: PluginArgs, host: PluginHost): PluginChange | ToolError => {
  if (args.id === undefined || args.name === undefined) {
    return refuse('add needs an id and the plugin name')
  }
  if (!host.known().includes(args.name)) {
    return refuse('this build does not have ' + args.name + '; it has ' + host.known().join(', '))
  }
  return { kind: 'add', id: args.id, name: args.name }
}

const changeFor = (args: PluginArgs, host: PluginHost): PluginChange | ToolError => {
  if (args.action === 'add') return addChange(args, host)
  if (args.action === 'remove') return { kind: 'remove', id: String(args.id) }
  const row = rowOf(host.rows(), args.id)
  if (row instanceof ToolError) return row
  return { kind: 'set-disabled', id: row.id, name: row.name, disabled: args.disabled === true }
}

const questionFor = (change: PluginChange): string => {
  if (change.kind === 'add') {
    return 'Add the plugin row ' + change.id + ' (' + change.name + ') to the settings?'
  }
  if (change.kind === 'remove') return 'Remove the plugin row ' + change.id + ' from the settings?'
  return (
    'Switch the plugin row ' + change.id + (change.disabled ? ' off' : ' on') + ' in the settings?'
  )
}

const listed = (host: PluginHost): PluginValue => ({
  action: 'list',
  changed: false,
  rows: host.rows(),
  note: '(these are the rows this run was built from; a change lands on the next start unless it is wired now)',
})

const kept = (action: string, host: PluginHost): PluginValue => ({
  action,
  changed: false,
  rows: host.rows(),
  note: '(the user kept the plugin rows as they are)',
})

const changed = (action: string, outcome: PluginChangeOutcome): PluginValue => ({
  action,
  changed: true,
  rows: outcome.rows,
  note:
    outcome.mounted.length === 0
      ? '(the settings changed; every row is wired when jozo-harness starts again, and a session that ' +
        'then loses a tool needs --allow-preset-change to resume)'
      : '(the settings changed; ' +
        outcome.mounted.join(', ') +
        ' is wired into this run now, and every row is wired when jozo-harness starts again)',
})

/**
 * Lists the composition and changes the settings the next start reads. A host
 * that can build a row now also wires its tools, so a row added while the run
 * continues is not always a next-start change; every change is one the human
 * approved.
 */
export const makePluginTool = (host: PluginHost): ToolDefinition<PluginArgs, PluginValue> => ({
  name: 'plugin',
  description:
    'Lists the plugin rows this session runs with and changes them in the settings the next start reads: add a row for a plugin this build has, remove one, or switch one off. Every change is put to the user first. Adding a row for an opt-in plugin this build carries also wires its tools into this run when it can; the other changes take effect when jozo-harness starts again.',
  parameters: Parameters,
  output: {
    schema: Schema.Struct({
      action: Schema.String,
      changed: Schema.Boolean,
      rows: Schema.Array(
        Schema.Struct({ id: Schema.String, name: Schema.String, disabled: Schema.Boolean }),
      ),
      note: Schema.String,
    }),
    render: (_args, value) => [{ type: 'text', text: listText(value.rows) + '\n' + value.note }],
  },
  execute: (args, context) =>
    Effect.gen(function* () {
      if (args.action === 'list') return listed(host)
      const change = changeFor(args, host)
      if (change instanceof ToolError) return yield* Effect.fail(change)
      const answer = yield* askOrFail(host.ask, {
        id: context.callId,
        question: questionFor(change),
        options: OPTIONS,
      })
      if (answer.trim().toLowerCase() !== APPROVAL_ANSWER) return kept(args.action, host)
      return changed(args.action, yield* host.change(change))
    }),
})
