import { For, Match, Show, Switch, createSignal, onCleanup, onMount } from 'solid-js'
import { plainText } from '@jozo-harness/ui-view'
import type { CommandView } from '../../src/shared/rpc.ts'
import {
  commandCandidates,
  commandTokenAt,
  completedCommand,
  movedCommandIndex,
  type CommandToken,
} from '../../src/ui/commands.ts'
import { renderMarkdown } from '../../src/ui/markdown.ts'
import type { SessionStore } from '../store.ts'
import { Button } from './ui/button.tsx'

/** The composer grows with its draft, up to the height of a page. */
const grow = (node: HTMLTextAreaElement): void => {
  node.style.height = 'auto'
  node.style.height = Math.min(node.scrollHeight, 220) + 'px'
}

/** What the human typed while a turn was running waits above the composer. */
const Queue = (props: { store: SessionStore }) => (
  <For each={props.store.state().run?.queued ?? []}>
    {(message) => (
      <div class="queued">
        <span class="queued-label">queued</span>
        <span class="queued-text">{plainText(message)}</span>
      </div>
    )}
  </For>
)

/**
 * The goal the session works toward, above the composer. Every button is only the
 * command the human would type, so the rules of a goal stay in one place.
 */
const GoalBar = (props: { store: SessionStore; onEdit: (objective: string) => void }) => {
  const goal = () => props.store.state().run?.goal
  const run = (text: string): void => props.store.send({ kind: 'submit', text })
  return (
    <Show when={goal()}>
      {(current) => (
        <section id="goal-bar" class="goal-bar" aria-label="the goal this session works toward">
          <div class="goal-line">
            <span class={'goal-phase ' + current().phase}>{current().phase}</span>
            <span class="goal-objective">{current().objective}</span>
            <span class="goal-rounds">
              {String(current().rounds) + '/' + String(current().maxRounds)}
            </span>
          </div>
          <div class="goal-actions">
            <Switch>
              <Match when={current().phase === 'active'}>
                <Button
                  type="button"
                  data-goal-action="pause"
                  title="stop the next round from starting"
                  onClick={() => run('/goal pause')}
                >
                  Pause
                </Button>
              </Match>
              <Match when={current().phase === 'paused'}>
                <Button
                  type="button"
                  data-goal-action="resume"
                  title="let the next round start again"
                  onClick={() => run('/goal resume')}
                >
                  Resume
                </Button>
              </Match>
            </Switch>
            <Button
              type="button"
              data-goal-action="edit"
              title="change the objective in the composer"
              onClick={() => props.onEdit(current().objective)}
            >
              Edit
            </Button>
            <Show when={current().phase !== 'complete'}>
              <Button
                type="button"
                data-goal-action="done"
                title="mark the objective achieved"
                onClick={() => run('/goal done')}
              >
                Done
              </Button>
            </Show>
          </div>
        </section>
      )}
    </Show>
  )
}

/** The two ways the page answers for the human: an approval, or a question. */
const Takeover = (props: { store: SessionStore }) => {
  const conversation = () => props.store.state().conversation
  return (
    <Switch>
      <Match when={conversation().approval}>
        {(approval) => (
          <section class="block approval takeover-card">
            <div class="approval-text">
              <strong>{'Approve ' + approval().tool + '?'}</strong>
              <Show when={approval().reason !== ''}>
                <span class="approval-reason">{' ' + approval().reason}</span>
              </Show>
            </div>
            <div class="approval-actions">
              <Button
                variant="primary"
                type="button"
                data-approve="true"
                data-call-id={approval().callId}
                onClick={() =>
                  props.store.send({
                    kind: 'approve',
                    callId: approval().callId,
                    approved: true,
                  })
                }
              >
                Allow
              </Button>
              <Button
                type="button"
                data-approve="false"
                data-call-id={approval().callId}
                onClick={() =>
                  props.store.send({
                    kind: 'approve',
                    callId: approval().callId,
                    approved: false,
                  })
                }
              >
                Deny
              </Button>
            </div>
            <div class="card-hint">or press y / n</div>
          </section>
        )}
      </Match>
      <Match when={conversation().ask}>
        {(ask) => (
          <section class="block takeover-card">
            <div
              class="takeover-text markdown"
              innerHTML={renderMarkdown(plainText(ask().question))}
            />
            <Show when={ask().options.length > 0}>
              <div class="ask-options">
                <For each={ask().options}>
                  {(option) => (
                    <button
                      type="button"
                      data-ask-id={ask().id}
                      data-answer={option}
                      onClick={() =>
                        props.store.send({ kind: 'answer', id: ask().id, answer: option })
                      }
                    >
                      {plainText(option)}
                    </button>
                  )}
                </For>
              </div>
            </Show>
            <div class="card-hint">or type an answer and press Enter</div>
          </section>
        )}
      </Match>
    </Switch>
  )
}

