import { For, Match, Show, Switch, createEffect, createSignal, onCleanup, onMount } from 'solid-js'
import type { ConversationBlock } from '@jozo-harness/ui-view'
import type { RunStateView, SettingsView } from '../../src/shared/rpc.ts'
import type { Pane } from '../../src/ui/state.ts'
import { THEMES, type Theme } from '../../src/ui/theme.ts'
import type { TurnView } from '../../src/ui/trajectory.ts'
import { basenameOf, childSessionsOf, elapsedOf, pagesOf } from '../lib.ts'
import type { SessionStore } from '../store.ts'
import { Review } from './review.tsx'
import { Inspector } from './inspector.tsx'
import { Button } from './ui/button.tsx'
import { Icon } from './ui/icon.tsx'
import { GoalMark, roundsOf } from './ui/goal-mark.tsx'
import { Mug } from './ui/mug.tsx'
import { Usage } from './usage.tsx'

const Goal = (props: { goal: RunStateView['goal'] }) => (
  <Show when={props.goal} fallback={<div class="run-empty">no goal</div>}>
    {(goal) => (
      <div class="run-goal">
        <span class="run-objective">{goal().objective}</span>
        <span class={'run-phase ' + goal().phase}>
          <GoalMark phase={goal().phase} />
          {goal().phase}
        </span>
        <span class="run-rounds">{roundsOf(goal().rounds, goal().maxRounds)}</span>
      </div>
    )}
  </Show>
)

/** What a todo's mark says to a reader who cannot see the icon. */
const todoState: Readonly<Record<RunStateView['todos'][number]['status'], string>> = {
  pending: 'not started',
  in_progress: 'in progress',
  completed: 'completed',
}

const Todos = (props: { todos: RunStateView['todos']; counts: RunStateView['todoCounts'] }) => (
  <Show when={props.todos.length > 0}>
    <div class="run-section">
      <span class="run-section-title">todo</span>
      <span class="run-todo-counts">
        {String(props.counts.completed) + '/' + String(props.todos.length) + ' complete'}
      </span>
    </div>
    <ul class="run-todos">
      <For each={props.todos}>
        {(todo) => (
          <li class={'run-todo ' + todo.status}>
            <span class="run-todo-mark" role="img" aria-label={todoState[todo.status]}>
              <Switch fallback={<Icon name="square" />}>
                <Match when={todo.status === 'in_progress'}>
                  <Mug state="filling" />
                </Match>
                <Match when={todo.status === 'completed'}>
                  <Icon name="check-square" />
                </Match>
              </Switch>
            </span>
            <span class="run-todo-content">{todo.content}</span>
          </li>
        )}
      </For>
    </ul>
  </Show>
)

const Skills = (props: { skills: RunStateView['skills'] }) => (
  <Show when={props.skills.length > 0}>
    <span class="run-section-title">skills</span>
    <ul class="run-skills">
      <For each={props.skills}>{(skill) => <li class="run-skill">{skill}</li>}</For>
    </ul>
  </Show>
)

const PromptSections = (props: { sections: RunStateView['promptSections'] }) => (
  <>
    <span class="run-section-title">prompt</span>
    <Show
      when={props.sections.length > 0}
      fallback={<div class="run-empty">no sections recorded</div>}
    >
      <ul class="run-prompt-sections">
        <For each={props.sections}>
          {(section) => <li class="run-prompt-section">{section}</li>}
        </For>
      </ul>
    </Show>
  </>
)

/** The links a session's finished subagents left in its conversation. */
const ChildLinks = (props: { store: SessionStore; blocks: ReadonlyArray<ConversationBlock> }) => {
  const ids = () => childSessionsOf(props.blocks)
  return (
    <Show when={ids().length > 0}>
      <ul class="run-children">
        <For each={ids()}>
          {(id) => (
            <li>
              <button
                class="run-child"
                type="button"
                data-session-id={id}
                onClick={() => props.store.moveTo(id)}
              >
                <Icon name="subagent" />
                {'subagent · ' + id.slice(0, 8)}
              </button>
            </li>
          )}
        </For>
      </ul>
    </Show>
  )
}

