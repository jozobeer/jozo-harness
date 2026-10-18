import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  AGENTS_MD_BUDGET_BYTES,
  additionalInstructionsText,
  agentsMdSections,
  loadAgentsFiles,
  loadedAgentsOf,
  makeSystemPrompt,
  nestedAgentsFiles,
  registerAgentsMd,
  type PromptSection,
} from '../src/index.ts'
/** Writes a file, making the directories above it, because the file may not be there yet. */
const writeFileDeep = async (path: string, text: string | Uint8Array): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

/** Section text, which may be a function of the assemble context. */
const textOf = (section: PromptSection | undefined): string => {
  if (section === undefined) return ''
  return typeof section.text === 'function' ? section.text({ variables: {} }) : section.text
}

/** A workspace whose discovery stops at its own `.git`, so parent directories cannot leak in. */
const workspace = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'jozo-harness-agents-'))
  await mkdir(join(root, '.git'), { recursive: true })
  return root
}

describe('loadAgentsFiles', () => {
  test('reads the project root down to cwd, outermost first', async () => {
    const root = await workspace()
    const nested = join(root, 'a', 'b')
    await mkdir(nested, { recursive: true })
    await writeFileDeep(join(root, 'AGENTS.md'), 'outer rules\n')
    await writeFileDeep(join(nested, 'AGENTS.md'), 'inner rules\n')

    const load = await Effect.runPromise(loadAgentsFiles(nested))

    expect(load.files.map((file) => file.path)).toEqual([
      join(root, 'AGENTS.md'),
      join(nested, 'AGENTS.md'),
    ])
    expect(load.files.map((file) => file.text.trim())).toEqual(['outer rules', 'inner rules'])
    await rm(root, { recursive: true, force: true })
  })

  test('reads CLAUDE.md when AGENTS.md is absent', async () => {
    const root = await workspace()
    await writeFileDeep(join(root, 'CLAUDE.md'), 'claude rules\n')

    const load = await Effect.runPromise(loadAgentsFiles(root))

    expect(load.files.map((file) => file.path)).toEqual([join(root, 'CLAUDE.md')])
    await rm(root, { recursive: true, force: true })
  })

  test('reads the local candidate after the base in the same directory', async () => {
    const root = await workspace()
    await writeFileDeep(join(root, 'CLAUDE.md'), 'base rules\n')
    await writeFileDeep(join(root, 'CLAUDE.local.md'), 'local rules\n')

    const load = await Effect.runPromise(loadAgentsFiles(root))

    expect(load.files.map((file) => file.path)).toEqual([
      join(root, 'CLAUDE.md'),
      join(root, 'CLAUDE.local.md'),
    ])
    await rm(root, { recursive: true, force: true })
  })

  test('does not walk above the project root marker', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'jozo-harness-agents-'))
    const root = join(parent, 'project')
    await mkdir(join(root, '.git'), { recursive: true })
    await writeFileDeep(join(parent, 'AGENTS.md'), 'above the project\n')

    const load = await Effect.runPromise(loadAgentsFiles(root))

    expect(load.files).toEqual([])
    await rm(parent, { recursive: true, force: true })
  })

  test('reads the home file first', async () => {
    const root = await workspace()
    const home = await mkdtemp(join(tmpdir(), 'jozo-harness-home-'))
    await writeFileDeep(join(home, 'AGENTS.md'), 'home rules\n')
    await writeFileDeep(join(root, 'AGENTS.md'), 'workspace rules\n')

    const load = await Effect.runPromise(loadAgentsFiles(root, { home }))

    expect(load.files.map((file) => file.text.trim())).toEqual(['home rules', 'workspace rules'])
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  })

  test('reads the same instruction text only once', async () => {
    const root = await workspace()
    const nested = join(root, 'a')
    await mkdir(nested, { recursive: true })
    await writeFileDeep(join(root, 'AGENTS.md'), 'same rules\n')
    await writeFileDeep(join(nested, 'AGENTS.md'), 'same rules\n')

    const load = await Effect.runPromise(loadAgentsFiles(nested))

    expect(load.files).toHaveLength(1)
    await rm(root, { recursive: true, force: true })
  })

  test('names a file too large to read instead of loading it', async () => {
    const root = await workspace()
    await writeFileDeep(join(root, 'AGENTS.md'), 'x'.repeat(100))

    const load = await Effect.runPromise(loadAgentsFiles(root, { maxSourceBytes: 10 }))

    expect(load.files).toEqual([])
    expect(load.omitted).toEqual([join(root, 'AGENTS.md')])
    await rm(root, { recursive: true, force: true })
  })
})

