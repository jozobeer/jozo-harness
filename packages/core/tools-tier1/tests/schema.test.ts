import { describe, expect, test } from 'vitest'
import type { AgentsShape } from '@jozo-harness/agent'
import { makeAsk, makePlanMode } from '@jozo-harness/safety'
import { toolDeclaration, toolSchemaIssues, type ToolDefinition } from '@jozo-harness/tools'
import { Effect } from 'effect'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  agentTools,
  jobTools,
  makeExitPlanModeTool,
  makeGoalTool,
  makeJobs,
  makePluginTool,
  makeScheduleTool,
  makeStructuredOutputs,
  makeStructuredOutputTool,
  makeSubagentTool,
  makeTeamTool,
  makeWebSearchTool,
  makeWorkflowTool,
  makeWorkingDirectoryTool,
  tier1Tools,
} from '../src/index.ts'

/** The registry a schema check never calls: only the declarations matter. */
const agents: AgentsShape = {
  create: () => Effect.die('not used by a schema check'),
  get: () => undefined,
  list: () => [],
  childrenOf: () => [],
  depthOf: () => 0,
  dispose: () => Effect.void,
  disposeAll: () => Effect.void,
}

describe('tier 1 tool schemas', () => {
  test('every tool says what it is for and what each parameter means', async () => {
    const ask = await Effect.runPromise(makeAsk())
    const jobs = await Effect.runPromise(makeJobs())
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-schema-'))
    // Every tool a profile can hand the model, with the hosts a declaration never calls.
    const tools: ReadonlyArray<ToolDefinition<any, any>> = [
      ...tier1Tools(ask, [root]),
      makeWebSearchTool({ search: () => Effect.succeed([]) }),
      ...jobTools(jobs),
      makeWorkingDirectoryTool({ root: () => root, change: () => Effect.void }),
      makeSubagentTool({ agents, route: 'stub/model' }),
      makeStructuredOutputTool(makeStructuredOutputs()),
      ...agentTools(agents),
      makeScheduleTool({
        events: () => [],
        write: () => Effect.void,
        nextId: () => 'sched-1',
        now: () => 0,
      }),
      makeGoalTool({ events: () => [], append: () => Effect.void }),
      makeTeamTool({
        agents,
        route: 'stub/model',
        log: {
          events: () => [],
          spawnMember: () => Effect.void,
          createTask: () => Effect.void,
          updateTask: () => Effect.void,
          nextId: () => 'task-1',
        },
      }),
      makeWorkflowTool({ agents, route: 'stub/model' }),
      makePluginTool({
        rows: () => [],
        known: () => [],
        change: () => Effect.succeed([]),
        ask,
      }),
      makeExitPlanModeTool(makePlanMode(), ask),
    ]

    const issues = tools.flatMap((tool) => toolSchemaIssues(toolDeclaration(tool)))

    expect(issues).toEqual([])
    await rm(root, { recursive: true, force: true })
  })
})
