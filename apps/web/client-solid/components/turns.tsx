import { For, Index, Show, createMemo, createSignal, onCleanup } from 'solid-js'
import { plainText, summaryBodyOf } from '@jozo-harness/ui-view'
import type { Attachment, Quote } from '@jozo-harness/ui-protocol'
import { PLAN_TOOL, planOf } from '../../src/ui/plan.ts'
import {
  toolsOf,
  type TraceImage,
  type TraceStep,
  type TraceTool,
  type TraceTurn,
} from '../../src/ui/trace.ts'
import { maskSecrets } from '../../src/ui/secret.ts'
import { WORKFLOW_TOOL } from '../../src/ui/workflow.ts'
import { Linkify } from './linkify.tsx'
import { Markdown } from './markdown.tsx'
import { PlanCard } from './plan-card.tsx'
import { ProposalCard } from './proposal-card.tsx'
import { WorkflowCard } from './workflow-card.tsx'
import { EndMark } from './ui/end-mark.tsx'
import { Icon, toolIconOf } from './ui/icon.tsx'
import { Mug } from './ui/mug.tsx'
import { useLocaleChoice, useTranslate } from '../i18n.ts'
import { useProposalCards } from '../proposal-cards-choice.ts'
import { useToolDensity } from '../tool-density-choice.ts'
import { pagesIn, spanOf } from '../lib.ts'
import { useSeen } from '../seen.ts'
import type { SessionStore } from '../store.ts'

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
const ToolPage = (props: { page: string }) => {
  const t = useTranslate()
  return (
    <div class="tool-page">
      <iframe
        class="tool-page-frame"
        src={props.page}
        title={t('turn.publishedPage')}
        sandbox="allow-scripts"
        referrerpolicy="no-referrer"
      />
      <a class="tool-page-open" href={props.page} target="_blank" rel="noopener">
        {t('turn.openPage')}
      </a>
    </div>
  )
}

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

/** The width a folded line cuts an argument or output preview at, so it stays one row. */
const PREVIEW_MAX = 96

/** One preview on a folded line: whitespace folded, cut when it would not fit. */
const previewOf = (text: string): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > PREVIEW_MAX ? line.slice(0, PREVIEW_MAX) + '…' : line
}

/** The arguments as the model wrote them, read as a few key/value pairs. */
const argumentPreviewOf = (args: string): string => {
  try {
    const parsed: unknown = JSON.parse(args)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return previewOf(args)
    }
    return previewOf(
      Object.entries(parsed)
        .map(
          ([key, value]) => key + ' ' + (typeof value === 'string' ? value : JSON.stringify(value)),
        )
        .join('  '),
    )
  } catch {
    return previewOf(args)
  }
}

/** The first line a result begins with, for the line that shows where a call left off. */
const resultPreviewOf = (output: string): string =>
  previewOf(
    plainText(output)
      .split('\n')
      .find((line) => line.trim() !== '') ?? '',
  )

/**
 * One call as the conversation draws it. The density changes what the folded
 * line shows and whether it starts open, never the call the log recorded: a
 * compact line keeps the name, and the result waits one fold away.
 */
