import { For, Index, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js'
import {
  axisEndOf,
  toolsOf,
  type TraceStep,
  type TraceTool,
  type TraceTurn,
} from '../../src/ui/trace.ts'
import type { SessionStore } from '../store.ts'

/** A span the way the axis says it: 0.3s, 38s, 4m 12s. */
export const spanOf = (ms: number): string => {
  if (ms < 10_000) return (Math.max(0, ms) / 1000).toFixed(1) + 's'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return String(seconds) + 's'
  return String(Math.floor(seconds / 60)) + 'm ' + String(seconds % 60).padStart(2, '0') + 's'
}

/**
 * The clock a running lane reads. It ticks only while the trace is on screen:
 * the answers lens keeps the trace mounted but hidden, and a hidden lane has
 * nothing to say each second.
 */
const createNow = (live: () => boolean) => {
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    if (!live()) return
    // Opened after time away, the lane catches up before its first tick.
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })
  return now
}

/** Where a span sits on its turn's axis, as CSS percentages. */
const barOf = (turn: TraceTurn, from: number, to: number, end: number) => {
  const total = Math.max(1, end - turn.startedAt)
  const left = ((from - turn.startedAt) / total) * 100
  const width = Math.max(0.4, ((to - from) / total) * 100)
  return { left: String(left) + '%', width: String(Math.min(width, 100 - left)) + '%' }
}

/** When the model handed the step to its tools: the first call, else the step's end. */
const thinkingEnd = (step: TraceStep, end: number): number =>
  step.tools[0]?.startedAt ?? step.endedAt ?? end

interface Filter {
  readonly text: string
  readonly failedOnly: boolean
}

const matches = (tool: TraceTool, filter: Filter): boolean =>
  (!filter.failedOnly || tool.status === 'error') &&
  (filter.text === '' || (tool.name + ' ' + tool.summary).toLowerCase().includes(filter.text))

/** One model call on the axis: the time the model spent before it asked for tools. */
const ModelRow = (props: {
  turn: TraceTurn
  step: TraceStep
  axisEnd: number
  liveEnd: number
}) => {
  const to = () => thinkingEnd(props.step, props.liveEnd)
  return (
    <div class="wf-row model">
      <span class="wf-name">model</span>
      <span class="wf-summary">{props.step.reasoning.split('\n')[0] ?? ''}</span>
      <span class="wf-track">
        <span class="wf-bar" style={barOf(props.turn, props.step.startedAt, to(), props.axisEnd)} />
      </span>
      <span class="wf-took">{spanOf(to() - props.step.startedAt)}</span>
    </div>
  )
}

const ToolRow = (props: {
  turn: TraceTurn
  tool: TraceTool
  axisEnd: number
  liveEnd: number
  store: SessionStore
}) => {
  const selected = () => {
    const pane = props.store.state().pane
    return pane?.kind === 'inspect' && pane.callId === props.tool.callId
  }
  const to = () => props.tool.endedAt ?? props.liveEnd
  return (
    <button
      class={'wf-row tool ' + props.tool.status + (selected() ? ' selected' : '')}
      type="button"
      onClick={() =>
        props.store.showPane({ kind: 'inspect', turn: props.turn.turn, callId: props.tool.callId })
      }
    >
      <span class="wf-name">{props.tool.name}</span>
      <span class="wf-summary">{props.tool.summary}</span>
      <span class="wf-track">
        <span class="wf-bar" style={barOf(props.turn, props.tool.startedAt, to(), props.axisEnd)} />
      </span>
      <span class="wf-took">{spanOf(to() - props.tool.startedAt)}</span>
    </button>
  )
}

/** Where the turn's time went: the model's share and the tools' share. */
const shareOf = (turn: TraceTurn, end: number): string => {
  const tools = toolsOf(turn).reduce(
    (sum, tool) => sum + ((tool.endedAt ?? end) - tool.startedAt),
    0,
  )
  const total = Math.max(1, end - turn.startedAt)
  return 'tools ' + String(Math.round((tools / total) * 100)) + '%'
}

const TurnLane = (props: { turn: TraceTurn; now: number; filter: Filter; store: SessionStore }) => {
  // The axis stops at the last event; the live end only grows the bar that runs.
  const axisEnd = () => axisEndOf(props.turn)
  const liveEnd = () => props.turn.endedAt ?? props.now
  const failed = () => toolsOf(props.turn).filter((tool) => tool.status === 'error').length
  return (
    <section class={'wf-turn' + (props.turn.endedAt === undefined ? ' running' : '')}>
      <header class="wf-head">
        <span class="wf-turn-number">{'turn ' + String(props.turn.turn)}</span>
        <span class="wf-turn-prompt">{props.turn.prompt}</span>
        <span class="wf-turn-facts">
          {spanOf(liveEnd() - props.turn.startedAt) +
            ' · ' +
            String(props.turn.steps.length) +
            ' steps · ' +
            String(toolsOf(props.turn).length) +
            ' calls · ' +
            shareOf(props.turn, liveEnd())}
        </span>
        <Show when={failed() > 0}>
          <span class="wf-turn-failed">{String(failed()) + ' failed'}</span>
        </Show>
      </header>
      <Index each={props.turn.steps}>
        {(step) => (
          <>
            <Show when={props.filter.text === '' && !props.filter.failedOnly}>
              <ModelRow turn={props.turn} step={step()} axisEnd={axisEnd()} liveEnd={liveEnd()} />
            </Show>
            <Index each={step().tools.filter((tool) => matches(tool, props.filter))}>
              {(tool) => (
                <ToolRow
                  turn={props.turn}
                  tool={tool()}
                  axisEnd={axisEnd()}
                  liveEnd={liveEnd()}
                  store={props.store}
                />
              )}
            </Index>
          </>
        )}
      </Index>
    </section>
  )
}

/**
 * The trace: every turn as a lane on its own time axis, each model call and
 * tool call a bar where it happened. It answers where the time went and where
 * it broke; a row opens in the inspector.
 */
export const Waterfall = (props: { store: SessionStore; live?: boolean }) => {
  const turns = createMemo(() => props.store.state().trace)
  const now = createNow(() => props.live !== false)
  const [text, setText] = createSignal('')
  const [failedOnly, setFailedOnly] = createSignal(false)
  const filter = (): Filter => ({ text: text().trim().toLowerCase(), failedOnly: failedOnly() })
  return (
    <section id="waterfall" aria-label="Trace">
      <div class="wf-tools">
        <input
          class="wf-filter"
          type="search"
          placeholder="Filter calls by tool or summary"
          value={text()}
          onInput={(event) => setText(event.currentTarget.value)}
        />
        <label class="wf-toggle">
          <input
            type="checkbox"
            checked={failedOnly()}
            onChange={(event) => setFailedOnly(event.currentTarget.checked)}
          />
          failed only
        </label>
      </div>
      <Show
        when={turns().length > 0}
        fallback={<div class="run-empty wf-empty">the trace fills in as the session runs</div>}
      >
        <For each={[...turns()].reverse()}>
          {(turn) => <TurnLane turn={turn} now={now()} filter={filter()} store={props.store} />}
        </For>
      </Show>
    </section>
  )
}
