import { For, Show } from 'solid-js'
import type { BrowserState } from '../browser.ts'
import { useTranslate } from '../i18n.ts'

/**
 * The reader's own browser. It is deliberately not the session's browser tool:
 * the addresses, tabs, and frame never leave this component's state.
 */
export const BrowserPane = (props: { browser: BrowserState }) => {
  const t = useTranslate()
  const active = (id: number): boolean => props.browser.current()?.id === id
  return (
    <div class="browser">
      <form
        class="browser-bar"
        onSubmit={(event) => {
          event.preventDefault()
          props.browser.open()
        }}
      >
        <input
          class="browser-address"
          type="text"
          value={props.browser.address()}
          placeholder={t('browser.placeholder')}
          aria-label={t('browser.address')}
          onInput={(event) => props.browser.type(event.currentTarget.value)}
        />
        <button class="browser-open" type="submit">
          {t('browser.open')}
        </button>
        <Show when={props.browser.current()}>
          {(tab) => (
            <a class="browser-detach" href={tab().url} target="_blank" rel="noopener noreferrer">
              {t('browser.newTab')}
            </a>
          )}
        </Show>
      </form>
      <Show when={props.browser.problem() !== undefined}>
        <div class="browser-problem" role="alert">
          {t('browser.invalid')}
        </div>
      </Show>
      <Show when={props.browser.tabs().length > 0}>
        <div class="browser-tabs" role="tablist" aria-label={t('browser.tabs')}>
          <For each={props.browser.tabs()}>
            {(tab) => (
              <span class={'browser-tab' + (active(tab.id) ? ' active' : '')}>
                <button
                  class="browser-tab-name"
                  type="button"
                  role="tab"
                  aria-selected={active(tab.id)}
                  title={tab.url}
                  onClick={() => props.browser.switchTo(tab.id)}
                >
                  {tab.host}
                </button>
                <button
                  class="browser-tab-close"
                  type="button"
                  aria-label={t('browser.close') + ' ' + tab.host}
                  onClick={() => props.browser.close(tab.id)}
                >
                  ×
                </button>
              </span>
            )}
          </For>
        </div>
      </Show>
      <Show
        when={props.browser.current()}
        fallback={<div class="browser-empty">{t('browser.empty')}</div>}
      >
        {(tab) => (
          <iframe
            class="browser-frame"
            src={tab().url}
            title={tab().host}
            referrerpolicy="no-referrer"
          />
        )}
      </Show>
      <p class="browser-refused">{t('browser.refused')}</p>
    </div>
  )
}
