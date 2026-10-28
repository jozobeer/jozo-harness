import { Show, createMemo } from 'solid-js'
import { boardOf } from '../../src/ui/board.ts'
import { useTranslate } from '../i18n.ts'
import { hintOf } from '../lib.ts'
import type { SessionStore } from '../store.ts'

/** The strip along the top: the connection, where the session runs, what happens next. */
export const Status = (props: { store: SessionStore; drawer: boolean; onDrawer: () => void }) => {
  const t = useTranslate()
  const state = () => props.store.state()
  /** An approval or a question waits on the reader: the one thing the strip should shout. */
  const waiting = (): boolean =>
    state().conversation.approval !== undefined || state().conversation.ask !== undefined
  /** The branch the workspace stands on; '' until the page read one or when it names none. */
  const branch = (): string => state().info.branch ?? ''
  /** How the whole fleet stands, so a wait in another session is seen from any of them. */
  const fleet = createMemo(() => boardOf(state().sessions, props.store.watched()))
  const hintClass = (): string =>
    'hint' + (state().problem !== '' ? ' error' : waiting() ? ' attention' : '')
  return (
    <>
      <button
        id="drawer-toggle"
        class={'drawer-toggle' + (fleet().waiting.length > 0 ? ' waiting' : '')}
        type="button"
        aria-label={t('drawer.sessions')}
        aria-controls="sidebar"
        aria-expanded={props.drawer}
        onClick={props.onDrawer}
      >
        ☰
      </button>
      <span class={'dot ' + (state().connected ? 'on' : 'off')} />
      <Show when={state().info.cwd !== ''}>
        {/* The strip clips the head of a long path; bdi keeps the path itself left to right. */}
        <span class="where" title={state().info.cwd}>
          <bdi>{state().info.cwd}</bdi>
        </span>
      </Show>
      <Show when={branch() !== ''}>
        {/* The branch is one word beside the path, so a long name is clipped, not wrapped. */}
        <span class="branch" title={'git branch ' + branch()}>
          <bdi>{branch()}</bdi>
        </span>
      </Show>
      <span class={hintClass()}>{hintOf(state(), t)}</span>
      <Show when={fleet().waiting.length > 0}>
        <span class="fleet waiting">
          {String(fleet().waiting.length) + ' ' + t('status.waiting')}
        </span>
      </Show>
    </>
  )
}
