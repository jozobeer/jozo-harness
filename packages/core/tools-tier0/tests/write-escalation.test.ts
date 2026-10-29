import { HooksLive } from '@jozo-harness/kernel'
import {
  makeApproval,
  type ApprovalRequested,
  type ApprovalShape,
  type SandboxMode,
  type SandboxShape,
} from '@jozo-harness/safety'
import {
  Tools,
  toolsLayer,
  type ToolDefinition,
  type ToolError,
  type ToolExecutionResult,
} from '@jozo-harness/tools'
import { Context, Effect, Layer } from 'effect'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { nodeFileSystem } from '@jozo-harness/filesystem/node'
import { tier0Tools } from '../src/index.ts'

/** A sandbox that confines writes to the mode's roots, like seatbelt does. */
const confining = (mode: SandboxMode): SandboxShape => ({
  name: 'test-confine',
  confines: true,
  mode,
  wrap: (command) =>
    Effect.succeed({ ...command, mode: command.mode ?? mode, denialSignatures: [] }),
})

const answering = async (approved: boolean): Promise<[ApprovalShape, Array<ApprovalRequested>]> => {
  const asked: Array<ApprovalRequested> = []
  const approval = await Effect.runPromise(makeApproval())
  await Effect.runPromise(
    approval.serve((request) =>
      Effect.sync(() => {
        asked.push(request)
        return approved
      }),
    ),
  )
  return [approval, asked]
}

const call = (
  tool: ToolDefinition<any, any>,
  args: unknown,
  cwd: string,
): Effect.Effect<ToolExecutionResult | undefined, ToolError, never> =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(Layer.provideMerge(toolsLayer, HooksLive))
      const tools = Context.get(context, Tools)
      yield* tools.register(tool)
      return yield* tools.call({
        callId: 'c1',
        tool: tool.name,
        arguments: JSON.stringify(args),
        context: { sessionId: 's1', cwd, callId: 'c1' },
      })
    }),
  )

const textOf = (result: ToolExecutionResult | undefined): string =>
  (result?.content ?? []).flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')

const toolNamed = (
  sandbox: SandboxShape,
  approval: ApprovalShape | undefined,
  name: string,
): ToolDefinition<any, any> => {
  const tool = tier0Tools(nodeFileSystem, sandbox, undefined, approval).find(
    (candidate) => candidate.name === name,
  )
  if (tool === undefined) throw new Error('no tool named ' + name)
  return tool
}

describe('the file tools on the escalation road', () => {
  let workspace = ''
  let outside = ''

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'jozo-harness-fence-'))
    outside = join(mkdtempSync(join(tmpdir(), 'jozo-harness-out-')), 'note.txt')
  })

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
    rmSync(outside, { force: true })
  })

  test('a write outside the workspace is denied with the marker and the retry it allows', async () => {
    const [approval] = await answering(true)
    const result = await Effect.runPromise(
      call(
        toolNamed(confining('workspace-write'), approval, 'write'),
        { path: outside, content: 'x' },
        workspace,
      ),
    )

    const text = textOf(result)
    expect(result?.isError).toBe(true)
    expect(text).toContain('path escapes the workspace')
    expect(text).toContain('[sandbox: file access denied under workspace-write mode]')
    expect(text).toContain('sandbox_permissions')
    expect(text).toContain('justification')
    expect(existsSync(outside)).toBe(false)
  })

  test('an approved escalation writes outside the workspace', async () => {
    const [approval, asked] = await answering(true)
    const result = await Effect.runPromise(
      call(
        toolNamed(confining('workspace-write'), approval, 'write'),
        {
          path: outside,
          content: 'escalated',
          sandbox_permissions: 'danger-full-access',
          justification: 'the note belongs beside the other repository',
        },
        workspace,
      ),
    )

    expect(result?.isError).toBe(false)
    expect(readFileSync(outside, 'utf8')).toBe('escalated')
    expect(asked).toHaveLength(1)
    expect(asked[0]?.tool).toBe('write')
    expect(asked[0]?.reason).toContain('the note belongs beside the other repository')
  })

  test('a refused escalation writes nothing and says so', async () => {
    const [approval, asked] = await answering(false)
    const result = await Effect.runPromise(
      call(
        toolNamed(confining('workspace-write'), approval, 'edit'),
        {
          path: outside,
          oldString: 'a',
          newString: 'b',
          sandbox_permissions: 'danger-full-access',
          justification: 'the note belongs beside the other repository',
        },
        workspace,
      ),
    )

    expect(result?.isError).toBe(true)
    expect(textOf(result)).toContain('rejected')
    expect(asked).toHaveLength(1)
  })

  test('read-only denies a write inside the workspace too, and offers the wider mode', async () => {
    const [approval] = await answering(true)
    const inside = join(workspace, 'note.txt')
    const result = await Effect.runPromise(
      call(
        toolNamed(confining('read-only'), approval, 'write'),
        { path: inside, content: 'x' },
        workspace,
      ),
    )

    const text = textOf(result)
    expect(result?.isError).toBe(true)
    expect(text).toContain('[sandbox: file access denied under read-only mode]')
    expect(text).toContain('sandbox_permissions')
    expect(existsSync(inside)).toBe(false)
  })

  test('full access writes anywhere without asking', async () => {
    const [approval, asked] = await answering(true)
    const result = await Effect.runPromise(
      call(
        toolNamed(confining('danger-full-access'), approval, 'write'),
        { path: outside, content: 'free' },
        workspace,
      ),
    )

    expect(result?.isError).toBe(false)
    expect(readFileSync(outside, 'utf8')).toBe('free')
    expect(asked).toEqual([])
  })
})
