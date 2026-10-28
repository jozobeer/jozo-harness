import { For, Index, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js'
import { plainText, summaryBodyOf } from '@jozo-harness/ui-view'
import { renderMarkdown } from '../../src/ui/markdown.ts'
import {
  toolsOf,
  type TraceImage,
  type TraceStep,
  type TraceTool,
  type TraceTurn,
} from '../../src/ui/trace.ts'
import { Linkify } from './linkify.tsx'
import { EndMark } from './ui/end-mark.tsx'
import { Icon, toolIconOf } from './ui/icon.tsx'
import { Mug } from './ui/mug.tsx'
import { pagesIn, spanOf } from '../lib.ts'
import { useSeen } from '../seen.ts'
import type { SessionStore } from '../store.ts'

/**
 * The answer as HTML. A text that renders where it did leaves the nodes it
 * already wrote alone, so only a change to the answer rebuilds its body.
 */
export const Markdown = (props: { text: string; class?: string }) => {
  let node: HTMLDivElement | undefined
  let written = ''
  const html = createMemo(() => renderMarkdown(plainText(props.text)))
  createEffect(() => {
    const next = html()
    if (node === undefined || next === written) return
    written = next
    node.innerHTML = next
  })
  return (
    <div
      class={'markdown ' + (props.class ?? '')}
      ref={(element) => {
        node = element
      }}
    />
  )
}

/** The clock a running turn reads its elapsed time from; one tick a second. */
const createNow = () => {
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))
  return now
}

/** A data URL for one image block, so the card draws it without another request. */
const imageUrl = (image: TraceImage): string => 'data:' + image.mediaType + ';base64,' + image.data

/** How many bytes a base64 string stands for. */
const imageBytes = (data: string): number => {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.floor((data.length * 3) / 4) - padding
}

const imageSize = (width: number, height: number): string =>
  String(width) + '×' + String(height) + 'px'

/** One image result: the picture, then the path, pixels, and bytes it was recorded at. */
const ToolImage = (props: { image: TraceImage }) => {
  const [size, setSize] = createSignal('')
  return (
    <figure class="tool-image">
      <img
        src={imageUrl(props.image)}
        alt={props.image.name}
        loading="lazy"
        decoding="async"
        onLoad={(event) =>
          setSize(imageSize(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight))
        }
      />
      <figcaption class="tool-image-meta">
        <span class="tool-image-path">{props.image.name}</span>
        <Show when={size() !== ''}>
          <span class="tool-image-size">{size()}</span>
        </Show>
        <span class="tool-image-bytes">{String(imageBytes(props.image.data)) + ' B'}</span>
      </figcaption>
    </figure>
  )
}

/** A published page reads in place, and opens on its own for a reader who wants it. */
const ToolPage = (props: { page: string }) => (
  <div class="tool-page">
    <iframe
      class="tool-page-frame"
      src={props.page}
      title="published page"
      sandbox="allow-scripts"
      referrerpolicy="no-referrer"
    />
    <a class="tool-page-open" href={props.page} target="_blank" rel="noopener">
      Open in a new tab
    </a>
  </div>
)

/** The one line a failed card adds for the code the log kept, before the raw output. */
const errorLineOf = (code: string): string => {
  switch (code) {
    case 'timeout':
      return 'timeout: the call ran past its limit'
    case 'denied':
      return 'denied: policy or approval refused the call'
    case 'invalid-arguments':
      return 'invalid arguments: the tool never ran'
    default:
      return code
  }
}

const Tool = (props: { tool: TraceTool }) => (
  <details class={'tool-card ' + props.tool.status} open={props.tool.status === 'error'}>
    <summary class="tool-line">
      <Icon name={toolIconOf(props.tool.name)} class="tool-icon" />
      <span class="tool-name">{props.tool.name}</span>
      <span class="tool-summary">
        <Linkify text={summaryBodyOf(props.tool.name, props.tool.summary)} stop />
      </span>
      <span class="tool-result">
        <Linkify text={props.tool.result} stop />
      </span>
      <span class="tool-took">
        {props.tool.endedAt === undefined ? '…' : spanOf(props.tool.endedAt - props.tool.startedAt)}
      </span>
    </summary>
    <Show when={props.tool.errorCode !== ''}>
      <p class="tool-error">{errorLineOf(props.tool.errorCode)}</p>
    </Show>
    <Show when={props.tool.output !== ''}>
      <pre class="tool-output">
        <Linkify text={plainText(props.tool.output)} />
      </pre>
    </Show>
    <For each={pagesIn(props.tool)}>{(page) => <ToolPage page={page} />}</For>
    <For each={props.tool.images}>{(image) => <ToolImage image={image} />}</For>
  </details>
)

