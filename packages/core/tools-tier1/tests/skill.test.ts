import { HooksLive } from '@jozo-harness/kernel'
import {
  Tools,
  toolsLayer,
  type ToolDefinition,
  type ToolError,
  type ToolExecutionResult,
} from '@jozo-harness/tools'
import { Context, Effect, Layer } from 'effect'
import { describe, expect, test } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeSkillTool } from '../src/index.ts'
/** Writes a file, making the directories above it, because the file may not be there yet. */
const writeFileDeep = async (path: string, text: string | Uint8Array): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

const call = (
  tool: ToolDefinition<any, any>,
  args: unknown,
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
        context: { sessionId: 's1', cwd: '/tmp', callId: 'c1' },
      })
    }),
  )

const skillText = (name: string, body = 'steps'): string =>
  '---\nname: ' + name + '\ndescription: ' + name + ' does things\n---\n\n' + body + '\n'

describe('skill tool', () => {
  test('reads the SKILL.md of a skill the roots hold', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-skill-'))
    const path = join(root, 'demo', 'SKILL.md')
    await writeFileDeep(path, skillText('demo', '# demo\nsteps'))

    const result = await Effect.runPromise(
      call(makeSkillTool([root, '/missing']), { name: 'demo' }),
    )

    expect(result?.isError).toBe(false)
    expect(result?.value).toEqual({ name: 'demo', path, body: '# demo\nsteps' })
    await rm(root, { recursive: true, force: true })
  })

  test('a skill the slash list hides is still readable by the model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-skill-'))
    const path = join(root, 'demo', 'SKILL.md')
    await writeFileDeep(
      path,
      '---\nname: demo\ndescription: Runs by the model\nuserInvocable: false\n---\n\nsteps\n',
    )

    const result = await Effect.runPromise(call(makeSkillTool([root]), { name: 'demo' }))

    expect(result?.isError).toBe(false)
    expect(result?.value).toEqual({ name: 'demo', path, body: 'steps' })
    await rm(root, { recursive: true, force: true })
  })

  test('refuses a name that could escape the root', async () => {
    const result = await Effect.runPromise(call(makeSkillTool([]), { name: '../secrets' }))

    expect(result?.isError).toBe(true)
    expect(JSON.stringify(result?.content)).toContain('lower-case letters')
  })

  test('an unknown skill names what is available', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-skill-'))
    await writeFileDeep(join(root, 'demo', 'SKILL.md'), skillText('demo'))

    const result = await Effect.runPromise(call(makeSkillTool([root]), { name: 'nope' }))

    expect(result?.isError).toBe(true)
    expect(JSON.stringify(result?.content)).toContain('unknown skill: nope')
    expect(JSON.stringify(result?.content)).toContain('demo')
    await rm(root, { recursive: true, force: true })
  })

  test('a skill file that fails validation is not readable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-skill-'))
    await writeFileDeep(join(root, 'broken', 'SKILL.md'), '# no frontmatter\n')

    const result = await Effect.runPromise(call(makeSkillTool([root]), { name: 'broken' }))

    expect(result?.isError).toBe(true)
    expect(JSON.stringify(result?.content)).toContain('unknown skill: broken')
    await rm(root, { recursive: true, force: true })
  })
})