/** The pages the session published; the conversation holds the frames themselves. */
const Pages = (props: { pages: ReadonlyArray<string> }) => (
  <Show when={props.pages.length > 0}>
    <div class="run-section">
      <span class="run-section-title">pages</span>
    </div>
    <ul class="run-pages">
      <For each={props.pages}>
        {(page) => (
          <li class="run-page">
            <span class="run-page-name">{basenameOf(page)}</span>
            <a class="run-page-open" href={page} target="_blank" rel="noopener">
              Open in a new tab
            </a>
          </li>
        )}
      </For>
    </ul>
  </Show>
)

/** The heading of a work section: what it holds and how much of it still works. */
const WorkHeading = (props: { title: string; live: number; done: number }) => (
  <div class="run-section">
    <span class="run-section-title">{props.title}</span>
    <span class="run-work-counts">
      {String(props.live) + ' running / ' + String(props.done) + ' done'}
    </span>
  </div>
)

/** Whether a child still works; only such a child offers a stop. */
const isWorking = (child: RunStateView['subagents'][number]): boolean =>
  child.status === 'running' || child.status === 'cancelling'

/** What a child's state says as activity, next to the lifecycle word the row also shows. */
const activityOf = (status: string): string =>
  status === 'running' ? 'working' : status === 'cancelling' ? 'stopping' : 'idle'

/**
 * A stop that fires on the second press. The first press arms it, so a row
 * opened by mistake does not end work that was still wanted.
 */
const StopButton = (props: {
  class: string
  target: { kind: 'job' | 'subagent'; id: string }
  onStop: () => void
}) => {
  const [armed, setArmed] = createSignal(false)
  return (
    <button
      class={props.class + (armed() ? ' armed' : '')}
      type="button"
      aria-label={armed() ? 'press again to stop' : 'stop'}
      {...(props.target.kind === 'job'
        ? { 'data-stop-job': props.target.id }
        : { 'data-stop-subagent': props.target.id })}
      onClick={() => {
        if (!armed()) {
          setArmed(true)
          return
        }
        props.onStop()
      }}
    >
      {armed() ? 'press again' : 'stop'}
    </button>
  )
}

/** One child: its role, what it does now, and how long it has taken. */
const SubagentRow = (props: { store: SessionStore; child: RunStateView['subagents'][number] }) => {
  const duration = () => elapsedOf(props.child.startedAt, props.child.endedAt ?? Date.now())
  return (
    <li class={'run-child-row ' + props.child.status} data-subagent-id={props.child.id}>
      <button
        class="run-child"
        type="button"
        data-session-id={props.child.id}
        onClick={() => props.store.moveTo(props.child.id)}
      >
        <span class={'run-child-dot ' + props.child.status} aria-hidden="true" />
        <span class="run-child-preset">{props.child.preset ?? 'subagent'}</span>
        <span class="run-child-state">{props.child.status}</span>
        <span class="run-child-id">{props.child.id.slice(0, 8)}</span>
        <span class="run-child-activity">{activityOf(props.child.status)}</span>
        <span class="run-child-elapsed">{duration()}</span>
      </button>
      <Show when={isWorking(props.child)}>
        <StopButton
          class="run-child-stop"
          target={{ kind: 'subagent', id: props.child.id }}
          onStop={() => props.store.stopSubagent(props.child.id)}
        />
      </Show>
    </li>
  )
}

/** The children the core holds: live ones first, then the settled ones. */
const Subagents = (props: { store: SessionStore; subagents: RunStateView['subagents'] }) => {
  const live = () => props.subagents.filter(isWorking)
  const done = () =>
    props.subagents.filter((child) => !isWorking(child)).sort((a, b) => b.startedAt - a.startedAt)
  return (
    <section class="run-work run-work-subagents">
      <WorkHeading title="subagents" live={live().length} done={done().length} />
      <ul class="run-children">
        <For each={[...live(), ...done()]}>
          {(child) => <SubagentRow store={props.store} child={child} />}
        </For>
      </ul>
    </section>
  )
}

