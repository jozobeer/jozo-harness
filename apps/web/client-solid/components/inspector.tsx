import { Show, createMemo } from 'solid-js'
import { plainText } from '@jozo-harness/ui-view'
import { Linkify } from './linkify.tsx'
import type { TraceStep, TraceTool, TraceTurn } from '../../src/ui/trace.ts'
import type { SessionStore } from '../store.ts'
import { spanOf } from './waterfall.tsx'

/** The arguments as the model wrote them, indented when they parse. */
const prettyOf = (args: string): string => {
  try {
    return JSON.stringify(JSON.parse(args), null, 2)
  } catch {
    return args
  }
}

interface Found {
  readonly step: TraceStep
  readonly tool: TraceTool
}

const findCall = (
  turns: ReadonlyArray<TraceTurn>,
  turn: number,
  callId: string,
): Found | undefined => {
  const steps = turns.find((item) => item.turn === turn)?.steps ?? []
  for (const step of steps) {
    const tool = step.tools.find((item) => item.callId === callId)
    if (tool !== undefined) return { step, tool }
  }
  return undefined
}

/** One call, opened: what the model reasoned, what it asked for, and what came back. */
export const Inspector = (props: { store: SessionStore; turn: number; callId: string }) => {
  const found = createMemo(() => findCall(props.store.state().trace, props.turn, props.callId))
  return (
    <Show when={found()} fallback={<div class="run-empty">pick a call in the trace</div>}>
      {(call) => (
        <div class="inspector">
          <h2 class={'pane-title inspect-title ' + call().tool.status}>
            {call().tool.name}
            <span class="inspect-status">{call().tool.status}</span>
          </h2>
          <div class="panel-rows">
            <div class="panel-row">
              <span class="panel-name">turn</span>
              <span class="panel-value">
                {String(props.turn) + ' · step ' + String(call().step.step)}
              </span>
            </div>
            <div class="panel-row">
              <span class="panel-name">took</span>
              <span class="panel-value">
                {call().tool.endedAt === undefined
                  ? 'running'
                  : spanOf(call().tool.endedAt! - call().tool.startedAt)}
              </span>
            </div>
            <div class="panel-row">
              <span class="panel-name">result</span>
              <span class="panel-value">{call().tool.result || '—'}</span>
            </div>
          </div>
          <Show when={call().step.reasoning !== ''}>
            <span class="pane-label">reasoning</span>
            <p class="inspect-thought">
              <Linkify text={plainText(call().step.reasoning)} />
            </p>
          </Show>
          <span class="pane-label">arguments</span>
          <pre class="job-output inspect-args">
            <Linkify text={plainText(prettyOf(call().tool.args))} />
          </pre>
          <span class="pane-label">output</span>
          <pre class="job-output">
            {call().tool.output === '' ? (
              '(no output)'
            ) : (
              <Linkify text={plainText(call().tool.output)} />
            )}
          </pre>
        </div>
      )}
    </Show>
  )
}