const Tool = (props: { tool: TraceTool }) => {
  const { density } = useToolDensity()
  const compact = (): boolean => density() === 'compact'
  const richer = (): boolean => density() === 'detailed' || density() === 'verbose'
  return (
    <details
      class={'tool-card ' + props.tool.status}
      data-density={density()}
      open={props.tool.status === 'error' || density() === 'verbose'}
    >
      <summary class="tool-line">
        <Icon name={toolIconOf(props.tool.name)} class="tool-icon" />
        <span class="tool-name">{props.tool.name}</span>
        <Show when={!compact()}>
          <span class="tool-summary">
            <Show
              when={richer()}
              fallback={<Linkify text={summaryBodyOf(props.tool.name, props.tool.summary)} stop />}
            >
              <span class="tool-args">
                {argumentPreviewOf(props.tool.args) ||
                  summaryBodyOf(props.tool.name, props.tool.summary)}
              </span>
            </Show>
          </span>
          <span class="tool-result">
            <Show when={richer()} fallback={<Linkify text={props.tool.result} stop />}>
              <span class="tool-peek">
                {resultPreviewOf(props.tool.output) || props.tool.result}
              </span>
            </Show>
          </span>
        </Show>
        <span class="tool-took">
          {props.tool.endedAt === undefined
            ? '…'
            : spanOf(props.tool.endedAt - props.tool.startedAt)}
        </span>
      </summary>
      <Show when={compact() && props.tool.result !== ''}>
        <p class="tool-result-body">
          <Linkify text={props.tool.result} stop />
        </p>
      </Show>
      <Show when={props.tool.errorCode !== ''}>
        <p class="tool-error">{errorLineOf(props.tool.errorCode)}</p>
      </Show>
      <Show when={density() === 'verbose' && props.tool.args !== ''}>
        <pre class="tool-args-full">
          <Linkify text={plainText(props.tool.args)} />
        </pre>
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
}

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
const Skill = (props: { tool: TraceTool }) => {
  const t = useTranslate()
  const { density } = useToolDensity()
  const compact = (): boolean => density() === 'compact'
  return (
    <details
      class={'tool-card skill-card ' + props.tool.status}
      data-density={density()}
      open={props.tool.status === 'error' || density() === 'verbose'}
    >
      <summary class="tool-line">
        <Icon name="skill" class="tool-icon" />
        <span class="skill-label">{t('turn.skill')}</span>
        <span class="skill-what">
          <span class="skill-name">{skillNameOf(props.tool.args)}</span>
          <Show when={!compact()}>
            <span class="skill-source">
              <Linkify text={props.tool.summary} stop />
            </span>
          </Show>
        </span>
        <Show when={!compact()}>
          <span class="skill-description">
            <Linkify text={props.tool.result} stop />
          </span>
        </Show>
        <span class="tool-took">
          {props.tool.endedAt === undefined
            ? '…'
            : spanOf(props.tool.endedAt - props.tool.startedAt)}
        </span>
      </summary>
      <Show when={compact() && props.tool.result !== ''}>
        <p class="skill-description-body">
          <Linkify text={props.tool.result} stop />
        </p>
      </Show>
      <Show when={props.tool.output !== ''}>
        <pre class="tool-output">
          <Linkify text={plainText(props.tool.output)} />
        </pre>
      </Show>
    </details>
  )
}

/**
 * One call as the conversation draws it: a skill and a workflow each get a node
 * of their own, and the rest a line each.
 */
const Call = (props: { tool: TraceTool; store: SessionStore }) => (
  <Show
    when={props.tool.name === 'skill'}
    fallback={
      <Show when={props.tool.name === WORKFLOW_TOOL} fallback={<Tool tool={props.tool} />}>
        <WorkflowCard tool={props.tool} store={props.store} />
      </Show>
    }
  >
    <Skill tool={props.tool} />
  </Show>
)

/**
 * The plans a turn proposed. They stay outside the folded process: a plan is
 * the turn's answer, and a reader should not have to open the work to see it.
 */
const Plans = (props: { turn: TraceTurn; store: SessionStore }) => (
  <Index
    each={toolsOf(props.turn).filter(
      (tool) => tool.name === PLAN_TOOL && planOf(tool) !== undefined,
    )}
  >
    {(tool) => <PlanCard tool={tool()} store={props.store} />}
  </Index>
)

/**
 * The questions a turn asked with choices, drawn under its answer. The switch
 * can leave them out: a reader who turns the cards off reads the answer exactly
 * as before, and the log keeps every offer either way.
 */
const Proposals = (props: { turn: TraceTurn; store: SessionStore }) => {
  const cards = useProposalCards()
  return (
    <Show when={cards.cards() === 'shown'}>
      <Index each={props.turn.proposals}>
        {(proposal) => <ProposalCard proposal={proposal()} store={props.store} />}
      </Index>
    </Show>
  )
}

/** A call the log wrote outside any turn: its card stands alone because no turn holds it. */
const Load = (props: { turn: TraceTurn; store: SessionStore }) => (
  <article class="block load">
    <Index each={toolsOf(props.turn)}>{(tool) => <Call tool={tool()} store={props.store} />}</Index>
  </article>
)

/**
 * One step of the process: the reasoning, its translation when one was asked
 * for, what the model said, and its calls. A failed translation leaves the
 * reasoning as the log recorded it and says why it could not be translated.
 */
const Step = (props: { step: TraceStep; last: boolean; store: SessionStore }) => {
  const t = useTranslate()
  const { locale } = useLocaleChoice()
  const [translating, setTranslating] = createSignal(false)
  const [failure, setFailure] = createSignal('')

  const translate = (): void => {
    if (translating() || props.step.seq === 0) return
    setTranslating(true)
    setFailure('')
    props.store.translateReasoning(props.step.seq, locale(), (answer) => {
      setTranslating(false)
      if (answer.kind === 'failed') setFailure(answer.reason)
    })
  }

  return (
    <li class="step">
      <Show when={props.step.reasoning !== ''}>
        <div class="step-thought">
          <Linkify text={plainText(props.step.reasoning)} />
          <Show when={props.step.translation !== undefined}>
            <p class="step-translation" lang={props.step.translation?.language}>
              <span class="step-translation-label">{t('turn.translation')}</span>
              <Linkify text={plainText(props.step.translation?.text ?? '')} />
            </p>
          </Show>
          <Show when={props.step.translation === undefined}>
            <button
              type="button"
              class="step-translate"
              disabled={translating()}
              onClick={translate}
            >
              {translating() ? t('turn.translating') : t('turn.translate')}
            </button>
          </Show>
          <Show when={failure() !== ''}>
            <p class="step-translation-failed">{t('turn.translateFailed') + failure()}</p>
          </Show>
        </div>
      </Show>
      <Show when={props.step.text !== '' && !props.last}>
        <Markdown text={props.step.text} class="step-said" />
      </Show>
      <Index each={props.step.tools}>
        {(tool) => (
          <Show when={tool().name !== PLAN_TOOL}>
            <Call tool={tool()} store={props.store} />
          </Show>
        )}
      </Index>
    </li>
  )
}

const plural = (count: number, one: string, many: string): string =>
  String(count) + ' ' + (count === 1 ? one : many)

/** The process folded to one line: how long, how much, and what went wrong. */
const ProcessLine = (props: { turn: TraceTurn; now: number; sessionId: string }) => {
  const t = useTranslate()
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
      ? t('turn.thinking')
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
      <span class="process-state">{t(running() ? 'turn.working' : 'turn.worked')}</span>
      <span class="process-took">
        {spanOf((props.turn.endedAt ?? props.now) - props.turn.startedAt)}
      </span>
      <span class="process-count">
        {plural(props.turn.steps.length, t('turn.step'), t('turn.stepMany')) +
          ', ' +
          plural(tools().length, t('turn.call'), t('turn.callMany'))}
      </span>
      <Show when={failed() > 0}>
        <span class="process-failed">
          {plural(failed(), t('turn.failure'), t('turn.failureMany'))}
        </span>
      </Show>
      <Icon name="chevron-down" class="process-chevron" />
      <Show when={running()}>
        <span class="process-now">{doing()}</span>
      </Show>
    </summary>
  )
}

