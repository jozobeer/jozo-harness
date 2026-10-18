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
import {
  completedReference,
  referenceTokenAt,
  referencesFor,
  type ReferenceToken,
} from '../../src/ui/references.ts'
import type { SessionStore } from '../store.ts'
import { Button } from './ui/button.tsx'

/** How long the composer waits after the last key before it asks for files. */
const REFERENCE_ASK_DELAY = 150

/** The composer grows with its draft, up to the height of a page. */
const grow = (node: HTMLTextAreaElement): void => {
  node.style.height = 'auto'
  node.style.height = Math.min(node.scrollHeight, 220) + 'px'
}

/** The up arrow that sends, drawn here so the page carries no icon package. */
const SendIcon = () => (
  <svg class="action-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path d="M8 2.5 13 7.5 9.2 7.5 9.2 13.5 6.8 13.5 6.8 7.5 3 7.5Z" fill="currentColor" />
  </svg>
)

/** The square that stops the run, drawn the same way. */
const StopIcon = () => (
  <svg class="action-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <rect x="3.5" y="3.5" width="9" height="9" rx="2" fill="currentColor" />
  </svg>
)

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

/** The files one @word names, above the input. */
const Reference = (props: {
  paths: ReadonlyArray<string>
  answered: boolean
  selected: number
  onSelect: (index: number) => void
  onAccept: (path: string) => void
}) => (
  <div
    id="reference-list"
    class="command-list"
    role="listbox"
    aria-label="the files this word names"
  >
    <Show when={props.answered} fallback={<div class="card-hint">reading the files…</div>}>
      <Show when={props.paths.length > 0} fallback={<div class="card-hint">no file matches</div>}>
        <For each={props.paths}>
          {(path, index) => (
            <button
              type="button"
              role="option"
              class="command-option"
              data-reference={path}
              aria-selected={index() === props.selected}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => props.onSelect(index())}
              onClick={() => props.onAccept(path)}
            >
              <span class="command-name">{'@' + path}</span>
            </button>
          )}
        </For>
      </Show>
    </Show>
  </div>
)