/** One job: what it runs, where it stands, and how long it took. */
const JobRow = (props: { store: SessionStore; job: RunStateView['jobs'][number] }) => {
  const running = () => props.job.running
  const duration = () => elapsedOf(props.job.startedAt, props.job.endedAt ?? Date.now())
  return (
    <li class={'run-job-row ' + (running() ? 'running' : 'done')} data-job-id={props.job.id}>
      <button
        class={'run-job ' + (running() ? 'running' : 'done')}
        type="button"
        onClick={() => props.store.openJob(props.job.id)}
      >
        <span class={'run-job-dot ' + (running() ? 'running' : 'done')} aria-hidden="true" />
        <span class="run-job-command">{props.job.command}</span>
        <span class="run-job-state">{running() ? 'running' : 'finished'}</span>
        <span class="run-job-elapsed">{duration()}</span>
      </button>
      <Show when={props.job.tail !== ''}>
        <span class="run-job-tail">{props.job.tail}</span>
      </Show>
      <Show when={running()}>
        <StopButton
          class="run-job-stop"
          target={{ kind: 'job', id: props.job.id }}
          onStop={() => props.store.stopJob(props.job.id)}
        />
      </Show>
    </li>
  )
}

/** The jobs the session started: live ones first, settled ones folded behind their count. */
const Jobs = (props: { store: SessionStore; jobs: RunStateView['jobs'] }) => {
  const live = () => props.jobs.filter((job) => job.running)
  const done = () =>
    props.jobs.filter((job) => !job.running).sort((a, b) => b.startedAt - a.startedAt)
  return (
    <section class="run-work run-work-jobs">
      <WorkHeading title="jobs" live={live().length} done={done().length} />
      <Show when={live().length > 0}>
        <ul class="run-jobs run-jobs-live">
          <For each={live()}>{(job) => <JobRow store={props.store} job={job} />}</For>
        </ul>
      </Show>
      <Show when={done().length > 0}>
        <details class="run-work-done" data-jobs-done>
          <summary class="run-work-done-head">
            <span class="run-section-title">finished</span>
            <span class="run-work-counts">{String(done().length)}</span>
          </summary>
          <ul class="run-jobs run-jobs-done">
            <For each={done()}>{(job) => <JobRow store={props.store} job={job} />}</For>
          </ul>
        </details>
      </Show>
    </section>
  )
}

