import { Match, Show, Switch } from 'solid-js'
import type { WorkspacePreview } from '../../src/shared/rpc.ts'
import { renderMarkdown } from '../../src/ui/markdown.ts'
import { useTranslate } from '../i18n.ts'
import type { SessionStore } from '../store.ts'
import { Button } from './ui/button.tsx'

/** The URL the browser reads one preview's bytes from; JSON carries them as base64. */
const dataOf = (view: WorkspacePreview): string =>
  'data:' + view.mediaType + ';base64,' + (view.data ?? '')

/**
 * The right pane's file preview. It draws what the server read through the
 * workspace gate: Markdown and source as text, an image or a PDF from its bytes,
 * and HTML in a frame with no scripts, so a file can be read without the page
 * running it. A file it cannot show says why in place of the body.
 */
export const FilePreview = (props: { store: SessionStore; path: string }) => {
  const t = useTranslate()
  const preview = () => {
    const now = props.store.state().preview
    return now?.path === props.path ? now : undefined
  }
  const view = () => preview()?.view
  const problem = () => preview()?.problem ?? ''
  const reading = () => preview() !== undefined && view() === undefined && problem() === ''

  return (
    <div class="preview">
      <div class="preview-head">
        <code class="preview-path">{props.path}</code>
        <Show when={view()}>
          {(shown) => (
            <span class="preview-meta">
              {String(shown().size) + ' ' + t('preview.bytes')}
              <Button
                id="preview-reference"
                type="button"
                variant="quiet"
                onClick={() => props.store.referencePath(props.path)}
              >
                {t('preview.reference')}
              </Button>
            </span>
          )}
        </Show>
      </div>
      <Show when={preview() === undefined}>
        <p class="preview-hint">{t('preview.choose')}</p>
      </Show>
      <Show when={reading()}>
        <p class="preview-hint">{t('preview.reading')}</p>
      </Show>
      <Show when={problem() !== ''}>
        <p class="preview-problem">{problem()}</p>
      </Show>
      <Show when={view()}>
        {(shown) => (
          <>
            <Show when={shown().truncated}>
              <p class="preview-hint">{t('preview.truncated')}</p>
            </Show>
            <Switch>
              <Match when={shown().kind === 'markdown'}>
                <div
                  class="markdown preview-markdown"
                  innerHTML={renderMarkdown(shown().text ?? '')}
                />
              </Match>
              <Match when={shown().kind === 'html'}>
                <iframe
                  class="preview-frame"
                  sandbox=""
                  title={props.path}
                  srcdoc={shown().text ?? ''}
                />
              </Match>
              <Match when={shown().kind === 'image'}>
                <img class="preview-image" src={dataOf(shown())} alt={props.path} />
              </Match>
              <Match when={shown().kind === 'pdf'}>
                <embed class="preview-pdf" type="application/pdf" src={dataOf(shown())} />
              </Match>
              <Match when={shown().kind === 'unsupported'}>
                <p class="preview-problem">{shown().reason}</p>
              </Match>
              <Match when={shown().kind === 'text'}>
                <pre class="preview-text">
                  <code>{shown().text ?? ''}</code>
                </pre>
              </Match>
            </Switch>
          </>
        )}
      </Show>
    </div>
  )
}
