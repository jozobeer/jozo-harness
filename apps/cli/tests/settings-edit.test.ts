import { describe, expect, test } from 'vitest'
import { Effect } from 'effect'
import { applyEdit, type SettingsEdit } from '../src/settings-edit.ts'

const applied = (text: string, edit: SettingsEdit) => Effect.runPromise(applyEdit(text, edit))
const refused = (text: string, edit: SettingsEdit) =>
  Effect.runPromise(Effect.flip(applyEdit(text, edit)))

const SKILLS = ['skills:', '  - ~/a', '  - ~/b'].join('\n') + '\n'
const ROWS =
  [
    'plugins:',
    '  - id: sessions',
    "    name: '@jozo-harness/session-jsonl'",
    '    config:',
    '      root: ~/.jzh/sessions',
  ].join('\n') + '\n'

describe('settings edits', () => {
  test('sets a scalar in a file it creates', async () => {
    const edited = await applied('', { kind: 'set-scalar', key: 'model', value: 'a/b' })

    expect(edited.text).toBe('model: a/b\n')
    expect(edited.changed).toBe(true)
  })

  test('replaces a scalar in place and keeps the comments', async () => {
    const text = '# my settings\nmodel: old/x\nprofile: repl\n'

    const edited = await applied(text, { kind: 'set-scalar', key: 'model', value: 'new/y' })

    expect(edited.text).toBe('# my settings\nmodel: new/y\nprofile: repl\n')
  })

  test('writes a whole list under its key, replacing the one already there', async () => {
    const edited = await applied('model: a/b\ntools:\n  - read\n  - bash\n', {
      kind: 'set-list',
      key: 'tools',
      items: ['read', 'grep'],
    })

    expect(edited.text).toBe('model: a/b\ntools:\n  - read\n  - grep\n')
    expect(edited.changed).toBe(true)
  })

  test('drops the key when the list is empty', async () => {
    const edited = await applied('model: a/b\ntools:\n  - read\n', {
      kind: 'set-list',
      key: 'tools',
      items: [],
    })

    expect(edited.text).toBe('model: a/b\n')
  })

  test('adds the first directory as a block', async () => {
    const edited = await applied('model: a/b\n', { kind: 'add-skill', dir: '~/skills' })

    expect(edited.text).toBe('model: a/b\nskills:\n  - ~/skills\n')
  })

  test('appends a directory after the ones already there', async () => {
    const text = 'model: a/b\n' + SKILLS

    const edited = await applied(text, { kind: 'add-skill', dir: '~/c' })

    expect(edited.text).toBe('model: a/b\nskills:\n  - ~/a\n  - ~/b\n  - ~/c\n')
  })

  test('leaves the file alone when the directory is already there', async () => {
    const edited = await applied(SKILLS, { kind: 'add-skill', dir: '~/a' })

    expect(edited.changed).toBe(false)
    expect(edited.text).toBe(SKILLS)
  })

  test('refuses a list written on one line', async () => {
    const error = await refused('skills: [~/a]\n', { kind: 'add-skill', dir: '~/b' })

    expect(error.code).toBe('inline-value')
  })

  test('removes one directory and keeps the rest', async () => {
    const text = 'skills:\n  - ~/a\n  - ~/b\n  - ~/c\n'

    const edited = await applied(text, { kind: 'remove-skill', dir: '~/b' })

    expect(edited.text).toBe('skills:\n  - ~/a\n  - ~/c\n')
  })

  test('removes the key with the last directory, so nothing is left unset', async () => {
    const edited = await applied('model: a/b\nskills:\n  - ~/a\n', {
      kind: 'remove-skill',
      dir: '~/a',
    })

    expect(edited.text).toBe('model: a/b\n')
  })

  test('refuses to remove a directory that is not there', async () => {
    const error = await refused(SKILLS, { kind: 'remove-skill', dir: '~/nope' })

    expect(error.code).toBe('no-such-item')
  })

  test('adds the first row as a block', async () => {
    const edited = await applied('', { kind: 'add-row', id: 'mcp', name: '@jozo-harness/mcp' })

    expect(edited.text).toBe("plugins:\n  - id: mcp\n    name: '@jozo-harness/mcp'\n")
  })

  test('appends a row after the ones already there', async () => {
    const edited = await applied(ROWS, { kind: 'add-row', id: 'mcp', name: '@jozo-harness/mcp' })

    expect(edited.text).toBe(ROWS + "  - id: mcp\n    name: '@jozo-harness/mcp'\n")
  })

  test('refuses a row whose id is already in the file', async () => {
    const error = await refused(ROWS, {
      kind: 'add-row',
      id: 'sessions',
      name: '@jozo-harness/session',
    })

    expect(error.code).toBe('duplicate-row')
  })

  test('writes a config key under the row it names', async () => {
    const edited = await applied(ROWS, {
      kind: 'set-row',
      id: 'sessions',
      name: '@jozo-harness/session-jsonl',
      key: 'root',
      value: '~/.jzh/other',
    })

    expect(edited.text).toBe(ROWS.replace('~/.jzh/sessions', '~/.jzh/other'))
  })

  test('adds the config block when the row has none', async () => {
    const text = "plugins:\n  - id: safety\n    name: '@jozo-harness/safety'\n"

    const edited = await applied(text, {
      kind: 'set-row',
      id: 'safety',
      name: '@jozo-harness/safety',
      key: 'preset',
      value: 'full',
    })

    expect(edited.text).toBe(
      "plugins:\n  - id: safety\n    name: '@jozo-harness/safety'\n    config:\n      preset: full\n",
    )
  })

  test('adds a second key under the config block that is there', async () => {
    const edited = await applied(ROWS, {
      kind: 'set-row',
      id: 'sessions',
      name: '@jozo-harness/session-jsonl',
      key: 'keep',
      value: '3',
    })

    expect(edited.text).toBe(ROWS + '      keep: 3\n')
  })

  test('writes disabled at the row level, not under config', async () => {
    const text = "plugins:\n  - id: ask\n    name: '@jozo-harness/ask'\n"

    const edited = await applied(text, {
      kind: 'set-row',
      id: 'ask',
      name: '@jozo-harness/ask',
      key: 'disabled',
      value: 'true',
    })

    expect(edited.text).toBe(
      "plugins:\n  - id: ask\n    name: '@jozo-harness/ask'\n    disabled: true\n",
    )
  })

  test('creates the row a key is set on', async () => {
    const edited = await applied('model: a/b\n', {
      kind: 'set-row',
      id: 'safety',
      name: '@jozo-harness/safety',
      key: 'preset',
      value: 'full',
    })

    expect(edited.text).toBe(
      "model: a/b\nplugins:\n  - id: safety\n    name: '@jozo-harness/safety'\n    config:\n      preset: full\n",
    )
  })

  test('removes a row and keeps the one before it', async () => {
    const text = ROWS + "  - id: ask\n    name: '@jozo-harness/ask'\n"

    const edited = await applied(text, { kind: 'remove-row', id: 'ask' })

    expect(edited.text).toBe(ROWS)
  })

  test('removes the key with the last row', async () => {
    const edited = await applied(ROWS, { kind: 'remove-row', id: 'sessions' })

    expect(edited.text).toBe('')
  })

  test('refuses to remove a row that is not in the file', async () => {
    const error = await refused(ROWS, { kind: 'remove-row', id: 'mcp' })

    expect(error.code).toBe('no-such-row')
  })
})
