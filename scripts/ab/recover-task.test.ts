import { afterEach, describe, expect, test } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { LIST_PATH, ambiguousList, recoverAmbiguousEdit, wrongListHelpers } from './recover-task.ts'

const workspaces: Array<string> = []

const workspaceWith = async (files: Readonly<Record<string, string>>): Promise<string> => {
  const workspace = await mkdtemp(join(tmpdir(), 'jozo-harness-ab-recover-'))
  workspaces.push(workspace)
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(workspace, path)), { recursive: true })
    await writeFile(join(workspace, path), text)
  }
  return workspace
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('the recovery A/B task', () => {
  test('the line the fix has to change is not unique, which is what makes the first edit fail', () => {
    const occurrences = ambiguousList().split('return values[0]!').length - 1

    expect(occurrences).toBe(2)
  })

  test('the judge names last and only last in the workspace the task ships', async () => {
    const workspace = await workspaceWith(recoverAmbiguousEdit.files)

    expect(await wrongListHelpers(workspace)).toEqual(['last'])
    expect(await recoverAmbiguousEdit.done(workspace)).toBe(false)
  })

  test('the disambiguated fix is done', async () => {
    const workspace = await workspaceWith({ [LIST_PATH]: fixedOnlyLast() })

    expect(await wrongListHelpers(workspace)).toEqual([])
    expect(await recoverAmbiguousEdit.done(workspace)).toBe(true)
  })

  test('an edit that rewrites both helpers is not done', async () => {
    const workspace = await workspaceWith({
      [LIST_PATH]: ambiguousList()
        .split('return values[0]!')
        .join('return values[values.length - 1]!'),
    })

    expect(await wrongListHelpers(workspace)).toEqual(['first'])
  })

  test('an edit that only touches the comment keeps the task open', async () => {
    const workspace = await workspaceWith({
      [LIST_PATH]: ambiguousList().replace('The last element', 'The final element'),
    })

    expect(await wrongListHelpers(workspace)).toEqual(['last'])
  })

  test('a helper that returns the last element the other way is accepted', async () => {
    const workspace = await workspaceWith({ [LIST_PATH]: fixedOnlyLast('values.at(-1)!') })

    expect(await wrongListHelpers(workspace)).toEqual([])
  })
})

/** The shipped file with last fixed the way a model that re-read the file would fix it. */
const fixedOnlyLast = (expression = 'values[values.length - 1]!'): string => {
  const text = ambiguousList()
  const first = text.indexOf('export const last')
  return (
    text.slice(0, first) + text.slice(first).replace('return values[0]!', 'return ' + expression)
  )
}
