import {
  For,
  Match,
  Show,
  Switch,
  Index,
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
  type JSX,
} from 'solid-js'
import { plainText } from '@jozo-harness/ui-view'
import type { SubmitMode } from '@jozo-harness/ui-protocol'
import type { CommandView } from '../../src/shared/rpc.ts'
import {
  commandCandidates,
  commandTokenAt,
  completedCommand,
  movedCommandIndex,
  type CommandToken,
} from '../../src/ui/commands.ts'
import { renderMarkdown } from '../../src/ui/markdown.ts'
import { Linkify } from './linkify.tsx'
import {
  completedReference,
  referenceTokenAt,
  referencesFor,
  type ReferenceToken,
} from '../../src/ui/references.ts'
import { watchWidth } from '../rail.ts'
import type { SessionStore } from '../store.ts'
import { acceleratedSend, oppositeMode, submitModeFor } from '../submission.ts'
import { Button } from './ui/button.tsx'
import { Fizz } from './ui/fizz.tsx'
import { GoalMark, roundsOf } from './ui/goal-mark.tsx'
import { Icon } from './ui/icon.tsx'
import { ContextRing } from './usage.tsx'

/** The one line a quote chip shows, however long the passage the reader selected. */
const quotePreview = (text: string): string => {
  const line = text.split('\n').find((part) => part.trim() !== '') ?? ''
  return line.length > 80 ? line.slice(0, 80) + '…' : line
}

/** How long the composer waits after the last key before it asks for files. */
const REFERENCE_ASK_DELAY = 150

/** The composer grows with its draft, up to the height of a page. */
const grow = (node: HTMLTextAreaElement): void => {
  node.style.height = 'auto'
  node.style.height = Math.min(node.scrollHeight, 220) + 'px'
}

/** Input waiting for its turn, each line labelled with where it is waiting. */
const Waiting = (props: { label: 'queued' | 'steering'; messages: ReadonlyArray<string> }) => (
  <For each={props.messages}>
    {(message) => (
      <div class={'queued ' + props.label}>
        <span class="queued-label">{props.label}</span>
        <span class="queued-text">
          <Linkify text={plainText(message)} />
        </span>
      </div>
    )}
  </For>
)

/**
 * What waits above the composer: a steer joins the running turn's next step,
 * while a queued line becomes a turn of its own, so the two are told apart.
 */
const Queue = (props: { store: SessionStore }) => (
  <>
    <Waiting label="steering" messages={props.store.state().run?.steering ?? []} />
    <Waiting label="queued" messages={props.store.state().run?.queued ?? []} />
  </>
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
            <span class={'goal-phase ' + current().phase}>
              <GoalMark phase={current().phase} />
              {current().phase}
            </span>
            <span class="goal-objective">{current().objective}</span>
            <span class="goal-rounds">{roundsOf(current().rounds, current().maxRounds)}</span>
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
            <Fizz />
            <div class="card-head">
              <strong>
                <Icon name="approval" />
                {'Approve · ' + approval().tool}
              </strong>
              <span class="card-keys">y / n</span>
            </div>
            <Show when={approval().reason !== ''}>
              <div class="approval-text">
                <span class="approval-reason">{approval().reason}</span>
              </div>
            </Show>
            <div class="approval-actions">
              <Button
                variant="foam"
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
                variant="rim"
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
          </section>
        )}
      </Match>
      <Match when={conversation().ask}>
        {(ask) => (
          <section class="block takeover-card">
            <Fizz />
            <div class="card-head">
              <strong>
                <Icon name="ask" />
                Question
              </strong>
              <span class="card-keys">type an answer, Enter</span>
            </div>
            <div
              class="takeover-text markdown"
              innerHTML={renderMarkdown(plainText(ask().question))}
            />
            <Show when={ask().options.length > 0}>
              <div class="ask-options">
                <For each={ask().options}>
                  {(option) => (
                    <Button
                      variant="scoop"
                      type="button"
                      data-ask-id={ask().id}
                      data-answer={option}
                      onClick={() =>
                        props.store.send({ kind: 'answer', id: ask().id, answer: option })
                      }
                    >
                      {plainText(option)}
                    </Button>
                  )}
                </For>
              </div>
            </Show>
          </section>
        )}
      </Match>
    </Switch>
  )
}

/**
 * The effort this session asks the provider for, chosen beside the model it
 * asks. Which words an endpoint takes is the endpoint's to say, so the choices
 * are the ones its adapter declares; the provider choosing is one of them. With
 * nothing open yet it is the effort a session opened now would start from, so
 * the seat keeps its line before the first message.
 */
