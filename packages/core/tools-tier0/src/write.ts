import { dirname } from 'node:path'
import { noneSandbox, type ApprovalShape, type SandboxShape } from '@jozo-harness/safety'
import { Schema, Effect } from 'effect'
import { FileSystem, withFileSystem, type FileSystemShape } from '@jozo-harness/filesystem'
import { ToolError, type ToolDefinition } from '@jozo-harness/tools'
import { deniedFor, escalates, escalationFields, modeOfCall } from './escalation.ts'
import { guardWrite, look, type ObservedFiles } from './observed-files.ts'
import { resolveInside } from './workspace.ts'
import { normalizeNewlines, readForEdit } from './text.ts'
import { writeDiffs } from './diff.ts'

const Parameters = Schema.Struct({
  path: Schema.String.annotate({
    description: 'The file to write, absolute or relative to the working directory.',
  }),
  content: Schema.String.annotate({ description: 'The complete new contents of the file.' }),
  ...escalationFields('a file operation', 'operation'),
})

export type WriteArgs = Schema.Schema.Type<typeof Parameters>

export interface WriteValue {
  readonly path: string
  readonly bytes: number
}

/**
 * Writes one UTF-8 text file, creating parent directories. A file that is already
 * there is written only when this session read it and nobody changed it since; a
 * refusal happens before anything on disk is touched.
 */
export const makeWriteTool = (
  fileSystem: FileSystemShape,
  observed: ObservedFiles,
  sandbox: SandboxShape = noneSandbox,
  approval?: ApprovalShape,
): ToolDefinition<WriteArgs, WriteValue> => {
  const canEscalate = escalates(sandbox, approval)
  return {
    name: 'write',
    presentCall: (args) => ({ summary: 'write ' + args.path }),
    description:
      'Writes a UTF-8 text file inside the workspace, creating parent directories. Read a file before you overwrite it: write replaces the whole file. If it refuses because the file changed on disk, read it again and write what you now see.' +
      (sandbox.confines
        ? ' A path the sandbox refuses is reported as `[sandbox: file access denied under <mode> mode]`.'
        : ''),
    parameters: Parameters,
    output: {
      schema: Schema.Struct({ path: Schema.String, bytes: Schema.Int }),
      render: (_args, value) => [
        { type: 'text', text: 'wrote ' + value.path + ' (' + String(value.bytes) + ' bytes)' },
      ],
    },
    execute: (args, context) =>
      withFileSystem(
        fileSystem,
        Effect.gen(function* () {
          const mode = yield* modeOfCall({
            args: args,
            callId: context.callId,
            tool: 'write',
            subject: 'operation',
            sandbox,
            approval,
          })
          const path = yield* resolveInside(fileSystem, context.cwd, args.path, mode).pipe(
            Effect.mapError((error) => deniedFor(error.message, mode, 'operation', canEscalate)),
          )
          yield* guardWrite(observed, context.sessionId, path)
          // Read the old text only for the diff: a file that cannot be read as
          // text (binary, gone) still gets written, just without a diff.
          const before = yield* readForEdit(path).pipe(
            Effect.map((read) => read.text),
            Effect.orElseSucceed(() => undefined),
          )
          const content = normalizeNewlines(args.content)
          const disk = yield* FileSystem
          yield* disk
            .mkdirp(dirname(path))
            .pipe(
              Effect.mapError(
                () => new ToolError({ code: 'execution', message: 'cannot write ' + path }),
              ),
            )
          const staged = yield* disk
            .stage(path, content)
            .pipe(
              Effect.mapError(
                () => new ToolError({ code: 'execution', message: 'cannot write ' + path }),
              ),
            )
          // The bytes are already staged, but nothing has replaced the file yet:
          // re-check after staging so a change during the diff read still refuses.
          yield* guardWrite(observed, context.sessionId, path).pipe(
            Effect.onError(() => staged.discard),
          )
          yield* staged.commit.pipe(
            Effect.mapError(
              () => new ToolError({ code: 'execution', message: 'cannot write ' + path }),
            ),
          )
          const written = yield* look(path)
          if (written !== undefined) observed.observe(context.sessionId, path, written)
          for (const diff of writeDiffs(path, before, content)) context.changes?.record(diff)
          return { path, bytes: new TextEncoder().encode(content).length }
        }),
      ),
  }
}
