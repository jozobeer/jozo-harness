import { writeFile } from 'node:fs/promises'
import { noneSandbox, type ApprovalShape, type SandboxShape } from '@jozo-harness/safety'
import { Schema, Effect } from 'effect'
import { ToolError, type ToolDefinition } from '@jozo-harness/tools'
import { deniedFor, escalates, escalationFields, modeOfCall } from './escalation.ts'
import { guardEdit, look, type ObservedFiles } from './observed-files.ts'
import { readForEdit, restoreLineEndings } from './text.ts'
import { changedLines } from './present.ts'
import { resolveInside } from './workspace.ts'
import { editDiffs } from './diff.ts'

const Parameters = Schema.Struct({
  path: Schema.String.annotate({
    description: 'The file to change, absolute or relative to the working directory.',
  }),
  oldString: Schema.String.annotate({
    description:
      'The exact text to replace. It must not be empty, and it must appear exactly once unless all is true.',
  }),
  newString: Schema.String.annotate({ description: 'The text to put in its place.' }),
  all: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        'Replace every occurrence instead of refusing an ambiguous match. Defaults to false.',
    }),
  ),
  ...escalationFields('a file operation', 'operation'),
})

export type EditArgs = Schema.Schema.Type<typeof Parameters>

export interface EditValue {
  readonly path: string
  readonly replacements: number
}

const countOf = (text: string, needle: string): number => {
  let count = 0
  let index = text.indexOf(needle)
  while (index >= 0) {
    count += 1
    index = text.indexOf(needle, index + needle.length)
  }
  return count
}

/**
 * An empty needle matches at every index and never advances, so the search
 * would not return. Refuse it before any file is read.
 */
const refuseEmptyOldString = (oldString: string): Effect.Effect<void, ToolError> => {
  if (oldString === '') {
    return Effect.fail(
      new ToolError({ code: 'invalid-arguments', message: 'old text must not be empty' }),
    )
  }
  return Effect.void
}

/**
 * Replaces text in one file. The file must have been read in this session and be
 * unchanged since, so an edit never runs over somebody else's work; without
 * `all`, the old text must be unique. Every refusal happens before the file is
 * written, so a failed edit leaves it exactly as it was.
 */
export const makeEditTool = (
  observed: ObservedFiles,
  sandbox: SandboxShape = noneSandbox,
  approval?: ApprovalShape,
): ToolDefinition<EditArgs, EditValue> => {
  const canEscalate = escalates(sandbox, approval)
  return {
    name: 'edit',
    presentCall: (args) => ({ summary: 'edit ' + args.path + ' ' + changedLines(args) }),
    description:
      'Replaces text in one workspace file and leaves the rest of it alone. Use it for a targeted change; use write to replace a whole file. If it reports no match or more than one, read the file again and quote the exact text. A file this session has not read is refused: read it first.' +
      (sandbox.confines
        ? ' A path the sandbox refuses is reported as `[sandbox: file access denied under <mode> mode]`.'
        : ''),
    parameters: Parameters,
    output: {
      schema: Schema.Struct({ path: Schema.String, replacements: Schema.Int }),
      render: (_args, value) => [
        {
          type: 'text',
          text: 'edited ' + value.path + ' (' + String(value.replacements) + ' replacements)',
        },
      ],
    },
    execute: (args, context) =>
      Effect.gen(function* () {
        yield* refuseEmptyOldString(args.oldString)
        const mode = yield* modeOfCall({
          args: args,
          callId: context.callId,
          tool: 'edit',
          subject: 'operation',
          sandbox,
          approval,
        })
        const path = yield* resolveInside(context.cwd, args.path, mode).pipe(
          Effect.mapError((error) => deniedFor(error.message, mode, 'operation', canEscalate)),
        )
        yield* guardEdit(observed, context.sessionId, path)
        const source = yield* readForEdit(path)
        const found = countOf(source.text, args.oldString)
        if (found === 0) {
          return yield* Effect.fail(
            new ToolError({ code: 'execution', message: 'no match for the old text in ' + path }),
          )
        }
        const all = args.all === true
        if (found > 1 && !all) {
          return yield* Effect.fail(
            new ToolError({
              code: 'execution',
              message: String(found) + ' matches in ' + path + '; pass all to replace every one',
            }),
          )
        }
        // A function replacement is copied literally. A string replacement would
        // expand $$, $&, $', and $`, so a price or a shell snippet would rewrite the file.
        const updated = all
          ? source.text.split(args.oldString).join(args.newString)
          : source.text.replace(args.oldString, () => args.newString)
        yield* Effect.tryPromise({
          try: () => writeFile(path, restoreLineEndings(updated, source.lineEndings)),
          catch: () => new ToolError({ code: 'execution', message: 'cannot write ' + path }),
        })
        const written = yield* look(path)
        if (written !== undefined) observed.observe(context.sessionId, path, written)
        for (const diff of editDiffs(path, source.text, args.oldString, args.newString)) {
          context.changes?.record(diff)
        }
        return { path, replacements: all ? found : 1 }
      }),
  }
}
