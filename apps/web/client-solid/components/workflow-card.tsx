import { For, Show } from 'solid-js'
import { plainText } from '@jozo-harness/ui-view'
import type { TraceTool } from '../../src/ui/trace.ts'
import { workflowOf, type WorkflowChild } from '../../src/ui/workflow.ts'
import { useTranslate, type Translate } from '../i18n.ts'
import { spanOf } from '../lib.ts'
import type { SessionStore } from '../store.ts'
import { Linkify } from './linkify.tsx'
import { LogButton } from './log-button.tsx'
import { Icon } from './ui/icon.tsx'

/** The children of the call, and how many of them failed. */
const countsOf = (tool: TraceTool): { readonly children: number; readonly failed: number } => {
  const view = workflowOf(tool)
  if (view === undefined) return { children: 0, failed: 0 }
  return {
    children: view.children.length,
    failed: view.children.filter((child) => child.status === 'failed').length,
  }
}

const countLine = (count: number, t: Translate): string =>
  String(count) + ' ' + t(count === 1 ? 'workflow.child' : 'workflow.childMany')

const stateOf = (running: boolean, failed: number, t: Translate): string =>
  running ? t('workflow.running') : failed > 0 ? t('workflow.failed') : t('workflow.done')

/** How long a child ran, read from the session that started it; '' when it is not known. */
const tookOf = (child: WorkflowChild, store: SessionStore): string => {
  const known = store.state().run?.subagents.find((one) => one.id === child.sessionId)
  return known?.endedAt === undefined ? '' : spanOf(known.endedAt - known.startedAt)
}

/** One child: how it ended, how long it took, why it failed, and the way into its session. */
const Child = (props: { child: WorkflowChild; store: SessionStore }) => {
  const t = useTranslate()
  const took = (): string => tookOf(props.child, props.store)
  return (
    <li class={'workflow-child ' + props.child.status} data-child={props.child.name}>
      <span class="workflow-mark" aria-hidden="true">
        <Icon name={props.child.status === 'done' ? 'done' : 'failed'} />
      </span>
      <span class="workflow-name">{props.child.name}</span>
      <span class="workflow-child-status">
        {t(props.child.status === 'done' ? 'workflow.done' : 'workflow.failed')}
      </span>
      <Show when={took() !== ''}>
        <span class="workflow-took">{took()}</span>
      </Show>
      <Show when={props.child.reason !== ''}>
        <span class="workflow-reason">
          <Linkify text={props.child.reason} stop />
        </span>
      </Show>
      <Show when={props.child.sessionId !== ''}>
        <button
          class="workflow-open"
          type="button"
          onClick={() => props.store.moveTo(props.child.sessionId)}
        >
          {t('workflow.open')}
        </button>
      </Show>
    </li>
  )
}

/**
 * A workflow call as a node of its own: the folded line says how many children
 * ran and how the run ended, and the block inside lists each child with the way
 * into its own session. Everything here is read from the logged result.
 */
export const WorkflowCard = (props: { tool: TraceTool; store: SessionStore }) => {
  const t = useTranslate()
  const view = () => workflowOf(props.tool)
  const headline = (): string => view()?.headline ?? ''
  const counts = () => countsOf(props.tool)
  const running = (): boolean => props.tool.status === 'running'
  return (
    <details class={'workflow-card ' + props.tool.status} data-workflow={props.tool.callId}>
      <summary class="workflow-line">
        <Icon name="subagent" class="workflow-icon" />
        <span class="workflow-title">{t('workflow.title')}</span>
        <LogButton store={props.store} target={{ kind: 'call', id: props.tool.callId }} />
        <span class="workflow-count">{countLine(counts().children, t)}</span>
        <span class={'workflow-state ' + (counts().failed > 0 ? 'failed' : 'done')}>
          {stateOf(running(), counts().failed, t)}
        </span>
        <span class="workflow-took">
          {props.tool.endedAt === undefined
            ? '…'
            : spanOf(props.tool.endedAt - props.tool.startedAt)}
        </span>
      </summary>
      <Show when={headline() !== ''}>
        <p class="workflow-headline">{headline()}</p>
      </Show>
      <Show when={(view()?.children.length ?? 0) > 0}>
        <ol class="workflow-children">
          <For each={view()?.children ?? []}>
            {(child) => <Child child={child} store={props.store} />}
          </For>
        </ol>
      </Show>
      <Show when={props.tool.output !== ''}>
        <details class="workflow-output">
          <summary class="workflow-fold">{t('workflow.result')}</summary>
          <pre class="tool-output">
            <Linkify text={plainText(props.tool.output)} />
          </pre>
        </details>
      </Show>
    </details>
  )
}
