import { For, Show, createEffect, createSignal, on } from 'solid-js'
import { treeOpen, treeRows, treeTruncated, type TreeRow } from '../../src/ui/tree.ts'
import { useTranslate } from '../i18n.ts'
import type { SessionStore } from '../store.ts'
import { Button } from './ui/button.tsx'
import { Icon } from './ui/icon.tsx'

/**
 * The workspace tree in the right pane. A folder is read when the reader opens
 * it, so a deep workspace costs one listing per folder they look at; a file is
 * read as a preview, and a path typed below opens one the tree has not scrolled
 * to.
 */
export const FileTree = (props: { store: SessionStore }) => {
  const t = useTranslate()
  const tree = () => props.store.state().tree
  const rows = () => treeRows(tree())
  const read = () => tree()?.folders.some((one) => one.path === '') === true
  const [typed, setTyped] = createSignal('')

  // The tree opens at the workspace root. The tab may be opened again after files
  // changed on disk, so every folder it already shows is read again with it.
  createEffect(
    on(
      () => props.store.state().sessionId,
      () => {
        props.store.openFolder('')
        props.store.refreshTree()
      },
    ),
  )

  const choose = (row: TreeRow): void => {
    if (row.kind === 'file') {
      props.store.previewPath(row.path)
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
          <Icon name="refresh" />
        </Button>
      </div>
      <form
        class="tree-open"
        onSubmit={(event) => {
          event.preventDefault()
          const path = typed().trim()
          if (path === '') return
          props.store.previewPath(path)
          setTyped('')
        }}
      >
        <input
          class="tree-path"
          type="text"
          value={typed()}
          placeholder={t('preview.placeholder')}
          aria-label={t('preview.path')}
          onInput={(event) => setTyped(event.currentTarget.value)}
        />
        <Button
          id="tree-open"
          type="submit"
          variant="quiet"
          size="icon"
          aria-label={t('preview.open')}
          title={t('preview.open')}
        >
          <Icon name="read" />
        </Button>
      </form>
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
                title={row.kind === 'file' ? t('tree.preview') : row.path}
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