/**
 * The effort this session asks the provider for, chosen beside the model it
 * asks. Which words an endpoint takes is the endpoint's to say, so the choices
 * are the ones its adapter declares; the provider choosing is one of them.
 */
const Effort = (props: { store: SessionStore }) => {
  /** What the session asks for now; '' leaves the choice to the provider. */
  const current = (): string => props.store.state().run?.effort ?? ''

  const declared = (): ReadonlyArray<string> => props.store.state().run?.efforts ?? []

  /** The effort in effect when the declared words do not name it, so the choice never lies. */
  const extra = (): string | undefined => {
    const now = current()
    return now === '' || declared().includes(now) ? undefined : now
  }

  return (
    <Show when={props.store.state().run !== undefined}>
      <select
        id="seat-effort"
        class="seat-effort"
        title="the reasoning effort this session asks the provider for"
        aria-label="the reasoning effort this session asks the provider for"
        value={current()}
        onChange={(event) =>
          props.store.send({ kind: 'effort', effort: event.currentTarget.value })
        }
      >
        <option value="">default</option>
        <For each={declared()}>{(effort) => <option value={effort}>{effort}</option>}</For>
        <Show when={extra()}>{(effort) => <option value={effort()}>{effort()}</option>}</Show>
      </select>
    </Show>
  )
}

/**
 * The model this session asks, and the switch to another one the provider offers.
 * With nothing open yet it is the route a session opened now would start from, so
 * the model can be picked before the first message. Which models exist is the
 * endpoint's to say, so the list is read when the chip is opened and not on every
 * page load; the pick lands on the next request.
 */
const Model = (props: { store: SessionStore }) => {
  const [open, setOpen] = createSignal(false)
  let seat: HTMLDivElement | undefined

  /**
   * What the next request asks: the open session's own route, else the route a
   * session opened now would be built with.
   */
  const current = (): string => {
    const now = props.store.state()
    return now.sessionId === '' ? (now.settings?.model ?? '') : (now.run?.model ?? now.info.model)
  }

  const models = (): ReadonlyArray<string> | undefined => props.store.state().models

  const toggle = (): void => {
    const next = !open()
    setOpen(next)
    if (next && models() === undefined) props.store.askModels()
  }

  onMount(() => {
    // A list left open over the composer would sit in the way of typing.
    const onPointer = (event: MouseEvent): void => {
      if (!open() || seat?.contains(event.target as Node) === true) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    onCleanup(() => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    })
  })

  return (
    <Show when={current() !== ''}>
      <div
        class="seat-model"
        ref={(node) => {
          seat = node
        }}
      >
        <button
          id="seat-model"
          class="seat-chip"
          type="button"
          aria-expanded={open()}
          title="the model this session asks; pick another one here"
          onClick={toggle}
        >
          {current()}
        </button>
        <Show when={open()}>
          <div
            id="model-list"
            class="model-list"
            role="group"
            aria-label="the models this provider offers"
          >
            <Show when={models()} fallback={<div class="card-hint">reading the models…</div>}>
              {(routes) => (
                <>
                  <For each={routes()}>
                    {(route) => (
                      <button
                        class="model-option"
                        type="button"
                        aria-current={route === current()}
                        data-model={route}
                        onClick={() => {
                          props.store.chooseModel(route)
                          setOpen(false)
                        }}
                      >
                        {route}
                      </button>
                    )}
                  </For>
                  <div class="card-hint">
                    {props.store.state().sessionId === ''
                      ? 'the next session starts from it; the settings sheet keeps it for later runs'
                      : 'this session and the next ones; the settings sheet keeps it for later runs'}
                  </div>
                </>
              )}
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  )
}