/** The input, and what sits above it: waiting input and the thing to answer. */
export const Composer = (props: { store: SessionStore }) => {
  let textarea: HTMLTextAreaElement | undefined
  /** The slash word the popup belongs to; undefined closes it. */
  const [token, setToken] = createSignal<CommandToken | undefined>()
  /** The @word the file popup belongs to; undefined closes it. */
  const [reference, setReference] = createSignal<ReferenceToken | undefined>()
  const [selected, setSelected] = createSignal(0)
  /** The one timer that waits for the typing to stop before files are read. */
  let asking: ReturnType<typeof setTimeout> | undefined
  const stopAsking = (): void => {
    if (asking !== undefined) clearTimeout(asking)
    asking = undefined
  }
  onCleanup(stopAsking)

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

  /** The files the open @word names, once the session has answered that word. */
  const referencePaths = (): ReadonlyArray<string> => {
    const found = reference()
    return found === undefined
      ? []
      : referencesFor(props.store.state().files, props.store.state().sessionId, found)
  }

  /** Whether the open @word has an answer yet; while it has none the popup says it is reading. */
  const referenceAnswered = (): boolean => {
    const found = reference()
    const known = props.store.state().files
    return (
      found !== undefined &&
      known !== undefined &&
      known.sessionId === props.store.state().sessionId &&
      known.query === found.query
    )
  }

  /** Waits for the typing to stop, then reads the files the word names. */
  const askFiles = (found: ReferenceToken): void => {
    stopAsking()
    if (found.query === '') return
    const known = props.store.state().files
    if (
      known !== undefined &&
      known.sessionId === props.store.state().sessionId &&
      known.query === found.query
    ) {
      return
    }
    asking = setTimeout(() => {
      asking = undefined
      props.store.askFiles(found.query)
    }, REFERENCE_ASK_DELAY)
  }

  /**
   * Reads the word under the caret again. A command is the first word of a
   * line; an @word may sit anywhere. The command list belongs to the session on
   * screen, so it is read the first time a slash is typed.
   */
  const refresh = (node: HTMLTextAreaElement): void => {
    const caret = node.selectionStart ?? 0
    const command = commandTokenAt(node.value, caret)
    setSelected(0)
    if (command !== undefined) {
      stopAsking()
      setReference(undefined)
      setToken(command)
      if (props.store.state().commands === undefined) props.store.askCommands()
      return
    }
    setToken(undefined)
    const found = referenceTokenAt(node.value, caret)
    // A bare @ names nothing yet, so it opens no popup and walks no tree.
    if (found === undefined || found.query === '') {
      stopAsking()
      setReference(undefined)
      return
    }
    setReference(found)
    askFiles(found)
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

  /** Inserts @path where the @word was, as text the model reads. */
  const acceptReference = (path: string): void => {
    const node = textarea
    const found = reference()
    if (node === undefined || found === undefined) return
    const next = completedReference(node.value, found, path)
    props.store.setDraft(next.text)
    node.value = next.text
    grow(node)
    stopAsking()
    setReference(undefined)
    node.focus()
    node.setSelectionRange(next.caret, next.caret)
  }

  /** How many rows the open popup offers; the two popups never open together. */
  const completionLength = (): number =>
    token() !== undefined ? candidates().length : referencePaths().length

  /** Moves the selection one row, when the key is an arrow. */
  const moveSelection = (event: KeyboardEvent): boolean => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return false
    event.preventDefault()
    const step = event.key === 'ArrowDown' ? 1 : -1
    setSelected(movedCommandIndex(selected(), step, completionLength()))
    return true
  }

  /** Closes the popup, when the key is Escape. */
  const dismissCompletion = (event: KeyboardEvent): boolean => {
    if (event.key !== 'Escape') return false
    event.preventDefault()
    stopAsking()
    setToken(undefined)
    setReference(undefined)
    return true
  }

  /** Puts the selected command or path into the line; no candidate means nothing to put. */
  const acceptChosen = (): void => {
    if (token() !== undefined) {
      const chosen = candidates()[selected()]
      if (chosen !== undefined) accept(chosen.name)
      return
    }
    const path = referencePaths()[selected()]
    if (path !== undefined) acceptReference(path)
  }

  /** Accepts the selected candidate on Tab or Enter; the line is not sent yet. */
  const acceptCompletion = (event: KeyboardEvent): boolean => {
    const accepting = event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)
    if (!accepting || (token() === undefined && reference() === undefined)) return false
    event.preventDefault()
    acceptChosen()
    return true
  }

  const takeover = (): boolean =>
    props.store.state().conversation.approval !== undefined ||
    props.store.state().conversation.ask !== undefined

  /** Whether the open session has a turn to stop; idle makes Stop a disabled square. */
  const running = (): boolean => props.store.state().conversation.running

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
        <Show when={reference()}>
          {(_found) => (
            <Reference
              paths={referencePaths()}
              answered={referenceAnswered()}
              selected={selected()}
              onSelect={setSelected}
              onAccept={acceptReference}
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
          onBlur={() => {
            stopAsking()
            setToken(undefined)
            setReference(undefined)
          }}
          onKeyDown={(event) => {
            // An IME owns the keys while it composes: Enter confirms the conversion,
            // it does not accept a candidate or send the line.
            if (event.isComposing) return
            if (
              (token() !== undefined || reference() !== undefined) &&
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
          <Button
            id="send"
            size="icon"
            variant={takeover() ? 'default' : 'primary'}
            type="submit"
            aria-label="Send the message"
            title="Send the message (Enter)"
          >
            <SendIcon />
          </Button>
          <Button
            id="cancel"
            size="icon"
            type="button"
            aria-label="Stop the run"
            title="Stop the run"
            disabled={!running()}
            onClick={() => props.store.send({ kind: 'cancel' })}
          >
            <StopIcon />
          </Button>
        </div>
      </form>
    </footer>
  )
}
