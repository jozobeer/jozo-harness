import { describe, expect, test } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Effect } from 'effect'
import { REFERENCE_LIMITS, type SessionEvent, type SessionSummary } from '@jozo-harness/ui-protocol'
import {
  readFileReference,
  resolveReferences,
  sessionCandidateTargets,
  type SessionDigestSource,
} from '../src/server/references.ts'

const writeDeep = async (path: string, text: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

const workspace = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'jzh-references-'))
  await writeDeep(join(root, 'src/notes.md'), 'the file body')
  return root
}

const userMessage = (seq: number, text: string): SessionEvent => ({
  seq,
  time: 0,
  type: 'user/message',
  data: { text, source: 'user' },
})

const assistantMessage = (seq: number, text: string): SessionEvent => ({
  seq,
  time: 0,
  type: 'assistant/message',
  data: {
    provider: 'stub',
    model: 'stub',
    content: [{ type: 'text', text }],
    stream: [],
  },
})

const summaryOf = (id: string, cwd: string, title = ''): SessionSummary => ({
  id,
  cwd,
  createdAt: 0,
  updatedAt: 0,
  title,
})

const sourceOf = (
  summaries: ReadonlyArray<SessionSummary>,
  logs: Readonly<Record<string, ReadonlyArray<SessionEvent>>>,
): SessionDigestSource => ({
  list: () => Effect.succeed(summaries),
  events: (id) => Effect.succeed(logs[id] ?? []),
})

describe('reading an @file', () => {
  test('resolves the body of a file inside the workspace', async () => {
    const root = await workspace()
    try {
      const reference = await Effect.runPromise(readFileReference(root, 'src/notes.md'))

      expect(reference?.kind).toBe('file')
      expect(reference?.text).toBe('the file body')
      expect(reference?.cut).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('cuts a file over the budget and keeps the size it held', async () => {
    const root = await workspace()
    try {
      const body = 'x'.repeat(REFERENCE_LIMITS.maxFileChars + 500)
      await writeDeep(join(root, 'big.ts'), body)
      const [reference] = await Effect.runPromise(
        resolveReferences(root, 'read @big.ts', sourceOf([], {})),
      )

      expect(reference?.text).toHaveLength(REFERENCE_LIMITS.maxFileChars + 1)
      expect(reference?.text.endsWith('…')).toBe(true)
      expect(reference?.cut).toBe(body.length)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('notes a file inside the workspace that is missing', async () => {
    const root = await workspace()
    try {
      const reference = await Effect.runPromise(readFileReference(root, 'src/gone.md'))

      expect(reference?.kind).toBe('file')
      expect(reference?.text).toContain('could not be read')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('refuses a path that leaves the workspace by .. or by its name', async () => {
    const root = await workspace()
    const outside = await mkdtemp(join(tmpdir(), 'jzh-outside-'))
    try {
      await writeFile(join(outside, 'secret.md'), 'not yours')
      const up = await Effect.runPromise(readFileReference(root, '../' + 'secret.md'))
      const absolute = await Effect.runPromise(readFileReference(root, join(outside, 'secret.md')))

      expect(up).toBeUndefined()
      expect(absolute).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('refuses a symlink whose target leaves the workspace', async () => {
    const root = await workspace()
    const outside = await mkdtemp(join(tmpdir(), 'jzh-symlink-'))
    try {
      await writeFile(join(outside, 'secret.md'), 'not yours')
      await symlink(join(outside, 'secret.md'), join(root, 'link.md'))
      const reference = await Effect.runPromise(readFileReference(root, 'link.md'))

      expect(reference).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe('reading an @session', () => {
  test('attaches a digest of another session in the same workspace', async () => {
    const root = await workspace()
    try {
      const source = sourceOf([summaryOf('other', root, 'the other work')], {
        other: [userMessage(1, 'why does it fail?'), assistantMessage(2, 'the lock is stale')],
      })

      const [reference] = await Effect.runPromise(
        resolveReferences(root, 'see @session:other', source),
      )

      expect(reference?.kind).toBe('session')
      expect(reference?.text).toContain('the other work')
      expect(reference?.text).toContain('why does it fail?')
      expect(reference?.text).toContain('the lock is stale')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps only the seq range the word names', async () => {
    const root = await workspace()
    try {
      const source = sourceOf([summaryOf('other', root)], {
        other: [
          userMessage(1, 'before the range'),
          userMessage(2, 'inside the range'),
          assistantMessage(3, 'the answer inside'),
          userMessage(4, 'after the range'),
        ],
      })

      const [reference] = await Effect.runPromise(
        resolveReferences(root, 'see @session:other#2-3', source),
      )

      expect(reference?.text).toContain('inside the range')
      expect(reference?.text).toContain('the answer inside')
      expect(reference?.text).not.toContain('before the range')
      expect(reference?.text).not.toContain('after the range')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('offers the readable sessions newest first when several match', async () => {
    const root = await workspace()
    try {
      const source: SessionDigestSource = {
        list: () =>
          Effect.succeed([
            { ...summaryOf('older', root, 'work one'), updatedAt: 1 },
            { ...summaryOf('newer', root, 'work two'), updatedAt: 2 },
          ]),
        events: () => Effect.succeed([]),
      }

      const candidates = await Effect.runPromise(sessionCandidateTargets(root, 'work', source))

      expect(candidates).toEqual(['session:newer', 'session:older'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('offers no candidate when the store cannot be read', async () => {
    const root = await workspace()
    try {
      const source: SessionDigestSource = {
        list: () => Effect.fail(new Error('the store is gone')),
        events: () => Effect.succeed([]),
      }

      const candidates = await Effect.runPromise(sessionCandidateTargets(root, 'work', source))

      expect(candidates).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('attaches the named session with no messages when its log cannot be read', async () => {
    const root = await workspace()
    try {
      const source: SessionDigestSource = {
        list: () => Effect.succeed([summaryOf('other', root, 'the other work')]),
        events: () => Effect.fail(new Error('the log is gone')),
      }

      const [reference] = await Effect.runPromise(
        resolveReferences(root, 'see @session:other', source),
      )

      expect(reference?.kind).toBe('session')
      expect(reference?.text).toContain('the other work')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps a session from another workspace out of the candidates and the body', async () => {
    const root = await workspace()
    const other = await mkdtemp(join(tmpdir(), 'jzh-other-tree-'))
    try {
      const source = sourceOf(
        [summaryOf('mine', root, 'my work'), summaryOf('theirs', other, 'their work')],
        { theirs: [userMessage(1, 'their secret')] },
      )

      const candidates = await Effect.runPromise(sessionCandidateTargets(root, 'work', source))
      // The prefix alone asks for sessions, so it lists the readable ones without
      // needing part of an id or a title first.
      const all = await Effect.runPromise(sessionCandidateTargets(root, 'session:', source))
      const [reference] = await Effect.runPromise(
        resolveReferences(root, 'see @session:theirs', source),
      )

      expect(candidates).toContain('session:mine')
      expect(candidates).not.toContain('session:theirs')
      expect(all).toEqual(['session:mine'])
      expect(reference).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(other, { recursive: true, force: true })
    }
  })
})
