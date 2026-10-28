import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  bundledSkillsRoot,
  discoverSkills,
  loadSkill,
  modelSkills,
  parseSkillDocument,
  renderSkillCatalog,
  skillRoots,
  userSkills,
} from '../src/index.ts'
/** Writes a file, making the directories above it, because the file may not be there yet. */
const writeFileDeep = async (path: string, text: string | Uint8Array): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

const skillText = (name: string, body = 'Steps here.'): string =>
  '---\nname: ' + name + '\ndescription: ' + name + ' does things\n---\n\n' + body + '\n'

const writeSkill = async (root: string, name: string, body?: string): Promise<void> => {
  await writeFileDeep(join(root, name, 'SKILL.md'), skillText(name, body))
}

describe('parseSkillDocument', () => {
  test('reads the name, description, and body out of the frontmatter', () => {
    const parsed = parseSkillDocument(
      '---\nname: demo\ndescription: Does one thing\n---\n\nSteps here.\n',
    )

    expect(parsed).toEqual({
      name: 'demo',
      description: 'Does one thing',
      modelInvocable: true,
      userInvocable: true,
      body: 'Steps here.',
    })
  })

  test('both invocation flags default to true when the frontmatter leaves them out', () => {
    const parsed = parseSkillDocument('---\nname: demo\ndescription: Does one thing\n---\nbody\n')

    expect(parsed?.modelInvocable).toBe(true)
    expect(parsed?.userInvocable).toBe(true)
  })

  test('a false flag turns only its own listing off', () => {
    const parsed = parseSkillDocument(
      '---\nname: demo\ndescription: Does one thing\nmodelInvocable: false\nuserInvocable: false\n---\nbody\n',
    )

    expect(parsed?.modelInvocable).toBe(false)
    expect(parsed?.userInvocable).toBe(false)
  })

  test('a flag value that is not a boolean falls back to the default true', () => {
    const parsed = parseSkillDocument(
      '---\nname: demo\ndescription: Does one thing\nmodelInvocable: maybe\nuserInvocable: 0\n---\nbody\n',
    )

    expect(parsed?.modelInvocable).toBe(true)
    expect(parsed?.userInvocable).toBe(true)
  })

  test('a file without frontmatter is not a skill document', () => {
    expect(parseSkillDocument('# demo\nsteps\n')).toBeUndefined()
  })

  test('frontmatter without a description is not a skill document', () => {
    expect(parseSkillDocument('---\nname: demo\n---\nbody\n')).toBeUndefined()
  })

  test('a name that could escape a root is not a skill document', () => {
    expect(
      parseSkillDocument('---\nname: ../secrets\ndescription: no\n---\nbody\n'),
    ).toBeUndefined()
  })

  test('a quoted false still turns its listing off', () => {
    const parsed = parseSkillDocument(
      '---\nname: demo\ndescription: Does one thing\nmodelInvocable: "false"\n---\nbody\n',
    )

    expect(parsed?.modelInvocable).toBe(false)
  })

  test('quoted values are unquoted and other keys are ignored', () => {
    const parsed = parseSkillDocument(
      '---\nname: "demo"\nlicense: MIT\ndescription: \'Does one thing\'\n---\nbody\n',
    )

    expect(parsed?.name).toBe('demo')
    expect(parsed?.description).toBe('Does one thing')
  })
})

describe('discoverSkills', () => {
  test('lists every root in order, first root wins on one name', async () => {
    const first = await mkdtemp(join(tmpdir(), 'jozo-harness-skills-'))
    const second = await mkdtemp(join(tmpdir(), 'jozo-harness-skills-'))
    await writeSkill(first, 'demo', 'from the first root')
    await writeSkill(first, 'other')
    await writeSkill(second, 'demo', 'from the second root')
    await writeFileDeep(join(second, 'SKILL.md'), 'a stray file, not a skill directory')
    await writeFileDeep(join(first, 'not-a-skill', 'README.md'), 'no SKILL.md here')

    const skills = await Effect.runPromise(discoverSkills([first, second, join(first, 'missing')]))

    expect(skills.map((skill) => skill.name)).toEqual(['demo', 'other'])
    expect(skills[0]?.path).toBe(join(first, 'demo', 'SKILL.md'))
    expect(skills[0]?.description).toBe('demo does things')
    expect(skills[0]).toMatchObject({ modelInvocable: true, userInvocable: true })
    await rm(first, { recursive: true, force: true })
    await rm(second, { recursive: true, force: true })
  })

  test('a symlinked skill directory is listed and loads through the link', async () => {
    const shared = await mkdtemp(join(tmpdir(), 'jozo-harness-skills-'))
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-skills-'))
    await writeSkill(shared, 'demo', 'from the shared directory')
    await symlink(join(shared, 'demo'), join(root, 'demo'), 'dir')

    const skills = await Effect.runPromise(discoverSkills([root]))
    const loaded = await Effect.runPromise(loadSkill([root], 'demo'))

    expect(skills.map((skill) => skill.name)).toEqual(['demo'])
    expect(skills[0]?.path).toBe(join(root, 'demo', 'SKILL.md'))
    expect(loaded?.body).toBe('from the shared directory')
    await rm(root, { recursive: true, force: true })
    await rm(shared, { recursive: true, force: true })
  })

  test('a broken or non-directory symlink is ignored', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-skills-'))
    await writeSkill(root, 'demo')
    await symlink(join(root, 'missing-target'), join(root, 'broken'), 'dir')
    await writeFileDeep(join(root, 'plain-file'), 'not a directory')
    await symlink(join(root, 'plain-file'), join(root, 'linked-file'), 'file')

    const skills = await Effect.runPromise(discoverSkills([root]))

    expect(skills.map((skill) => skill.name)).toEqual(['demo'])
    await rm(root, { recursive: true, force: true })
  })

  test('a skill hidden from the model is still listed and still loads by name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-skills-'))
    await writeFileDeep(
      join(root, 'human-only', 'SKILL.md'),
      '---\nname: human-only\ndescription: Run by hand\nmodelInvocable: false\n---\n\nSteps here.\n',
    )

    const skills = await Effect.runPromise(discoverSkills([root]))
    const loaded = await Effect.runPromise(loadSkill([root], 'human-only'))

    expect(skills.map((skill) => skill.name)).toEqual(['human-only'])
    expect(loaded?.body).toBe('Steps here.')
    await rm(root, { recursive: true, force: true })
  })

  test('a SKILL.md that fails validation is ignored', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-skills-'))
    await writeFileDeep(join(root, 'broken', 'SKILL.md'), '# no frontmatter\n')

    const skills = await Effect.runPromise(discoverSkills([root]))

    expect(skills).toEqual([])
    await rm(root, { recursive: true, force: true })
  })
})

