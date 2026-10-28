import { For, Show, createEffect, on } from 'solid-js'
import { treeOpen, treeRows, treeTruncated, type TreeRow } from '../../src/ui/tree.ts'
import { useTranslate } from '../i18n.ts'
import type { SessionStore } from '../store.ts'
import { Button } from './ui/button.tsx'
import { Icon } from './ui/icon.tsx'

/**
 * The workspace tree in the right pane. A folder is read when the reader opens
 * it, so a deep workspace costs one listing per folder they look at; a file is
 * handed to the composer as an @ reference, which is the path the preview takes
 * until it exists.
 */
export const FileTree = (props: { store: SessionStore }) => {
  const t = useTranslate()
  const tree = () => props.store.state().tree
  const rows = () => treeRows(tree())
  const read = () => tree()?.folders.some((one) => one.path === '') === true

  // The tree opens at the workspace root: the first listing is the only one the
  // page asks for before the reader opens a folder.
  createEffect(
    on(
      () => props.store.state().sessionId,
      () => props.store.openFolder(''),
    ),
  )

  const choose = (row: TreeRow): void => {
    if (row.kind === 'file') {
      props.store.referencePath(row.path)
      return
    }
    if (treeOpen(tree(), row.path)) props.store.closeFolder(row.path)
    else props.store.openFolder(row.path)
  }

  return (
    <div class="tree">
      <div class="tree-head">
        <span class="tree-title">{t('tree.workspace')}</span>
        <Button
          id="tree-refresh"
          type="button"
          variant="quiet"
          size="icon"
          aria-label={t('tree.refresh')}
          title={t('tree.refresh')}
          onClick={() => props.store.refreshTree()}
        >
          <Icon name="changes" />
        </Button>
      </div>
      <ul class="tree-rows" role="tree" aria-label={t('tree.workspace')}>
        <For each={rows()}>
          {(row) => (
            <li
              class="tree-row"
              role="treeitem"
              aria-level={row.depth + 1}
              aria-expanded={row.kind === 'directory' ? treeOpen(tree(), row.path) : undefined}
            >
              <button
                type="button"
                class={'tree-name ' + row.kind}
                style={{ 'padding-left': 'calc(var(--s2) + ' + String(row.depth * 12) + 'px)' }}
                title={row.kind === 'file' ? t('tree.reference') : row.path}
                onClick={() => choose(row)}
              >
                <Icon name={row.kind === 'directory' ? 'folder' : 'read'} />
                <span class="tree-label">{row.name}</span>
              </button>
            </li>
          )}
        </For>
      </ul>
      <Show when={!read()}>
        <p class="tree-hint">{t('tree.reading')}</p>
      </Show>
      <Show when={read() && rows().length === 0}>
        <p class="tree-hint">{t('tree.empty')}</p>
      </Show>
      <Show when={treeTruncated(tree())}>
        <p class="tree-hint">{t('tree.truncated')}</p>
      </Show>
      <Show when={tree()?.problem}>
        {(problem) => <p class="tree-hint tree-problem">{problem()}</p>}
      </Show>
    </div>
  )
}
