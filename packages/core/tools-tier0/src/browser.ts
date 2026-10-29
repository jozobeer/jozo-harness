import type { FileSystemShape } from '@jozo-harness/filesystem'
import type { ToolDefinition } from '@jozo-harness/tools'
import { makeEditTool } from './edit.ts'
import { makeGlobTool } from './glob.ts'
import { makeGrepTool } from './grep.ts'
import { makeObservedFiles, type ObservedFiles } from './observed-files.ts'
import { makeReadTool } from './read.ts'
import { makeWriteTool } from './write.ts'
import { ripgrepAt } from './ripgrep.ts'

/**
 * The Tier 0 tools a browser page can honour. bash and worktree are absent: the
 * page has no process to run and no git checkout to cut. glob and grep are told
 * that no ripgrep exists, so they search through the walker over the workspace
 * the caller supplied.
 */
export const browserTools = (
  fileSystem: FileSystemShape,
  observed: ObservedFiles = makeObservedFiles(),
): ReadonlyArray<ToolDefinition<any, any>> => [
  makeReadTool(fileSystem, observed),
  makeWriteTool(fileSystem, observed),
  makeEditTool(fileSystem, observed),
  makeGlobTool(fileSystem, ripgrepAt(undefined)),
  makeGrepTool(fileSystem, ripgrepAt(undefined)),
]