/** The skill a call loaded, from the arguments the forced load wrote. */
const skillNameOf = (args: string): string => {
  try {
    const parsed = JSON.parse(args) as { readonly name?: unknown }
    return typeof parsed.name === 'string' ? parsed.name : ''
  } catch {
    return ''
  }
}

/**
 * A skill load reads as its own card: the name, where it was read from, and what
 * it is for stay on the folded line; the instructions wait inside.
 */
const Skill = (props: { tool: TraceTool }) => (
  <details class={'tool-card skill-card ' + props.tool.status} open={props.tool.status === 'error'}>
    <summary class="tool-line">
      <Icon name="skill" class="tool-icon" />
      <span class="skill-label">skill</span>
      <span class="skill-what">
        <span class="skill-name">{skillNameOf(props.tool.args)}</span>
        <span class="skill-source">
          <Linkify text={props.tool.summary} stop />
        </span>
      </span>
      <span class="skill-description">
        <Linkify text={props.tool.result} stop />
      </span>
      <span class="tool-took">
        {props.tool.endedAt === undefined ? '…' : spanOf(props.tool.endedAt - props.tool.startedAt)}
      </span>
    </summary>
    <Show when={props.tool.output !== ''}>
      <pre class="tool-output">
        <Linkify text={plainText(props.tool.output)} />
      </pre>
    </Show>
  </details>
)

/** A call the log wrote outside any turn: its card stands alone because no turn holds it. */
const Load = (props: { turn: TraceTurn }) => (
  <article class="block load">
    <Index each={toolsOf(props.turn)}>
      {(tool) => (
        <Show when={tool().name === 'skill'} fallback={<Tool tool={tool()} />}>
          <Skill tool={tool()} />
        </Show>
      )}
    </Index>
  </article>
)

/** One step of the process: a line of what the model thought, what it said, and its calls. */
const Step = (props: { step: TraceStep; last: boolean }) => (
  <li class="step">
    <Show when={props.step.reasoning !== ''}>
      <p class="step-thought">
        <Linkify text={plainText(props.step.reasoning)} />
      </p>
    </Show>
    <Show when={props.step.text !== '' && !props.last}>
      <Markdown text={props.step.text} class="step-said" />
    </Show>
    <Index each={props.step.tools}>
      {(tool) => (
        <Show when={tool().name === 'skill'} fallback={<Tool tool={tool()} />}>
          <Skill tool={tool()} />
        </Show>
      )}
    </Index>
  </li>
)

const plural = (count: number, word: string): string =>
  String(count) + ' ' + word + (count === 1 ? '' : 's')

/** The process folded to one line: how long, how much, and what went wrong. */
const ProcessLine = (props: { turn: TraceTurn; now: number; sessionId: string }) => {
  const tools = () => toolsOf(props.turn)
  const failed = () => tools().filter((tool) => tool.status === 'error').length
  const running = () => props.turn.endedAt === undefined
  const seen = useSeen()
  // A turn that ended well stays green until the reader has had its session open and left.
  const fresh = (): boolean => seen.fresh(props.sessionId, props.turn.endedAt ?? Infinity)
  const current = () => tools().findLast((tool) => tool.status === 'running')
  // The line stays put for the whole turn; between calls the model is thinking.
  const doing = (): string => {
    const tool = current()
    return tool === undefined
      ? 'thinking'
      : tool.name + ' ' + summaryBodyOf(tool.name, tool.summary)
  }
  return (
    <summary class="process-line">
      <Show
        when={running()}
        fallback={<EndMark outcome={props.turn.outcome} fresh={fresh()} class="process-mark" />}
      >
        <Mug state="filling" since={props.turn.startedAt} />
      </Show>
      <span class="process-state">{running() ? 'Working' : 'Worked'}</span>
      <span class="process-took">
        {spanOf((props.turn.endedAt ?? props.now) - props.turn.startedAt)}
      </span>
      <span class="process-count">
        {plural(props.turn.steps.length, 'step') + ', ' + plural(tools().length, 'call')}
      </span>
      <Show when={failed() > 0}>
        <span class="process-failed">{plural(failed(), 'failure')}</span>
      </Show>
      <Icon name="chevron-down" class="process-chevron" />
      <Show when={running()}>
        <span class="process-now">{doing()}</span>
      </Show>
    </summary>
  )
}

/** The files a turn wrote; one opens its changes in the pane. */
const Changes = (props: { turn: TraceTurn; store: SessionStore }) => (
  <Show when={props.turn.changed.length > 0}>
    <section class="changes">
      <div class="changes-head">{'Changed ' + plural(props.turn.changed.length, 'file')}</div>
      <For each={props.turn.changed}>
        {(file) => (
          <button
            class="change"
            type="button"
            onClick={() => props.store.showPane({ kind: 'changes', path: file.path })}
          >
            <span class="change-path">{file.path}</span>
            <span class="change-edits">{plural(file.edits, 'edit')}</span>
          </button>
        )}
      </For>
    </section>
  </Show>
)