/**
 * The + menu at the composer's left. Every item is only the command a human
 * would type; a word that wants input starts in the draft instead of sending a
 * request the page would have to guess at.
 */
const Plus = (props: { store: SessionStore; onStart: (text: string) => void }) => {
  const [open, setOpen] = createSignal(false)
  let menu: HTMLDivElement | undefined

  onMount(() => {
    const onPointer = (event: MouseEvent): void => {
      if (!open() || menu?.contains(event.target as Node) === true) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    onCleanup(() => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    })
  })

  const start = (text: string): void => {
    setOpen(false)
    props.onStart(text)
  }

  const send = (text: string): void => {
    setOpen(false)
    props.store.send({ kind: 'submit', text })
  }

  return (
    <div
      class="composer-plus"
      ref={(node) => {
        menu = node
      }}
    >
      <button
        id="composer-plus"
        class="plus-button"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open()}
        title="commands that shape this session"
        onClick={() => setOpen(!open())}
      >
        +
      </button>
      <Show when={open()}>
        <div
          id="plus-list"
          class="plus-list"
          role="menu"
          aria-label="the commands this menu starts"
        >
          <button
            type="button"
            role="menuitem"
            data-plus-action="goal"
            onClick={() => start('/goal ')}
          >
            Goal…
          </button>
          <button
            type="button"
            role="menuitem"
            data-plus-action="compact"
            onClick={() => send('/compact')}
          >
            Compact
          </button>
          <button
            type="button"
            role="menuitem"
            data-plus-action="model"
            onClick={() => start('/model ')}
          >
            Model…
          </button>
          <button
            type="button"
            role="menuitem"
            data-plus-action="effort"
            onClick={() => start('/effort ')}
          >
            Effort…
          </button>
        </div>
      </Show>
    </div>
  )
}

/** The list of commands a slash word is choosing from, above the input. */
const Completion = (props: {
  store: SessionStore
  token: CommandToken
  selected: number
  onSelect: (index: number) => void
  onAccept: (name: string) => void
}) => {
  const candidates = (): ReadonlyArray<CommandView> =>
    commandCandidates(props.store.state().commands ?? [], props.token)

  return (
    <div
      id="command-list"
      class="command-list"
      role="listbox"
      aria-label="the commands this session answers"
    >
      <Show
        when={props.store.state().commands}
        fallback={<div class="card-hint">reading the commands…</div>}
      >
        <Show
          when={candidates().length > 0}
          fallback={<div class="card-hint">no command matches</div>}
        >
          <For each={candidates()}>
            {(command, index) => (
              <button
                type="button"
                role="option"
                class="command-option"
                data-command={command.name}
                aria-selected={index() === props.selected}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => props.onSelect(index())}
                onClick={() => props.onAccept(command.name)}
              >
                <span class="command-name">{'/' + command.name}</span>
                <span class="command-kind">{command.kind}</span>
                <span class="command-summary">{command.summary}</span>
              </button>
            )}
          </For>
        </Show>
      </Show>
    </div>
  )
}