const Run = (props: { store: SessionStore }) => {
  const run = () => props.store.state().run
  return (
    <>
      <h2 class="pane-title">Run</h2>
      <Show when={run()} fallback={<div class="run-empty">reading…</div>}>
        {(state) => (
          <>
            <Goal goal={state().goal} />
            <Usage usage={state().usage} />
            <Todos todos={state().todos} counts={state().todoCounts} />
            <Skills skills={state().skills} />
            <PromptSections sections={state().promptSections} />
            <Pages pages={pagesOf(props.store.state().trace)} />
            <Show when={state().schedules.length > 0}>
              <ul class="run-schedules">
                <For each={state().schedules}>
                  {(schedule) => (
                    <li>
                      <details class="run-schedule">
                        <summary>
                          <span class="run-when">{schedule.when}</span>
                          <span class="run-title">{schedule.title}</span>
                        </summary>
                        <p class="run-prompt">{schedule.prompt}</p>
                      </details>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <Show when={state().jobs.length > 0}>
              <Jobs store={props.store} jobs={state().jobs} />
            </Show>
            <Show
              when={state().subagents.length > 0}
              fallback={
                <ChildLinks store={props.store} blocks={props.store.state().conversation.blocks} />
              }
            >
              <Subagents store={props.store} subagents={state().subagents} />
            </Show>
          </>
        )}
      </Show>
    </>
  )
}

const row = (name: string, value: string) => (
  <div class="panel-row">
    <span class="panel-name">{name}</span>
    <span class="panel-value">{value}</span>
  </div>
)

const Settings = (props: { store: SessionStore; settings: SettingsView | undefined }) => (
  <>
    <h2 class="pane-title">Settings</h2>
    <span class="pane-label">theme</span>
    <div class="theme-choice">
      <For each={THEMES}>
        {(theme: Theme) => (
          <button
            class={'theme' + (theme === props.store.state().theme ? ' active' : '')}
            type="button"
            data-theme={theme}
            onClick={() => props.store.chooseTheme(theme)}
          >
            {theme}
          </button>
        )}
      </For>
    </div>
    <Show when={props.settings} fallback={<div class="card-hint">reading the settings…</div>}>
      {(settings) => (
        <>
          <span class="pane-label">run</span>
          <div class="panel-rows">
            {row('model', settings().model)}
            {row('effort', settings().effort === '' ? '(the provider chooses)' : settings().effort)}
            {row('cwd', settings().cwd)}
            {row('sessions', settings().sessionRoot)}
            {row('settings', settings().settingsPath === '' ? '(none)' : settings().settingsPath)}
          </div>
          <Show
            when={props.store.state().models}
            fallback={
              <div class="panel-actions">
                <Button id="ask-models" type="button" onClick={() => props.store.askModels()}>
                  List models
                </Button>
              </div>
            }
          >
            {(models) => (
              <>
                <div class="panel-actions">
                  <select id="model-choice">
                    <For each={models()}>{(route) => <option value={route}>{route}</option>}</For>
                  </select>
                  <Button
                    id="use-model"
                    variant="primary"
                    type="button"
                    onClick={() => {
                      const choice = document.getElementById('model-choice')
                      if (choice instanceof HTMLSelectElement && choice.value !== '') {
                        props.store.setModel(choice.value)
                      }
                    }}
                  >
                    Use for new sessions
                  </Button>
                </div>
                <div class="card-hint">
                  each session opened from now on starts from it; the settings file keeps it for
                  later runs, and the seat switches the session in front of you
                </div>
              </>
            )}
          </Show>
        </>
      )}
    </Show>
  </>
)

const durationOf = (turn: TurnView): string =>
  turn.endedAt === undefined ? 'running' : ((turn.endedAt - turn.startedAt) / 1000).toFixed(1) + 's'

const Trajectory = (props: { turns: ReadonlyArray<TurnView> }) => (
  <>
    <Show
      when={props.turns.length > 0}
      fallback={<div class="card-hint">this session has not run a turn yet</div>}
    >
      <ul class="turns">
        <For each={props.turns}>
          {(turn) => (
            <li class={'turn' + (turn.endedAt === undefined ? ' open' : '')}>
              <span class="turn-number">{'turn ' + String(turn.turn)}</span>
              <span class="turn-duration">{durationOf(turn)}</span>
              <span class="turn-counts">
                {String(turn.steps) + ' steps · ' + String(turn.tools) + ' calls'}
              </span>
              <span class="turn-outcome">{turn.outcome === '' ? '—' : turn.outcome}</span>
            </li>
          )}
        </For>
      </ul>
    </Show>
  </>
)

const Job = (props: { store: SessionStore; pane: Extract<Pane, { kind: 'job' }> }) => (
  <>
    <h2 class="pane-title">{'Job ' + props.pane.id.slice(0, 8)}</h2>
    <Show when={props.pane.detail} fallback={<div class="card-hint">reading the job…</div>}>
      {(detail) => (
        <>
          <div class="panel-rows">
            {row('command', detail().command)}
            {row('state', detail().running ? 'running' : 'done')}
          </div>
          <pre class="job-output">
            {detail().output === '' ? '(no output yet)' : detail().output}
          </pre>
          <div class="panel-actions">
            <Show when={detail().running}>
              <Button
                id="stop-job"
                type="button"
                onClick={() => props.store.stopJob(props.pane.id)}
              >
                Stop
              </Button>
            </Show>
          </div>
        </>
      )}
    </Show>
  </>
)

const PANES = [
  { kind: 'changes', label: 'changes', icon: 'changes' },
  { kind: 'run', label: 'run', icon: 'run' },
  { kind: 'settings', label: 'settings', icon: 'settings' },
  { kind: 'trajectory', label: 'turns', icon: 'turns' },
] as const

type Tab = (typeof PANES)[number]['kind']

/** The pane when it is of one kind, narrowed to it; undefined otherwise. */
const ofKind = <K extends Pane['kind']>(
  pane: Pane | undefined,
  kind: K,
): Extract<Pane, { kind: K }> | undefined =>
  pane?.kind === kind ? (pane as Extract<Pane, { kind: K }>) : undefined

/** What a tab opens: the changes pane starts on no file in particular. */
const paneFor = (kind: Tab): Pane => (kind === 'changes' ? { kind, path: undefined } : { kind })

/** The right column: what the session runs toward, is set to, did, or one job. */
export const ContextPane = (props: { store: SessionStore }) => {
  const pane = () => props.store.state().pane
  let strip: HTMLElement | undefined
  /** What the body shows while the sheet slides out; undefined once it has. */
  const [kept, setKept] = createSignal<Pane | undefined>(undefined)

  createEffect(() => {
    const current = pane()
    if (current !== undefined) {
      setKept(current)
      return
    }
    if (kept() === undefined) return
    const timer = setTimeout(() => setKept(undefined), 150)
    onCleanup(() => clearTimeout(timer))
  })

  const body = (): Pane | undefined => pane() ?? kept()
  const open = (): boolean => pane() !== undefined
  const closing = (): boolean => pane() === undefined && kept() !== undefined
  const active = (kind: Tab): boolean => pane()?.kind === kind
  const toggle = (kind: Tab): void => props.store.showPane(active(kind) ? undefined : paneFor(kind))

  // The labels differ in width, so the underline reads the chosen tab's place
  // instead of assuming an equal share of the strip.
  const place = () => {
    const current = pane()
    if (strip === undefined) return
    const picked = strip.querySelector<HTMLElement>('.tab.active')
    strip.style.setProperty('--tab-w', `${picked?.offsetWidth ?? 0}px`)
    strip.style.setProperty('--tab-x', `${current === undefined ? 0 : (picked?.offsetLeft ?? 0)}px`)
  }

  createEffect(place)
  onMount(() => {
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(place)
    if (strip !== undefined) observer.observe(strip)
    onCleanup(() => observer.disconnect())
  })

  return (
    <>
      <header class="context-head">
        <nav class="tabs" aria-label="What the pane shows" ref={(element) => (strip = element)}>
          <For each={PANES}>
            {(entry) => (
              <button
                id={entry.kind}
                class={'tab' + (active(entry.kind) ? ' active' : '')}
                type="button"
                onClick={() => toggle(entry.kind)}
              >
                <Icon name={entry.icon} />
                {entry.label}
              </button>
            )}
          </For>
          <Show when={ofKind(pane(), 'inspect')}>
            <button class="tab active" type="button">
              inspect
            </button>
          </Show>
          <Show when={ofKind(pane(), 'job')}>
            {(job) => (
              <button class="tab active" type="button">
                {'job ' + job().id.slice(0, 8)}
              </button>
            )}
          </Show>
        </nav>
        <button
          id="panel-close"
          class="pane-close"
          type="button"
          aria-label="hide the pane"
          onClick={() => props.store.showPane(undefined)}
        >
          <Icon name="close" />
        </button>
      </header>
      <div
        class="context-body"
        data-open={open() ? 'true' : 'false'}
        data-closing={closing() ? 'true' : 'false'}
      >
        <Switch>
          <Match when={ofKind(body(), 'changes')}>
            {(changes) => <Review store={props.store} path={changes().path} />}
          </Match>
          <Match when={ofKind(body(), 'inspect')}>
            {(inspect) => (
              <Inspector store={props.store} turn={inspect().turn} callId={inspect().callId} />
            )}
          </Match>
          <Match when={body()?.kind === 'run'}>
            <Run store={props.store} />
          </Match>
          <Match when={body()?.kind === 'settings'}>
            <Settings store={props.store} settings={props.store.state().settings} />
          </Match>
          <Match when={body()?.kind === 'trajectory'}>
            <Trajectory turns={props.store.state().turns} />
          </Match>
          <Match when={ofKind(body(), 'job')}>
            {(job) => <Job store={props.store} pane={job()} />}
          </Match>
        </Switch>
      </div>
    </>
  )
}