/**
 * The verdict under one answer. A click records it at once; the note is sent
 * with the same verdict when the human saves it, and the log keeps the latest.
 */
const Feedback = (props: { turn: TraceTurn; store: SessionStore }) => {
  const [editing, setEditing] = createSignal(false)
  const [note, setNote] = createSignal(props.turn.feedback?.memo ?? '')
  // The click shows at once; the log answers in the next event, and a reload
  // starts from the verdict folded there.
  const [chosen, setChosen] = createSignal<'like' | 'dislike' | undefined>(
    props.turn.feedback?.rating,
  )
  const send = (rating: 'like' | 'dislike'): void => {
    setChosen(rating)
    const memo = note().trim()
    props.store.send({
      kind: 'feedback',
      target: props.turn.answerSeq,
      rating,
      ...(memo === '' ? {} : { memo }),
    })
  }
  return (
    <div class="feedback" aria-label="Rate this answer">
      <button
        type="button"
        class={'feedback-choice' + (chosen() === 'like' ? ' chosen' : '')}
        aria-pressed={chosen() === 'like'}
        onClick={() => send('like')}
      >
        Good
      </button>
      <button
        type="button"
        class={'feedback-choice' + (chosen() === 'dislike' ? ' chosen' : '')}
        aria-pressed={chosen() === 'dislike'}
        onClick={() => send('dislike')}
      >
        Bad
      </button>
      <Show when={chosen() !== undefined}>
        <Show
          when={editing()}
          fallback={
            <button type="button" class="feedback-note" onClick={() => setEditing(true)}>
              {props.turn.feedback?.memo === undefined || props.turn.feedback.memo === ''
                ? 'Add a note'
                : props.turn.feedback.memo}
            </button>
          }
        >
          <input
            class="feedback-input"
            value={note()}
            maxlength={500}
            placeholder="A short note"
            aria-label="Note on this answer"
            onInput={(event) => setNote(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              const rating = chosen()
              if (rating !== undefined) send(rating)
              setEditing(false)
            }}
          />
          <button
            type="button"
            class="feedback-save"
            onClick={() => {
              const rating = chosen()
              if (rating !== undefined) send(rating)
              setEditing(false)
            }}
          >
            Save
          </button>
        </Show>
      </Show>
    </div>
  )
}

/** One turn: what was asked, the work folded, the answer, and what it changed. */
const Turn = (props: { turn: TraceTurn; live: string; now: number; store: SessionStore }) => {
  const running = () => props.turn.endedAt === undefined
  return (
    <article class={'block turn' + (running() ? ' running' : '')}>
      <Show when={props.turn.prompt !== ''}>
        <div class="block user turn-ask">
          <div class="body">
            <Linkify text={plainText(props.turn.prompt)} />
          </div>
        </div>
      </Show>
      <Show when={props.turn.steps.length > 0 || running()}>
        <details class="process">
          <ProcessLine
            turn={props.turn}
            now={props.now}
            sessionId={props.store.state().sessionId}
          />
          <ol class="steps">
            <Index each={props.turn.steps}>
              {(step, index) => (
                <Step step={step()} last={index === props.turn.steps.length - 1 && !running()} />
              )}
            </Index>
          </ol>
        </details>
      </Show>
      <Show when={props.turn.answer !== '' && !running()}>
        <Markdown text={props.turn.answer} class="body answer" />
        <Feedback turn={props.turn} store={props.store} />
      </Show>
      <Show when={running() && (props.live !== '' || props.turn.answer !== '')}>
        <div class="block assistant live">
          <Markdown text={props.live === '' ? props.turn.answer : props.live} class="body" />
        </div>
      </Show>
      <Show when={props.turn.outcome !== '' && props.turn.outcome !== 'completed'}>
        <div class="notice warn">{'ended: ' + props.turn.outcome}</div>
      </Show>
      <Changes turn={props.turn} store={props.store} />
    </article>
  )
}

/**
 * The session as turns, each one read from its outcome inward. The trace is
 * folded anew on every event, so the lists key by position: a process the
 * reader opened stays open while the turn grows.
 */
export const Turns = (props: { store: SessionStore }) => {
  const turns = createMemo(() => props.store.state().trace)
  const now = createNow()
  return (
    <Index each={turns()}>
      {(turn) => (
        <Show
          when={turn().standalone}
          fallback={
            <Turn
              turn={turn()}
              live={props.store.state().conversation.live}
              now={now()}
              store={props.store}
            />
          }
        >
          <Load turn={turn()} />
        </Show>
      )}
    </Index>
  )
}
