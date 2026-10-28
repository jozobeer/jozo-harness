import type { CommandsShape } from '@jozo-harness/session'
import { type SkillSummary, renderSkillCatalog } from '@jozo-harness/tools-tier1'
import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import { commandCandidates } from '../../web/src/ui/commands.ts'
import { commandViewsOf } from '../src/index.ts'

/** A registry with no built-ins, so the list holds only the skills handed in. */
const emptyRegistry: CommandsShape = {
  register: () => Effect.void,
  list: () => [],
  parse: () => undefined,
  run: () => Effect.succeed(undefined),
}

const skill = (name: string, modelInvocable: boolean, userInvocable: boolean): SkillSummary => ({
  name,
  description: name + ' does things',
  modelInvocable,
  userInvocable,
  path: '/skills/' + name + '/SKILL.md',
})

const skills: ReadonlyArray<SkillSummary> = [
  skill('both', true, true),
  skill('human-only', false, true),
  skill('model-only', true, false),
]

describe('the two skill listings', () => {
  test('the model catalog keeps model-only and leaves human-only out', () => {
    const catalog = renderSkillCatalog(skills)

    expect(catalog).toContain('- both:')
    expect(catalog).toContain('- model-only:')
    expect(catalog).not.toContain('human-only')
  })

  test('the slash list keeps human-only and leaves model-only out', () => {
    const views = commandViewsOf(emptyRegistry, skills)

    expect(views.map((view) => view.name)).toEqual(['both', 'human-only'])
    expect(views.find((view) => view.name === 'human-only')?.kind).toBe('skill')
  })

  test('the web candidates over that list offer the same names', () => {
    const views = commandViewsOf(emptyRegistry, skills)

    expect(
      commandCandidates(views, { text: '/', start: 0, end: 1 }).map((view) => view.name),
    ).toEqual(['both', 'human-only'])
    expect(
      commandCandidates(views, { text: '/model', start: 0, end: 6 }).map((view) => view.name),
    ).toEqual([])
  })

  test('a built-in command keeps its name even when a skill shares it', () => {
    const registry: CommandsShape = {
      ...emptyRegistry,
      list: () => [
        {
          name: 'both',
          summary: 'the built-in',
          run: () => Effect.succeed({ ok: true, text: '' }),
        },
      ],
    }

    const views = commandViewsOf(registry, skills)

    expect(views.filter((view) => view.name === 'both').map((view) => view.kind)).toEqual([
      'command',
    ])
  })
})