/** The files a turn wrote; one opens its changes in the pane. */
const Changes = (props: { turn: TraceTurn; store: SessionStore }) => {
  const t = useTranslate()
  return (
    <Show when={props.turn.changed.length > 0}>
      <section class="changes">
        <div class="changes-head">
          {t('turn.changed') +
            plural(props.turn.changed.length, t('turn.file'), t('turn.fileMany'))}
        </div>
        <For each={props.turn.changed}>
          {(file) => (
            <button
              class="change"
              type="button"
              onClick={() => props.store.showPane({ kind: 'changes', path: file.path })}
            >
              <span class="change-path">{file.path}</span>
              <span class="change-edits">
                {plural(file.edits, t('turn.edit'), t('turn.editMany'))}
              </span>
            </button>
          )}
        </For>
      </section>
    </Show>
  )
}

/**
 * The verdict under one answer. A click records it at once; the note is sent
 * with the same verdict when the human saves it, and the log keeps the latest.
 */
const Feedback = (props: { turn: TraceTurn; store: SessionStore }) => {
  const t = useTranslate()
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
    <div class="feedback" aria-label={t('turn.rate')}>
      <button
        type="button"
        class={'feedback-choice' + (chosen() === 'like' ? ' chosen' : '')}
        aria-pressed={chosen() === 'like'}
        onClick={() => send('like')}
      >
        {t('turn.good')}
      </button>
      <button
        type="button"
        class={'feedback-choice' + (chosen() === 'dislike' ? ' chosen' : '')}
        aria-pressed={chosen() === 'dislike'}
        onClick={() => send('dislike')}
      >
        {t('turn.bad')}
      </button>
      <Show when={chosen() !== undefined}>
        <Show
          when={editing()}
          fallback={
            <button type="button" class="feedback-note" onClick={() => setEditing(true)}>
              {props.turn.feedback?.memo === undefined || props.turn.feedback.memo === ''
                ? t('turn.addNote')
                : props.turn.feedback.memo}
            </button>
          }
        >
          <input
            class="feedback-input"
            value={note()}
            maxlength={500}
            placeholder={t('turn.note')}
            aria-label={t('turn.noteLabel')}
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
            {t('turn.save')}
          </button>
        </Show>
      </Show>
    </div>
  )
}

