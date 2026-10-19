import { For, Show, createMemo, createSignal } from 'solid-js'
import {
  changesOf,
  diffRowsOf,
  fileChangesOf,
  foldRows,
  hunksOf,
  pathInWorkspace,
  type ChangeFragment,
  type DiffLine,
  type DiffRow,
} from '../../src/ui/diff.ts'
import type { SessionStore } from '../store.ts'

/** The `+n` and `−n` of a file, a change, or the whole pane. */
const Counts = (props: { added: number; removed: number }) => (
  <span class="review-counts">
    <span class="review-add">{'+' + String(props.added)}</span>
    <span class="review-del">{'−' + String(props.removed)}</span>
  </span>
)

/** One changed line, with the number it had on each side and the sign that says which. */
const Line = (props: { line: DiffLine }) => (
  <div class={'diff-line ' + (props.line.kind === 'del' ? 'diff-del' : 'diff-add')}>
    <span class="diff-gutter">
      {props.line.oldLine === undefined ? '' : String(props.line.oldLine)}
    </span>
    <span class="diff-gutter">
      {props.line.newLine === undefined ? '' : String(props.line.newLine)}
    </span>
    <span class="diff-sign">{props.line.kind === 'del' ? '−' : '+'}</span>
    <span class="diff-text">{props.line.text}</span>
  </div>
)

/** One row of a diff: a hunk header, a line with both gutters, or the gap between hunks. */
const Row = (props: { row: DiffRow }) => {
  const row = props.row
  if (row.kind === 'hunk') return <div class="diff-hunk">{row.header}</div>
  if (row.kind === 'gap')
    return (
      <div class="diff-gap" aria-hidden="true">
        ⋯
      </div>
    )
  return <Line line={row} />
}

/**
 * One change as a diff. A diff longer than the fold keeps its head and its tail
 * and says how many rows it hides; the reader opens it when the middle matters.
 */
const Edit = (props: { edit: ChangeFragment; wrap: boolean }) => {
  const [open, setOpen] = createSignal(false)
  const rows = () => diffRowsOf(hunksOf([props.edit]))
  const folded = () => foldRows(rows())
  const long = () => folded().hidden > 0
  const middle = () =>
    long() && open() ? rows().slice(folded().head.length, rows().length - folded().tail.length) : []
  return (
    <section class="edit">
      <div class="edit-head">
        <span>{props.edit.tool + ' · turn ' + String(props.edit.turn)}</span>
        <span class="edit-result">{props.edit.result}</span>
      </div>
      <div class={'diff' + (props.wrap ? ' wrap' : '')}>
        <For each={folded().head}>{(row) => <Row row={row} />}</For>
        <Show when={long()}>
          <button
            class="diff-fold"
            type="button"
            onClick={() => setOpen(!open())}
            aria-expanded={open()}
          >
            {open() ? 'Fold the middle' : 'Show ' + String(folded().hidden) + ' more lines'}
          </button>
        </Show>
        <For each={middle()}>{(row) => <Row row={row} />}</For>
        <For each={folded().tail}>{(row) => <Row row={row} />}</For>
      </div>
    </section>
  )
}

/**
 * The session's changes, file by file: what it wrote with its `+n`/`−n`, and
 * the diff of the file the reader picked, each call where it happened.
 */
export const Review = (props: { store: SessionStore; path: string | undefined }) => {
  const [wrap, setWrap] = createSignal(false)
  const turns = createMemo(() => props.store.state().trace)
  const cwd = createMemo(() => props.store.state().info.cwd)
  const files = createMemo(() => fileChangesOf(turns(), cwd()))
  const wanted = createMemo(() =>
    props.path === undefined ? undefined : pathInWorkspace(cwd(), props.path),
  )
  const picked = () => files().find((file) => file.path === wanted()) ?? files()[0]
  const total = () =>
    files().reduce(
      (sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }),
      { added: 0, removed: 0 },
    )
  return (
    <>
      <h2 class="pane-title">Changes</h2>
      <Show
        when={files().length > 0}
        fallback={<div class="run-empty">this session has not written a file</div>}
      >
        <div class="review-tools">
          <span class="review-total">
            <Counts added={total().added} removed={total().removed} />
            <span class="review-file-edits">
              {String(files().length) + (files().length === 1 ? ' file' : ' files')}
            </span>
          </span>
          <button
            class="review-wrap"
            type="button"
            aria-pressed={wrap()}
            onClick={() => setWrap(!wrap())}
          >
            wrap
          </button>
        </div>
        <nav class="review-files" aria-label="Changed files">
          <For each={files()}>
            {(file) => (
              <button
                class={'review-file' + (file.path === picked()?.path ? ' active' : '')}
                type="button"
                onClick={() => props.store.showPane({ kind: 'changes', path: file.path })}
              >
                <span class="review-file-path">{file.path}</span>
                <span class="review-file-edits">
                  {String(file.edits) + (file.edits === 1 ? ' edit' : ' edits')}
                </span>
                <Counts added={file.added} removed={file.removed} />
              </button>
            )}
          </For>
        </nav>
        <Show when={picked()}>
          {(file) => (
            <For each={changesOf(turns(), file().path, cwd())}>
              {(edit) => <Edit edit={edit} wrap={wrap()} />}
            </For>
          )}
        </Show>
      </Show>
    </>
  )
}