const Effort = (props: { store: SessionStore }) => {
  /**
   * What the next request asks: the open session's own effort, else the run's
   * choice for a session opened now. '' leaves the choice to the provider.
   */
  const current = (): string => {
    const now = props.store.state()
    return now.sessionId === '' ? (now.settings?.effort ?? '') : (now.run?.effort ?? '')
  }

  const declared = (): ReadonlyArray<string> => {
    const now = props.store.state()
    return now.sessionId === '' ? (now.settings?.efforts ?? []) : (now.run?.efforts ?? [])
  }

  /** Whether the seat has the facts to show: the blank page's settings, or the open session's run. */
  const known = (): boolean => {
    const now = props.store.state()
    return now.sessionId === '' ? now.settings !== undefined : now.run !== undefined
  }

  /** The effort in effect when the declared words do not name it, so the choice never lies. */
  const extra = (): string | undefined => {
    const now = current()
    return now === '' || declared().includes(now) ? undefined : now
  }

  return (
    <Show when={known()}>
      <span class="seat-effort-field">
        <Icon name="effort" />
        <select
          id="seat-effort"
          class="seat-effort"
          title="the reasoning effort the next request asks for"
          aria-label="the reasoning effort the next request asks for"
          value={current()}
          onChange={(event) => props.store.chooseEffort(event.currentTarget.value)}
        >
          <option value="">default</option>
          <For each={declared()}>{(effort) => <option value={effort}>{effort}</option>}</For>
          <Show when={extra()}>{(effort) => <option value={effort()}>{effort()}</option>}</Show>
        </select>
      </span>
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
          <Icon name="model" />
          <span>{current()}</span>
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
const Plus = (props: {
  store: SessionStore
  onStart: (text: string) => void
  /** The seat's chips, when the composer is too narrow to keep them in the row. */
  seat?: (() => JSX.Element) | undefined
}) => {
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
        <Icon name="plus" />
      </button>
      <Show when={open()}>
        <div
          id="plus-list"
          class="plus-list"
          role="menu"
          aria-label="the commands this menu starts"
        >
          <Show when={props.seat}>{(draw) => <div class="plus-seat">{draw()()}</div>}</Show>
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

/** The files and sessions one @word names, above the input. */
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
    aria-label="the files and sessions this word names"
  >
    <Show when={props.answered} fallback={<div class="card-hint">reading the files…</div>}>
      <Show
        when={props.paths.length > 0}
        fallback={<div class="card-hint">no file or session matches</div>}
      >
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

/**
 * The mode Enter uses while a turn runs. It is a setting, so it stays where the
 * model and the effort are; the accelerated gesture asks for the other mode
 * without changing it.
 */
const BusyEnter = (props: {
  store: SessionStore
  mode: SubmitMode
  onChoose: (mode: SubmitMode) => void
}) => (
  <Show when={props.store.state().conversation.running}>
    <button
      id="busy-enter"
      class="seat-chip"
      type="button"
      aria-pressed={props.mode === 'steer'}
      title={
        'Enter while a turn runs sends ' +
        props.mode +
        '; Cmd/Ctrl+Enter sends the other. Click to switch.'
      }
      onClick={() => props.onChoose(oppositeMode(props.mode))}
    >
      {props.mode}
    </button>
  </Show>
)

/** Below this width the seat folds into + whatever it holds: a phone keeps the row for typing. */
const COMPACT_WIDTH = 560

/**
 * How far the row would run past its edge with every chip on one line. The seat
 * is read at its own width for the moment, then handed back to the row.
 */
const overflowOf = (row: HTMLElement): number => {
  const seat = row.querySelector<HTMLElement>('#seat')
  if (seat === null) return 0
  const kept = seat.style.cssText
  seat.style.cssText = kept + ';flex:none;width:max-content'
  const over = row.scrollWidth - row.clientWidth
  seat.style.cssText = kept
  return Math.max(0, over)
}

/** What the seat shows, so a longer model name or a new chip is measured again. */
const seatFactsOf = (state: ReturnType<SessionStore['state']>): string =>
  [
    state.run?.model,
    state.run?.effort,
    state.settings?.model,
    state.settings?.effort,
    state.info.model,
    state.conversation.running,
  ].join('|')

/** The input, and what sits above it: waiting input and the thing to answer. */
export const Composer = (props: {
  store: SessionStore
  /** How Enter meets a running turn; absent keeps queue, as the core defaults. */
  busyEnter?: SubmitMode
  /** Records the reader's busy-Enter choice where the page keeps it. */
  onBusyEnter?: (mode: SubmitMode) => void
}) => {
  let textarea: HTMLTextAreaElement | undefined
  let row: HTMLDivElement | undefined
  const [compact, setCompact] = createSignal(false)
  /** The row's width, and the width its chips need on one line, read while the seat sat in it. */
  let width = 0
  let need = 0
  /** The seat folds into + once its chips would not fit beside the buttons on one line. */
  const fit = (): void => {
    // A row never measured, or hidden, says nothing about what fits; the seat stays.
    if (width === 0) return
    if (row !== undefined && !compact()) need = width + overflowOf(row)
    setCompact(width < Math.max(COMPACT_WIDTH, need))
  }
  createEffect(on([compact, () => seatFactsOf(props.store.state())], fit, { defer: true }))
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
    const stopWidth = watchWidth(row, (next) => {
      width = next
      fit()
    })
    onCleanup(() => {
      document.removeEventListener('keydown', onKey)
      stopWidth?.()
    })
  })

  /** The mode this page prefers while a turn runs; queue is the untouched default. */
  const preferred = (): SubmitMode => props.busyEnter ?? 'queue'

  /** The chips that say how the next request runs; a narrow composer keeps them behind +. */
  const seat = () => (
    <div id="seat">
      <Model store={props.store} />
      <Effort store={props.store} />
      <BusyEnter
        store={props.store}
        mode={preferred()}
        onChoose={props.onBusyEnter ?? (() => undefined)}
      />
    </div>
  )

  /** Sends the draft; an accelerated gesture asks for the other of the two modes. */
  const send = (accelerated = false): void => {
    props.store.submit(submitModeFor(preferred(), running(), accelerated))
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

  /** Uploads every file dropped or picked; the store keeps what the server accepted. */
  const attachFiles = (files: FileList | null): void => {
    for (const file of files ?? []) props.store.attach(file)
  }

  let picker: HTMLInputElement | undefined
  const attachments = () => props.store.state().attachments

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
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault()
          attachFiles(event.dataTransfer?.files ?? null)
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
        <Show
          when={
            props.store.state().quotes.length > 0 || props.store.state().selection.trim() !== ''
          }
        >
          <div id="quotes" aria-label="passages the next message quotes">
            <Index each={props.store.state().quotes}>
              {(quote, index) => (
                <span class="quote-chip">
                  <span class="quote-text">{quotePreview(quote().text)}</span>
                  <button
                    type="button"
                    class="quote-remove"
                    aria-label={'Remove quoted passage ' + String(index + 1)}
                    title="remove this quotation"
                    onClick={() => props.store.removeQuote(index)}
                  >
                    ×
                  </button>
                </span>
              )}
            </Index>
            <Show when={props.store.state().selection.trim() !== ''}>
              <button
                type="button"
                id="quote-selection"
                title="quote the selected text in the next message"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => props.store.addQuote(props.store.state().selection)}
              >
                Quote selection
              </button>
            </Show>
          </div>
        </Show>
        <Show when={attachments().length > 0}>
          <div id="attachments" aria-label="files the next message attaches">
            <Index each={attachments()}>
              {(attachment, index) => (
                <span class="attachment-chip">
                  <span class="attachment-kind">
                    {attachment().mediaType.startsWith('image/') ? 'image' : 'file'}
                  </span>
                  <span class="attachment-name">{attachment().name}</span>
                  <button
                    type="button"
                    class="attachment-remove"
                    aria-label={'Remove attached file ' + attachment().name}
                    title="remove this attachment"
                    onClick={() => props.store.removeAttachment(index)}
                  >
                    ×
                  </button>
                </span>
              )}
            </Index>
          </div>
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
              send(acceleratedSend(event))
            }
          }}
        />
        <div
          class="actions"
          ref={(node) => {
            row = node
          }}
        >
          <Plus store={props.store} onStart={start} seat={compact() ? seat : undefined} />
          <input
            ref={(node) => {
              picker = node
            }}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              attachFiles(event.currentTarget.files)
              event.currentTarget.value = ''
            }}
          />
          <Button
            id="attach"
            size="icon"
            type="button"
            aria-label="Attach files"
            title="Attach images or text files (or drop them here)"
            onClick={() => picker?.click()}
          >
            <Icon name="paperclip" />
          </Button>
          <Show when={!compact()}>{seat()}</Show>
          <ContextRing store={props.store} />
          {/* While something waits on the reader, the card's button is the one in amber. */}
          <Button
            id="send"
            size="icon"
            variant={takeover() ? 'default' : 'primary'}
            type="submit"
            aria-label="Send the message"
            title="Send the message (Enter)"
          >
            <Icon name="send" />
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
            <Icon name="stop" />
          </Button>
        </div>
      </form>
    </footer>
  )
}