describe('renderSkillCatalog', () => {
  test('lists every model-invocable skill with its description and the reading instruction', () => {
    const text = renderSkillCatalog([
      {
        name: 'demo',
        description: 'Does one thing',
        modelInvocable: true,
        userInvocable: true,
        path: '/skills/demo/SKILL.md',
      },
      {
        name: 'other',
        description: 'Does another',
        modelInvocable: true,
        userInvocable: true,
        path: '/skills/other/SKILL.md',
      },
    ])

    expect(text).toContain('<available_skills>')
    expect(text).toContain('- demo: Does one thing')
    expect(text).toContain('- other: Does another')
    expect(text).toContain('call the `skill` tool with the exact skill name')
  })

  test('a model-hidden skill stays out of the catalog while a user-hidden one stays in it', () => {
    const skills = [
      {
        name: 'both',
        description: 'Runs both ways',
        modelInvocable: true,
        userInvocable: true,
        path: '/s/both',
      },
      {
        name: 'human-only',
        description: 'Runs by hand',
        modelInvocable: false,
        userInvocable: true,
        path: '/s/human',
      },
      {
        name: 'model-only',
        description: 'Runs by the model',
        modelInvocable: true,
        userInvocable: false,
        path: '/s/model',
      },
    ]

    const text = renderSkillCatalog(skills)

    expect(text).toContain('- both: Runs both ways')
    expect(text).toContain('- model-only: Runs by the model')
    expect(text).not.toContain('human-only')
    expect(modelSkills(skills).map((skill) => skill.name)).toEqual(['both', 'model-only'])
    expect(userSkills(skills).map((skill) => skill.name)).toEqual(['both', 'human-only'])
  })

  test('a description stays on one line and stays short', () => {
    const text = renderSkillCatalog([
      {
        name: 'demo',
        description: 'first line\nsecond line ' + 'x'.repeat(400),
        modelInvocable: true,
        userInvocable: true,
        path: '/s',
      },
    ])

    const line = text.split('\n').find((candidate) => candidate.startsWith('- demo: ')) ?? ''
    expect(line).not.toContain('\n')
    expect(line.length).toBeLessThanOrEqual(200)
  })

  test('no skills means nothing to publish', () => {
    expect(renderSkillCatalog([])).toBe('')
  })
})

describe('skillRoots', () => {
  test('reads the workspace, the custom roots, then the home', () => {
    expect(skillRoots({ cwd: '/work', home: '/home/me/.jzh', custom: ['/extra'] })).toEqual([
      '/work/.jzh/skills',
      '/extra',
      '/home/me/.jzh/skills',
      bundledSkillsRoot,
    ])
  })

  test('a repeated root appears once', () => {
    expect(skillRoots({ cwd: '/work', custom: ['/work/.jzh/skills', '/extra', '/extra'] })).toEqual(
      ['/work/.jzh/skills', '/extra', bundledSkillsRoot],
    )
  })

  test('without a home the workspace and the bundled skills remain', () => {
    expect(skillRoots({ cwd: '/work' })).toEqual(['/work/.jzh/skills', bundledSkillsRoot])
  })

  test('the bundled root sits inside this checkout, not under the workspace', () => {
    expect(bundledSkillsRoot.startsWith('/work')).toBe(false)
    expect(bundledSkillsRoot.endsWith(join('tools-tier1', 'skills'))).toBe(true)
  })

  test('the bundled Office skills are found from any cwd', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'jozo-harness-skills-cwd-'))
    const roots = skillRoots({ cwd })

    const skills = await Effect.runPromise(discoverSkills(roots))
    const names = skills.map((skill) => skill.name)
    const docx = await Effect.runPromise(loadSkill(roots, 'docx'))

    expect(names).toEqual(expect.arrayContaining(['docx', 'pptx', 'xlsx']))
    expect(docx?.path.startsWith(bundledSkillsRoot)).toBe(true)
    expect(docx?.body).toContain('soffice')
    await rm(cwd, { recursive: true, force: true })
  })
})