describe('agentsMdSections', () => {
  test('states the precedence of the instructions before any file', () => {
    const rendered = agentsMdSections(
      {
        files: [
          { path: '/work/AGENTS.md', text: 'outer\n' },
          { path: '/work/a/AGENTS.md', text: 'inner\n' },
        ],
        omitted: [],
      },
      { order: 10 },
    )

    expect(rendered.sections.map((section) => section.name)).toEqual([
      'agents-md:precedence',
      'agents-md:1',
      'agents-md:2',
    ])
    const precedence = textOf(rendered.sections[0])
    expect(precedence).toContain('More specific instructions take precedence over broader ones.')
    expect(precedence).toContain('direct user instructions')
  })

  test('gives the nearest file the highest order', () => {
    const rendered = agentsMdSections(
      {
        files: [
          { path: '/work/AGENTS.md', text: 'outer\n' },
          { path: '/work/a/AGENTS.md', text: 'inner\n' },
        ],
        omitted: [],
      },
      { order: 10 },
    )

    expect(rendered.sections.map((section) => section.name)).toEqual([
      'agents-md:precedence',
      'agents-md:1',
      'agents-md:2',
    ])
    expect(rendered.sections.map((section) => section.order)).toEqual([10, 11, 12])
    expect(textOf(rendered.sections[1])).toBe('Instructions from /work/AGENTS.md:\nouter')
    expect(rendered.notice).toBeUndefined()
  })

  test('truncates a file that does not fit and notices it', () => {
    const body = 'y'.repeat(500)
    const rendered = agentsMdSections(
      { files: [{ path: '/work/AGENTS.md', text: body }], omitted: [] },
      { maxBytes: 100 },
    )

    expect(rendered.sections).toHaveLength(2)
    expect(textOf(rendered.notice)).toContain(
      'Workspace instruction budget 100 bytes: truncated /work/AGENTS.md from',
    )
    const text = textOf(rendered.sections[1])
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(100)
    expect(text.startsWith('Instructions from /work/AGENTS.md:\n')).toBe(true)
  })

  test('omits every file after the budget is spent', () => {
    const rendered = agentsMdSections(
      {
        files: [
          { path: '/work/AGENTS.md', text: 'y'.repeat(500) },
          { path: '/work/a/AGENTS.md', text: 'later rules' },
        ],
        omitted: [],
      },
      { maxBytes: 100 },
    )

    expect(rendered.sections).toHaveLength(2)
    expect(textOf(rendered.notice)).toContain('omitted /work/a/AGENTS.md')
  })

  test('a file discovery skipped is named in the notice', () => {
    const rendered = agentsMdSections(
      { files: [{ path: '/work/AGENTS.md', text: 'rules' }], omitted: ['/huge/AGENTS.md'] },
      {},
    )

    expect(textOf(rendered.notice)).toBe(
      'Workspace instruction budget ' + AGENTS_MD_BUDGET_BYTES + ' bytes: omitted /huge/AGENTS.md',
    )
  })
})

describe('nestedAgentsFiles', () => {
  test('finds the files between the workspace root and the touched file', async () => {
    const root = await workspace()
    const nested = join(root, 'packages', 'foo')
    await mkdir(nested, { recursive: true })
    await writeFileDeep(join(root, 'AGENTS.md'), 'root rules\n')
    await writeFileDeep(join(nested, 'AGENTS.md'), 'nested rules\n')
    await writeFileDeep(join(nested, 'file.txt'), 'content\n')

    const found = await Effect.runPromise(
      nestedAgentsFiles(loadedAgentsOf({ files: [], omitted: [] }), {
        root,
        cwd: root,
        path: join(nested, 'file.txt'),
      }),
    )

    expect(found.map((file) => file.path)).toEqual([join(nested, 'AGENTS.md')])
    await rm(root, { recursive: true, force: true })
  })

  test('skips a file already loaded, and text already loaded', async () => {
    const root = await workspace()
    const nested = join(root, 'a')
    await mkdir(nested, { recursive: true })
    await writeFileDeep(join(nested, 'AGENTS.md'), 'same rules\n')
    const loaded = new Map([[join(root, 'AGENTS.md'), 'same rules']])

    const found = await Effect.runPromise(
      nestedAgentsFiles(loaded, { root, cwd: root, path: join(nested, 'file.txt') }),
    )

    expect(found).toEqual([])
    await rm(root, { recursive: true, force: true })
  })

  test('the additional instructions name the scope and keep the caveat', () => {
    const text = additionalInstructionsText(
      { path: '/work/a/AGENTS.md', text: 'be careful\n' },
      'a',
    )

    expect(text).toContain('Additional instructions from: /work/a/AGENTS.md')
    expect(text).toContain('These instructions apply to work under `a`.')
    expect(text).toContain('more specific instructions take precedence')
    expect(text.endsWith('be careful')).toBe(true)
  })
})

describe('registerAgentsMd', () => {
  test('registers the files on a prompt and returns what it read', async () => {
    const root = await workspace()
    await writeFileDeep(join(root, 'AGENTS.md'), 'outer rules\n')

    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const prompt = makeSystemPrompt()
          const load = yield* registerAgentsMd(prompt, root)
          return { load, rendered: yield* prompt.render({ variables: {} }) }
        }),
      ),
    )

    expect(outcome.rendered).toContain('outer rules')
    expect(outcome.rendered).toContain('Instructions from ' + join(root, 'AGENTS.md'))
    expect(outcome.load.files.map((file) => file.path)).toEqual([join(root, 'AGENTS.md')])
    await rm(root, { recursive: true, force: true })
  })
})
