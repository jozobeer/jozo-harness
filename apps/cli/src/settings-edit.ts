import { parse } from 'yaml'
import { Effect } from 'effect'

/** One change to the settings file, told as text in and text out. */
export type SettingsEdit =
  | {
      readonly kind: 'set-scalar'
      readonly key: string
      /** A number is written bare, since the key reads it as a number. */
      readonly value: string | number
    }
  | { readonly kind: 'set-list'; readonly key: string; readonly items: ReadonlyArray<string> }
  | { readonly kind: 'add-skill'; readonly dir: string }
  | { readonly kind: 'remove-skill'; readonly dir: string }
  | { readonly kind: 'add-row'; readonly id: string; readonly name: string }
  | {
      readonly kind: 'set-row'
      readonly id: string
      readonly name: string
      readonly key: string
      /** The YAML text of the value, one line, already checked by the caller. */
      readonly value: string
    }
  | { readonly kind: 'remove-row'; readonly id: string }
  | { readonly kind: 'remove-scalar'; readonly key: string }
  | { readonly kind: 'remove-row-key'; readonly id: string; readonly key: string }

export type EditErrorCode = 'inline-value' | 'no-such-item' | 'no-such-row' | 'duplicate-row'

export interface EditError {
  readonly code: EditErrorCode
  /** The key, directory or row id the caller named, so it can say which one it was. */
  readonly about: string
}

export interface Edited {
  readonly text: string
  readonly changed: boolean
}

const refuse = (code: EditErrorCode, about: string): Effect.Effect<never, EditError> =>
  Effect.fail({ code, about })

/** A file that ends with a newline is its lines without the empty tail. */
const linesOf = (text: string): Array<string> => {
  const all = text.split('\n')
  return all[all.length - 1] === '' ? all.slice(0, -1) : all
}

const render = (lines: ReadonlyArray<string>): string =>
  lines.length === 0 ? '' : lines.join('\n') + '\n'

const same = (before: ReadonlyArray<string>, after: ReadonlyArray<string>): boolean =>
  before.length === after.length && before.every((line, index) => line === after[index])