/** The quoted passages as Markdown blockquotes, so a quote reads as a quote. */
const quotedMarkdown = (quotes: ReadonlyArray<Quote>): string =>
  quotes
    .map((quote) =>
      maskSecrets(quote.text)
        .split('\n')
        .map((line) => '> ' + line)
        .join('\n'),
    )
    .join('\n\n')

/** A file size as the composer and the card show it. */
const sizeOf = (bytes: number): string =>
  bytes < 1024
    ? String(bytes) + ' B'
    : bytes < 1024 * 1024
      ? (bytes / 1024).toFixed(1) + ' KB'
      : (bytes / (1024 * 1024)).toFixed(1) + ' MB'

/** The files the message carried, as cards the reader can recognise after a reload. */
const Attached = (props: { attachments: ReadonlyArray<Attachment> }) => {
  const t = useTranslate()
  return (
    <div class="attachments" aria-label={t('turn.attachments')}>
      <Index each={props.attachments}>
        {(attachment) => (
          <span class="attachment-card">
            <span class="attachment-kind">
              {t(attachment().mediaType.startsWith('image/') ? 'turn.image' : 'turn.fileKind')}
            </span>
            <span class="attachment-name">{attachment().name}</span>
            <span class="attachment-size">{sizeOf(attachment().bytes)}</span>
          </span>
        )}
      </Index>
    </div>
  )
}

/** What the turn asked: the files it attached, the passages it quoted, then the human's own words. */
const Ask = (props: { turn: TraceTurn }) => (
  <Show
    when={
      props.turn.prompt !== '' || props.turn.quotes.length > 0 || props.turn.attachments.length > 0
    }
  >
    <div class="block user turn-ask">
      <Show when={props.turn.attachments.length > 0}>
        <Attached attachments={props.turn.attachments} />
      </Show>
      <Show when={props.turn.quotes.length > 0}>
        <Markdown text={quotedMarkdown(props.turn.quotes)} class="quoted" />
      </Show>
      <Show when={props.turn.prompt !== ''}>
        <div class="body">
          <Linkify text={plainText(maskSecrets(props.turn.prompt))} />
        </div>
      </Show>
    </div>
  </Show>
)

/** One turn: what was asked, the work folded, the answer, and what it changed. */
const Turn = (props: { turn: TraceTurn; live: string; now: number; store: SessionStore }) => {
  const t = useTranslate()
  const running = () => props.turn.endedAt === undefined
  return (
    <article class={'block turn' + (running() ? ' running' : '')}>
      <Ask turn={props.turn} />
      <Plans turn={props.turn} store={props.store} />
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
                <Step
                  step={step()}
                  last={index === props.turn.steps.length - 1 && !running()}
                  store={props.store}
                />
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
      <Proposals turn={props.turn} store={props.store} />
      <Show when={props.turn.outcome !== '' && props.turn.outcome !== 'completed'}>
        <div class="notice warn">{t('turn.ended') + props.turn.outcome}</div>
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
          <Load turn={turn()} store={props.store} />
        </Show>
      )}
    </Index>
  )
}