/** The input, and what sits above it: waiting input and the thing to answer. */
export const Composer = (props: { store: SessionStore }) => {
  let textarea: HTMLTextAreaElement | undefined
  /** The slash word the popup belongs to; undefined closes it. */
  const [token, setToken] = createSignal<CommandToken | undefined>()
  const [selected, setSelected] = createSignal(0)

  onMount(() => {
    // y and n answer a pending approval, as long as the composer does not have the keys.
    const onKey = (event: KeyboardEvent): void => {
      const approval = props.store.state().conversation.approval
      if (approval === undefined || document.activeElement === textarea) return
      const key = event.key.toLowerCase()
      if (key !== 'y' && key !== 'n') return
      event.preventDefault()
      props.store.send({ kind: 'approve', callId: approval.callId, approved: key === 'y' })
    }
    document.addEventListener('keydown', onKey)
    onCleanup(() => document.removeEventListener('keydown', onKey))
  })

  const send = (): void => {
    props.store.submit()
    if (textarea !== undefined) grow(textarea)
  }

  /** Puts a command in the composer, so its word is finished where it reads. */
  const start = (text: string): void => {
    props.store.setDraft(text)
    const node = textarea
    if (node === undefined) return
    node.value = text
    grow(node)
    node.focus()
    node.setSelectionRange(text.length, text.length)
  }

  /** The edit command, so the objective is changed where it reads. */
  const editGoal = (objective: string): void => start('/goal edit ' + objective)

  const candidates = (): ReadonlyArray<CommandView> => {
    const found = token()
    return found === undefined ? [] : commandCandidates(props.store.state().commands ?? [], found)
  }

  /**
   * Reads the word under the caret again. The list belongs to the session on
   * screen, so it is read the first time a slash is typed and dropped when the
   * page moves to another session.
   */
  const refresh = (node: HTMLTextAreaElement): void => {
    const found = commandTokenAt(node.value, node.selectionStart ?? 0)
    setToken(found)
    setSelected(0)
    if (found !== undefined && props.store.state().commands === undefined) props.store.askCommands()
  }

  const accept = (name: string): void => {
    const node = textarea
    const found = token()
    if (node === undefined || found === undefined) return
    const next = completedCommand(node.value, found, name)
    props.store.setDraft(next.text)
    node.value = next.text
    grow(node)
    setToken(undefined)
    node.focus()
    node.setSelectionRange(next.caret, next.caret)
  }

  /** Moves the selection one row, when the key is an arrow. */
  const moveSelection = (event: KeyboardEvent): boolean => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return false
    event.preventDefault()
    const step = event.key === 'ArrowDown' ? 1 : -1
    setSelected(movedCommandIndex(selected(), step, candidates().length))
    return true
  }

  /** Closes the popup, when the key is Escape. */
  const dismissCompletion = (event: KeyboardEvent): boolean => {
    if (event.key !== 'Escape') return false
    event.preventDefault()
    setToken(undefined)
    return true
  }

  /** Accepts the selected candidate on Tab or Enter; the line is not sent yet. */
  const acceptCompletion = (event: KeyboardEvent): boolean => {
    const enter = event.key === 'Enter' && !event.shiftKey
    if (event.key !== 'Tab' && !enter) return false
    event.preventDefault()
    const chosen = candidates()[selected()]
    if (chosen !== undefined) accept(chosen.name)
    return true
  }

  const takeover = (): boolean =>
    props.store.state().conversation.approval !== undefined ||
    props.store.state().conversation.ask !== undefined

  return (
    <footer data-takeover={takeover() ? 'true' : 'false'}>
      <GoalBar store={props.store} onEdit={editGoal} />
      <div id="queue">
        <Queue store={props.store} />
      </div>
      <div id="takeover">
        <Takeover store={props.store} />
      </div>
      <form
        id="composer"
        onSubmit={(event) => {
          event.preventDefault()
          send()
        }}
      >
        <Show when={token()}>
          {(found) => (
            <Completion
              store={props.store}
              token={found()}
              selected={selected()}
              onSelect={setSelected}
              onAccept={accept}
            />
          )}
        </Show>
        <textarea
          id="input"
          rows="1"
          placeholder="Message jozo-harness…  (Enter sends, Shift+Enter adds a line)"
          value={props.store.state().draft}
          ref={(node) => {
            textarea = node
          }}
          onInput={(event) => {
            props.store.setDraft(event.currentTarget.value)
            grow(event.currentTarget)
            refresh(event.currentTarget)
          }}
          onClick={(event) => refresh(event.currentTarget)}
          onBlur={() => setToken(undefined)}
          onKeyDown={(event) => {
            // An IME owns the keys while it composes: Enter confirms the conversion,
            // it does not accept a candidate or send the line.
            if (event.isComposing) return
            if (
              token() !== undefined &&
              (moveSelection(event) || dismissCompletion(event) || acceptCompletion(event))
            ) {
              return
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              send()
            }
          }}
        />
        <div class="actions">
          <Plus store={props.store} onStart={start} />
          <div id="seat">
            <Model store={props.store} />
            <Effort store={props.store} />
          </div>
          {/* While something waits on the reader, the card's button is the one in amber. */}
          <Button id="send" variant={takeover() ? 'default' : 'primary'} type="submit">
            Send
          </Button>
          <Button id="cancel" type="button" onClick={() => props.store.send({ kind: 'cancel' })}>
            Stop
          </Button>
        </div>
      </form>
    </footer>
  )
}
