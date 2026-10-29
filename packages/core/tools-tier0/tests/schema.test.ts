import { describe, expect, test } from 'vitest'
import { nodeFileSystem } from '@jozo-harness/filesystem/node'
import { noneSandbox } from '@jozo-harness/safety'
import { toolDeclaration, toolSchemaIssues } from '@jozo-harness/tools'
import { Effect } from 'effect'
import { makeWorktreeTool, tier0Tools } from '../src/index.ts'

describe('tier 0 tool schemas', () => {
  test('every tool says what it is for and what each parameter means', () => {
    const worktree = makeWorktreeTool(noneSandbox, undefined, {
      rootOf: () => '/work',
      change: () => Effect.void,
    })
    const issues = [...tier0Tools(nodeFileSystem, noneSandbox), worktree].flatMap((tool) =>
      toolSchemaIssues(toolDeclaration(tool)),
    )

    expect(issues).toEqual([])
  })
})