/** The file style for a plain name: bare when YAML reads it back as the same text. */
const scalar = (value: string): string =>
  /^[A-Za-z0-9._/~-]+$/.test(value) && readScalar(value) === value
    ? value
    : "'" + value.replace(/'/g, "''") + "'"

const scalarText = (value: string | number): string =>
  typeof value === 'number' ? String(value) : scalar(value)

const readScalar = (raw: string): string | undefined => {
  try {
    const parsed = parse(raw)
    return typeof parsed === 'string' ? parsed : undefined
  } catch {
    return undefined
  }
}

const without = (lines: ReadonlyArray<string>, at: number): Array<string> =>
  lines.filter((_, index) => index !== at)

const insertAfter = (
  lines: ReadonlyArray<string>,
  at: number,
  added: ReadonlyArray<string>,
): Array<string> => [...lines.slice(0, at + 1), ...added, ...lines.slice(at + 1)]

const replaceAt = (lines: ReadonlyArray<string>, at: number, line: string): Array<string> =>
  lines.map((old, index) => (index === at ? line : old))

/** The block under a top-level key: the key line plus every blank or indented line after it. */
interface Block {
  readonly keyAt: number
  readonly end: number
  /** What sits on the key line itself, when something does. */
  readonly inline: string | undefined
}

const blockOf = (lines: ReadonlyArray<string>, key: string): Block | undefined => {
  const keyAt = lines.findIndex((line) => new RegExp('^' + key + '\\s*:').test(line))
  if (keyAt === -1) return undefined
  const onKeyLine = lines[keyAt]!.slice(lines[keyAt]!.indexOf(':') + 1).trim()
  let end = keyAt + 1
  while (end < lines.length && (lines[end]!.trim() === '' || /^\s/.test(lines[end]!))) end++
  return { keyAt, end, inline: onKeyLine === '' ? undefined : onKeyLine }
}

/** The last line of a range that holds something, so a new item lands under it. */
const lastHeld = (lines: ReadonlyArray<string>, from: number, end: number): number => {
  for (let at = end - 1; at > from; at--) if (lines[at]!.trim() !== '') return at
  return from
}

/** Drops the key line when the block under it no longer holds anything. */
const dropEmptyBlock = (
  lines: Array<string>,
  key: string,
  holds: (block: Block) => boolean,
): Array<string> => {
  const block = blockOf(lines, key)
  return block !== undefined && !holds(block) ? without(lines, block.keyAt) : lines
}

const itemAt = (lines: ReadonlyArray<string>, block: Block, dir: string): number => {
  for (let at = block.keyAt + 1; at < block.end; at++) if (itemText(lines[at]!) === dir) return at
  return -1
}

const itemText = (line: string): string | undefined => {
  const match = /^\s*-\s*(.+?)\s*$/.exec(line)
  return match === null ? undefined : readScalar(match[1]!)
}

const holdsItems = (lines: ReadonlyArray<string>, block: Block): boolean => {
  for (let at = block.keyAt + 1; at < block.end; at++) {
    if (itemText(lines[at]!) !== undefined) return true
  }
  return false
}

const addSkill = (
  lines: ReadonlyArray<string>,
  dir: string,
): Effect.Effect<Array<string>, EditError> => {
  const block = blockOf(lines, 'skills')
  if (block === undefined) return Effect.succeed([...lines, 'skills:', '  - ' + scalar(dir)])
  if (block.inline !== undefined) return refuse('inline-value', 'skills')
  if (itemAt(lines, block, dir) !== -1) return Effect.succeed([...lines])
  return Effect.succeed(
    insertAfter(lines, lastHeld(lines, block.keyAt, block.end), ['  - ' + scalar(dir)]),
  )
}

const removeSkill = (
  lines: ReadonlyArray<string>,
  dir: string,
): Effect.Effect<Array<string>, EditError> => {
  const block = blockOf(lines, 'skills')
  const at = block === undefined ? -1 : itemAt(lines, block, dir)
  if (at === -1) return refuse('no-such-item', dir)
  const next = without(lines, at)
  return Effect.succeed(dropEmptyBlock(next, 'skills', (rest) => holdsItems(next, rest)))
}

/** A row of the plugins block: the `- id:` line and everything under it, however indented. */
interface Row {
  readonly start: number
  readonly end: number
  readonly indent: string
}

const ROW = /^(\s*)-\s*id\s*:\s*(.*)$/

const rowsIn = (lines: ReadonlyArray<string>, block: Block): ReadonlyArray<Row> => {
  const starts: Array<number> = []
  for (let at = block.keyAt + 1; at < block.end; at++) if (ROW.test(lines[at]!)) starts.push(at)
  return starts.map((start, index) => ({
    start,
    end: starts[index + 1] ?? block.end,
    indent: ROW.exec(lines[start]!)![1]!,
  }))
}

const rowId = (line: string): string | undefined => readScalar(ROW.exec(line)![2]!)

const rowOf = (lines: ReadonlyArray<string>, block: Block, id: string): Row | undefined =>
  rowsIn(lines, block).find((row) => rowId(lines[row.start]!) === id)

const rowLines = (id: string, name: string): ReadonlyArray<string> => [
  '  - id: ' + scalar(id),
  '    name: ' + scalar(name),
]

/** The line of a key that sits directly under the row, at the row's child indent. */
const childKeyAt = (lines: ReadonlyArray<string>, row: Row, key: string): number => {
  const pattern = new RegExp('^' + row.indent + '  ' + key + '\\s*:')
  for (let at = row.start + 1; at < row.end; at++) if (pattern.test(lines[at]!)) return at
  return -1
}

const addRow = (
  lines: ReadonlyArray<string>,
  id: string,
  name: string,
): Effect.Effect<Array<string>, EditError> => {
  const block = blockOf(lines, 'plugins')
  if (block === undefined) return Effect.succeed([...lines, 'plugins:', ...rowLines(id, name)])
  if (block.inline !== undefined) return refuse('inline-value', 'plugins')
  if (rowOf(lines, block, id) !== undefined) return refuse('duplicate-row', id)
  return Effect.succeed(
    insertAfter(lines, lastHeld(lines, block.keyAt, block.end), rowLines(id, name)),
  )
}

const setRowKey = (
  lines: ReadonlyArray<string>,
  row: Row,
  key: string,
  value: string,
): Array<string> => {
  const at = childKeyAt(lines, row, key)
  const written = row.indent + '  ' + key + ': ' + value
  return at === -1
    ? insertAfter(lines, childKeyAt(lines, row, 'name'), [written])
    : replaceAt(lines, at, written)
}

const configKeyAt = (
  lines: ReadonlyArray<string>,
  row: Row,
  configAt: number,
  key: string,
): number => {
  const pattern = new RegExp('^' + row.indent + '    ' + key + '\\s*:')
  for (let at = configAt + 1; at < row.end; at++) {
    if (!(lines[at]!.trim() === '' || lines[at]!.startsWith(row.indent + '    '))) break
    if (pattern.test(lines[at]!)) return at
  }
  return -1
}

const setConfigKey = (
  lines: ReadonlyArray<string>,
  row: Row,
  key: string,
  value: string,
): Array<string> => {
  const written = row.indent + '    ' + key + ': ' + value
  const configAt = childKeyAt(lines, row, 'config')
  if (configAt === -1) {
    return insertAfter(lines, row.end - 1, [row.indent + '  config:', written])
  }
  const at = configKeyAt(lines, row, configAt, key)
  return at === -1
    ? insertAfter(lines, lastHeld(lines, configAt, configEnd(lines, row, configAt)), [written])
    : replaceAt(lines, at, written)
}

/** The config sub-block: the lines deeper than the config line itself. */
const configEnd = (lines: ReadonlyArray<string>, row: Row, configAt: number): number => {
  let end = configAt + 1
  while (
    end < row.end &&
    (lines[end]!.trim() === '' || lines[end]!.startsWith(row.indent + '    '))
  ) {
    end++
  }
  return end
}

const setRow = (
  lines: ReadonlyArray<string>,
  edit: Extract<SettingsEdit, { kind: 'set-row' }>,
): Effect.Effect<Array<string>, EditError> =>
  Effect.gen(function* () {
    const block = blockOf(lines, 'plugins')
    if (block !== undefined && block.inline !== undefined)
      return yield* refuse('inline-value', 'plugins')
    const withRow =
      block !== undefined && rowOf(lines, block, edit.id) !== undefined
        ? [...lines]
        : yield* addRow(lines, edit.id, edit.name)
    const row = rowOf(withRow, blockOf(withRow, 'plugins')!, edit.id)!
    return edit.key === 'disabled'
      ? setRowKey(withRow, row, edit.key, edit.value)
      : setConfigKey(withRow, row, edit.key, edit.value)
  })

const removeRow = (
  lines: ReadonlyArray<string>,
  id: string,
): Effect.Effect<Array<string>, EditError> => {
  const block = blockOf(lines, 'plugins')
  const row = block === undefined ? undefined : rowOf(lines, block, id)
  if (row === undefined) return refuse('no-such-row', id)
  const next = [...lines.slice(0, row.start), ...lines.slice(row.end)]
  return Effect.succeed(dropEmptyBlock(next, 'plugins', (rest) => rowsIn(next, rest).length > 0))
}

/** Drops a top-level key, so a value the file set returns to the layer beneath it. */
const removeScalar = (
  lines: ReadonlyArray<string>,
  key: string,
): Effect.Effect<Array<string>, EditError> => {
  const block = blockOf(lines, key)
  return Effect.succeed(block === undefined ? [...lines] : without(lines, block.keyAt))
}

/** Drops one key under a row's config, so a later layer's value takes over again. */
const removeRowKey = (
  lines: ReadonlyArray<string>,
  id: string,
  key: string,
): Effect.Effect<Array<string>, EditError> => {
  const block = blockOf(lines, 'plugins')
  const row = block === undefined ? undefined : rowOf(lines, block, id)
  if (row === undefined) return refuse('no-such-row', id)
  const configAt = childKeyAt(lines, row, 'config')
  const at = configAt === -1 ? -1 : configKeyAt(lines, row, configAt, key)
  return Effect.succeed(at === -1 ? [...lines] : without(lines, at))
}

/** Replaces a whole top-level list, comments under the old one included. */
const setList = (
  lines: ReadonlyArray<string>,
  key: string,
  items: ReadonlyArray<string>,
): Array<string> => {
  const written =
    items.length === 0 ? [] : [key + ':', ...items.map((item) => '  - ' + scalar(item))]
  const block = blockOf(lines, key)
  if (block === undefined) return [...lines, ...written]
  const end = lastHeld(lines, block.keyAt, block.end) + 1
  return [...lines.slice(0, block.keyAt), ...written, ...lines.slice(end)]
}

type KeyEdit = Extract<SettingsEdit, { kind: 'set-scalar' | 'set-list' | 'remove-scalar' }>
type RowEdit = Extract<
  SettingsEdit,
  { kind: 'add-row' | 'set-row' | 'remove-row' | 'remove-row-key' }
>
/** The edits that only touch a top-level key, or the block under it. */
const applyKeyEdit = (
  lines: ReadonlyArray<string>,
  edit: KeyEdit,
): Effect.Effect<Array<string>, EditError> => {
  if (edit.kind === 'set-scalar') {
    const written = edit.key + ': ' + scalarText(edit.value)
    const at = lines.findIndex((line) => new RegExp('^' + edit.key + '\\s*:').test(line))
    return Effect.succeed(at === -1 ? [...lines, written] : replaceAt(lines, at, written))
  }
  if (edit.kind === 'set-list') return Effect.succeed(setList(lines, edit.key, edit.items))
  return removeScalar(lines, edit.key)
}

/** The edits that add, change, or drop one plugin row. */
const applyRowEdit = (
  lines: ReadonlyArray<string>,
  edit: RowEdit,
): Effect.Effect<Array<string>, EditError> => {
  switch (edit.kind) {
    case 'add-row':
      return addRow(lines, edit.id, edit.name)
    case 'set-row':
      return setRow(lines, edit)
    case 'remove-row':
      return removeRow(lines, edit.id)
    case 'remove-row-key':
      return removeRowKey(lines, edit.id, edit.key)
  }
}

const apply = (
  lines: ReadonlyArray<string>,
  edit: SettingsEdit,
): Effect.Effect<Array<string>, EditError> => {
  if (edit.kind === 'add-skill') return addSkill(lines, edit.dir)
  if (edit.kind === 'remove-skill') return removeSkill(lines, edit.dir)
  if (
    edit.kind === 'add-row' ||
    edit.kind === 'set-row' ||
    edit.kind === 'remove-row' ||
    edit.kind === 'remove-row-key'
  ) {
    return applyRowEdit(lines, edit)
  }
  return applyKeyEdit(lines, edit)
}

/** Applies one edit to the settings text; the caller writes the result when it changed. */
export function applyEdit(text: string, edit: SettingsEdit): Effect.Effect<Edited, EditError> {
  const before = linesOf(text)
  return Effect.map(apply(before, edit), (lines) => ({
    text: same(before, lines) ? text : render(lines),
    changed: !same(before, lines),
  }))
}

/** The key's block as the file holds it, so a command can show what it wrote. */
export function blockText(text: string, key: string): string {
  const lines = linesOf(text)
  const block = blockOf(lines, key)
  if (block === undefined) return ''
  const end = lastHeld(lines, block.keyAt, block.end)
  return lines.slice(block.keyAt, end + 1).join('\n') + '\n'
}
