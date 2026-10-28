import { For, Match, Show, Switch, createEffect, createSignal, onCleanup, onMount } from 'solid-js'
import type { ConversationBlock } from '@jozo-harness/ui-view'
import type {
  DelegateToolView,
  EditableSettingsView,
  PluginCatalogView,
  PluginChangeRequest,
  PluginRowView,
  PluginsView,
  RunStateView,
  SettingsView,
} from '../../src/shared/rpc.ts'
import type { Pane } from '../../src/ui/state.ts'
import { FONT_FAMILIES, FONT_SIZES, type FontFamily, type FontSize } from '../../src/ui/font.ts'
import { THEMES, type Theme } from '../../src/ui/theme.ts'
import type { TurnView } from '../../src/ui/trajectory.ts'
import { createBrowser } from '../browser.ts'
import { useLocaleChoice, useTranslate } from '../i18n.ts'
import { basenameOf, childSessionsOf, elapsedOf, pagesOf } from '../lib.ts'
import { LOCALES, type MessageKey } from '../locale.ts'
import type { ScheduleDraft, SessionStore } from '../store.ts'
import { BrowserPane } from './browser-pane.tsx'
import { FilePreview } from './file-preview.tsx'
import { FileTree } from './file-tree.tsx'
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

/** Why one page's removal did not land, as the row says it. */
const whyNotRemoved = (error: unknown): string =>
  'could not remove this page: ' + (error instanceof Error ? error.message : String(error))

/**
 * The pages the session published; the conversation holds the frames themselves.
 * A row can remove its page, which the log still names, so the page remembers
 * what it removed.
 */
const Pages = (props: { store: SessionStore; pages: ReadonlyArray<string> }) => {
  /** The pages on their way out now, so a second press while one is out does nothing. */
  const [sending, setSending] = createSignal<ReadonlyArray<string>>([])
  /** What a removal answered, by page, shown on its own row. */
  const [failed, setFailed] = createSignal<Readonly<Record<string, string>>>({})
  const shown = (): ReadonlyArray<string> =>
    props.pages.filter((page) => !props.store.state().deletedPages.includes(page))
  const remove = async (page: string): Promise<void> => {
    if (sending().includes(page)) return
    setSending((now) => [...now, page])
    setFailed((now) => {
      const next = { ...now }
      delete next[page]
      return next
    })
    try {
      const answer = await fetch(page, {
        method: 'DELETE',
        headers: { 'X-Requested-With': 'fetch' },
      })
      if (answer.status === 204) {
        props.store.pageDeleted(page)
        return
      }
      setFailed((now) => ({ ...now, [page]: 'the server answered ' + String(answer.status) }))
    } catch (error) {
      setFailed((now) => ({ ...now, [page]: whyNotRemoved(error) }))
    } finally {
      setSending((now) => now.filter((one) => one !== page))
    }
  }
  return (
    <Show when={shown().length > 0}>
      <div class="run-section">
        <span class="run-section-title">pages</span>
      </div>
      <ul class="run-pages">
        <For each={shown()}>
          {(page) => (
            <li class="run-page">
              <span class="run-page-name">{basenameOf(page)}</span>
              <a class="run-page-open" href={page} target="_blank" rel="noopener">
                Open in a new tab
              </a>
              <a class="run-page-download" href={page + '?download=1'}>
                Download
              </a>
              <button
                class="run-page-delete danger"
                type="button"
                disabled={sending().includes(page)}
                aria-label={'delete ' + basenameOf(page)}
                onClick={() => void remove(page)}
              >
                Delete
              </button>
              <Show when={(failed()[page] ?? '') !== ''}>
                <span class="run-page-error" role="alert">
                  {failed()[page] ?? ''}
                </span>
              </Show>
            </li>
          )}
        </For>
      </ul>
    </Show>
  )
}

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

/** Why a plugin request did not land, as one line. */
const pluginProblem = (error: unknown): string =>
  'the plugin change failed: ' + (error instanceof Error ? error.message : String(error))

/** What a change just did, said in the pane's own words. */
const pluginNote = (change: PluginChangeRequest, view: PluginsView): string => {
  if (change.action === 'install') return 'installed; it takes effect at the next start'
  if (change.action === 'retry') {
    return view.failures.some((failure) => failure.id === change.id)
      ? 'the row still fails; the reason is beside it'
      : 'the row is wired into this run again'
  }
  return 'the settings changed; this run keeps the tools it already wired until the next start'
}

/**
 * The rows this run was built from, the optional bundles the build carries, and
 * the rows whose wiring failed. A change writes the settings the next start
 * reads; only Retry touches the running run, by wiring the failed row again.
 */
const Plugins = () => {
  const [view, setView] = createSignal<PluginsView | undefined>(undefined)
  const [failed, setFailed] = createSignal(false)
  const [busy, setBusy] = createSignal<string | undefined>(undefined)
  const [problem, setProblem] = createSignal('')
  const [notice, setNotice] = createSignal('')
  /** The bundle whose install the page is asking the human to approve. */
  const [confirming, setConfirming] = createSignal<string | undefined>(undefined)

  const failureOf = (id: string): string | undefined =>
    view()?.failures.find((failure) => failure.id === id)?.reason

  const send = async (key: string, change: PluginChangeRequest): Promise<void> => {
    if (busy() !== undefined) return
    setBusy(key)
    setProblem('')
    setNotice('')
    try {
      const answer = await fetch('/plugins', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Requested-With': 'fetch' },
        body: JSON.stringify(change),
      })
      const text = await answer.text()
      if (!answer.ok) {
        setProblem(text)
        return
      }
      const next = JSON.parse(text) as PluginsView
      setView(next)
      setConfirming(undefined)
      setNotice(pluginNote(change, next))
    } catch (error) {
      setProblem(pluginProblem(error))
    } finally {
      setBusy(undefined)
    }
  }

  onMount(() => {
    void (async () => {
      try {
        const answer = await fetch('/plugins')
        if (!answer.ok) throw new Error(String(answer.status))
        setView((await answer.json()) as PluginsView)
      } catch {
        setFailed(true)
      }
    })()
  })

  return (
    <section class="run-work run-work-plugins">
      <span class="run-section-title">plugins</span>
      <Show
        when={view()}
        fallback={
          <Show when={failed()} fallback={<div class="run-empty">reading…</div>}>
            <div class="run-empty">could not read the plugin rows</div>
          </Show>
        }
      >
        {(current) => (
          <>
            <Show
              when={current().rows.length > 0}
              fallback={<div class="run-empty">no plugin rows</div>}
            >
              <ul class="run-plugins">
                <For each={current().rows}>
                  {(row: PluginRowView) => (
                    <li class="run-plugin" data-plugin={row.id}>
                      <span class="run-plugin-name">{row.name}</span>
                      <span class={'run-plugin-state ' + (row.enabled ? 'on' : 'off')}>
                        {row.enabled ? 'on' : 'off'}
                      </span>
                      <Show when={!row.running}>
                        <span class="run-plugin-next">next start</span>
                      </Show>
                      <button
                        class="run-plugin-toggle"
                        type="button"
                        data-plugin-toggle={row.id}
                        disabled={busy() !== undefined}
                        onClick={() =>
                          void send(row.id, {
                            action: 'set-enabled',
                            id: row.id,
                            enabled: !row.enabled,
                          })
                        }
                      >
                        {row.enabled ? 'Turn off' : 'Turn on'}
                      </button>
                      <Show when={failureOf(row.id)}>
                        {(reason) => (
                          <>
                            <span class="run-plugin-failure" role="alert">
                              {reason()}
                            </span>
                            <button
                              class="run-plugin-retry"
                              type="button"
                              data-plugin-retry={row.id}
                              disabled={busy() !== undefined}
                              onClick={() => void send(row.id, { action: 'retry', id: row.id })}
                            >
                              Retry
                            </button>
                          </>
                        )}
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <Show when={current().catalog.length > 0}>
              <span class="run-section-title">optional bundles</span>
              <ul class="run-plugin-catalog">
                <For each={current().catalog}>
                  {(bundle: PluginCatalogView) => (
                    <li class="run-bundle" data-bundle={bundle.id}>
                      <span class="run-plugin-name">{bundle.name}</span>
                      <span class="run-bundle-summary">{bundle.summary}</span>
                      <Show
                        when={!bundle.installed}
                        fallback={<span class="run-plugin-next">installed</span>}
                      >
                        <Show
                          when={!bundle.needsConfig}
                          fallback={
                            <span class="run-plugin-next">needs config in the settings file</span>
                          }
                        >
                          <Show
                            when={confirming() === bundle.id}
                            fallback={
                              <button
                                class="run-plugin-install"
                                type="button"
                                data-plugin-install={bundle.id}
                                disabled={busy() !== undefined}
                                onClick={() => setConfirming(bundle.id)}
                              >
                                Install
                              </button>
                            }
                          >
                            <span class="run-bundle-ask">
                              {'Install ' + bundle.name + ' for the next start?'}
                            </span>
                            <button
                              class="run-plugin-install"
                              type="button"
                              data-plugin-confirm={bundle.id}
                              disabled={busy() !== undefined}
                              onClick={() =>
                                void send(bundle.id, {
                                  action: 'install',
                                  id: bundle.id,
                                  name: bundle.name,
                                })
                              }
                            >
                              Install
                            </button>
                            <button
                              class="run-plugin-cancel"
                              type="button"
                              data-plugin-cancel={bundle.id}
                              onClick={() => setConfirming(undefined)}
                            >
                              Cancel
                            </button>
                          </Show>
                        </Show>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <Show when={problem() !== ''}>
              <div class="run-plugin-problem" role="alert">
                {problem()}
              </div>
            </Show>
            <Show when={notice() !== ''}>
              <div class="run-plugin-notice">{notice()}</div>
            </Show>
          </>
        )}
      </Show>
    </section>
  )
}

/** The kinds a page offers; each maps to one field of the model's schedule tool. */
const SCHEDULE_KINDS = ['after', 'daily', 'weekly', 'cron', 'at'] as const
type ScheduleKind = (typeof SCHEDULE_KINDS)[number]

const WHEN_HINT: Readonly<Record<ScheduleKind, string>> = {
  after: 'seconds from now',
  daily: '08:30',
  weekly: '08:30',
  cron: '30 18 * * 1-5',
  at: 'date and time',
}

/** The New schedule form and the standing ones, over the same host store as the tool. */
const Schedules = (props: { store: SessionStore; schedules: RunStateView['schedules'] }) => {
  const [building, setBuilding] = createSignal(false)
  const [prompt, setPrompt] = createSignal('')
  const [title, setTitle] = createSignal('')
  const [kind, setKind] = createSignal<ScheduleKind>('after')
  const [when, setWhen] = createSignal('60')
  const [weekdays, setWeekdays] = createSignal('1')
  const [zone, setZone] = createSignal('')

  /** The prompt and title every draft carries; only a wall-clock kind keeps the zone. */
  const draftBase = (zoned: boolean): ScheduleDraft => ({
    prompt: prompt(),
    ...(title().trim() === '' ? {} : { title: title().trim() }),
    ...(zoned && zone().trim() !== '' ? { timeZone: zone().trim() } : {}),
  })

  /** A blank seconds field still opens the form; only a number becomes the rule. */
  const afterDraft = (draft: ScheduleDraft, when: string): ScheduleDraft => {
    const seconds = Number(when)
    return Number.isFinite(seconds) ? { ...draft, after: seconds } : draft
  }

  const weeklyDraft = (draft: ScheduleDraft, days: string, time: string): ScheduleDraft => ({
    ...draft,
    weekly: {
      weekdays: days
        .split(',')
        .map((day) => Number(day.trim()))
        .filter((day) => Number.isInteger(day)),
      time,
    },
  })

  /** A time the page cannot read becomes no draft, rather than a rule the host must refuse. */
  const atDraft = (draft: ScheduleDraft, when: string): ScheduleDraft | undefined => {
    const at = new Date(when)
    return Number.isNaN(at.getTime()) ? undefined : { ...draft, at: at.toISOString() }
  }

  const draftOf = (): ScheduleDraft | undefined => {
    if (prompt().trim() === '') return undefined
    switch (kind()) {
      case 'after':
        return afterDraft(draftBase(false), when())
      case 'daily':
        return { ...draftBase(true), daily: when().trim() }
      case 'weekly':
        return weeklyDraft(draftBase(true), weekdays(), when().trim())
      case 'cron':
        return { ...draftBase(true), cron: when().trim() }
      case 'at':
        return atDraft(draftBase(false), when())
    }
  }

  const create = () => {
    const draft = draftOf()
    if (draft === undefined) return
    props.store.createSchedule(draft)
    setPrompt('')
    setTitle('')
    setBuilding(false)
  }

  return (
    <div class="run-schedules-wrap">
      <div class="run-section">
        <span class="run-section-title">schedules</span>
        <button class="run-schedule-new" type="button" onClick={() => setBuilding(!building())}>
          {building() ? 'Cancel' : 'New'}
        </button>
      </div>
      <Show when={building()}>
        <div class="run-schedule-form">
          <input
            class="run-schedule-prompt"
            placeholder="what to tell the model"
            value={prompt()}
            onInput={(event) => setPrompt(event.currentTarget.value)}
          />
          <input
            class="run-schedule-title"
            placeholder="title (optional)"
            value={title()}
            onInput={(event) => setTitle(event.currentTarget.value)}
          />
          <select
            class="run-schedule-kind"
            value={kind()}
            onChange={(event) => {
              const next = event.currentTarget.value as ScheduleKind
              setKind(next)
              setWhen(next === 'after' ? '60' : next === 'at' ? '' : '08:30')
            }}
          >
            <For each={SCHEDULE_KINDS}>{(each) => <option value={each}>{each}</option>}</For>
          </select>
          <Show when={kind() === 'weekly'}>
            <input
              class="run-schedule-weekdays"
              placeholder="weekdays, 1 = Monday"
              value={weekdays()}
              onInput={(event) => setWeekdays(event.currentTarget.value)}
            />
          </Show>
          <input
            class="run-schedule-when"
            type={kind() === 'at' ? 'datetime-local' : 'text'}
            placeholder={WHEN_HINT[kind()]}
            value={when()}
            onInput={(event) => setWhen(event.currentTarget.value)}
          />
          <Show when={kind() === 'daily' || kind() === 'weekly' || kind() === 'cron'}>
            <input
              class="run-schedule-zone"
              placeholder="IANA zone (optional)"
              value={zone()}
              onInput={(event) => setZone(event.currentTarget.value)}
            />
          </Show>
          <button class="run-schedule-create" type="button" onClick={create}>
            Create
          </button>
        </div>
      </Show>
      <Show
        when={props.schedules.length === 0}
        fallback={
          <ul class="run-schedules">
            <For each={props.schedules}>
              {(schedule) => (
                <li>
                  <details class="run-schedule">
                    <summary>
                      <span class="run-when">{schedule.when}</span>
                      <span class="run-title">{schedule.title}</span>
                      <Show when={schedule.paused}>
                        <span class="run-paused">paused</span>
                      </Show>
                    </summary>
                    <p class="run-prompt">{schedule.prompt}</p>
                    <div class="run-schedule-actions">
                      <button
                        type="button"
                        class="run-schedule-pause"
                        onClick={() =>
                          props.store.pauseSchedule(schedule.id, schedule.paused !== true)
                        }
                      >
                        {schedule.paused === true ? 'Resume' : 'Stop'}
                      </button>
                      <button
                        type="button"
                        class="run-schedule-delete"
                        onClick={() => props.store.deleteSchedule(schedule.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </details>
                </li>
              )}
            </For>
          </ul>
        }
      >
        <div class="run-empty">no schedules</div>
      </Show>
    </div>
  )
}

/**
 * The two ways a session leaves the page: the log a jzh can open again, and a
 * transcript to paste. Copying reads the same route a download would, so neither
 * asks the model for anything.
 */
const SessionExport = (props: { store: SessionStore }) => {
  const [notice, setNotice] = createSignal('')
  const id = (): string => props.store.state().sessionId
  const copy = async (): Promise<void> => {
    setNotice('')
    try {
      const answer = await fetch('/session/' + id() + '/transcript.md')
      if (!answer.ok) {
        setNotice('the server answered ' + String(answer.status))
        return
      }
      await navigator.clipboard.writeText(await answer.text())
      setNotice('copied')
    } catch (error) {
      setNotice('could not copy: ' + (error instanceof Error ? error.message : String(error)))
    }
  }
  return (
    <div class="run-section">
      <span class="run-section-title">export</span>
      <span class="run-exports">
        <a class="run-export" href={'/session/' + id() + '/log.zip'} download="">
          Download log
        </a>
        <button class="run-export" type="button" onClick={() => void copy()}>
          Copy transcript
        </button>
        <Show when={notice() !== ''}>
          <span class="run-export-notice" role="status">
            {notice()}
          </span>
        </Show>
      </span>
    </div>
  )
}

const PERMISSION_CHOICES = ['read-only', 'workspace-write', 'danger-full-access'] as const

type PermissionChoice = (typeof PERMISSION_CHOICES)[number]

/**
 * The boundary the next tool call runs under. A click sends the same slash
 * command a human would type, so the switch lands in the log like any other.
 * danger-full-access only asks on the page after a second, explicit confirm:
 * the model must not be able to widen itself, and the page is the human's act.
 */
const Permission = (props: { store: SessionStore; current: PermissionChoice }) => {
  const [confirming, setConfirming] = createSignal(false)
  const send = (choice: PermissionChoice): void => {
    setConfirming(false)
    props.store.send({ kind: 'submit', text: '/permission ' + choice })
  }
  const choose = (choice: PermissionChoice): void => {
    if (choice === props.current) return
    if (choice === 'danger-full-access') setConfirming(true)
    else send(choice)
  }
  return (
    <div class="run-section">
      <span class="run-section-title">permission</span>
      <div class="permission-choice">
        <For each={PERMISSION_CHOICES}>
          {(choice) => (
            <button
              class={'permission' + (choice === props.current ? ' active' : '')}
              type="button"
              data-permission={choice}
              aria-pressed={choice === props.current}
              onClick={() => choose(choice)}
            >
              {choice}
            </button>
          )}
        </For>
      </div>
      <Show when={confirming()}>
        <div class="permission-confirm" role="alert">
          <span>danger-full-access removes the sandbox for every later call.</span>
          <Button
            id="confirm-permission"
            variant="primary"
            type="button"
            onClick={() => send('danger-full-access')}
          >
            Confirm danger-full-access
          </Button>
          <button class="permission-cancel" type="button" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      </Show>
      <div class="card-hint">applies to the next tool call and stays in this session's log</div>
    </div>
  )
}

const Run = (props: { store: SessionStore }) => {
  const t = useTranslate()
  const run = () => props.store.state().run
  return (
    <>
      <h2 class="pane-title">{t('run.title')}</h2>
      <Show when={run()} fallback={<div class="run-empty">{t('run.reading')}</div>}>
        {(state) => (
          <>
            <Goal goal={state().goal} />
            <Usage usage={state().usage} />
            <Permission store={props.store} current={state().permission ?? 'workspace-write'} />
            <Plugins />
            <Todos todos={state().todos} counts={state().todoCounts} />
            <Skills skills={state().skills} />
            <PromptSections sections={state().promptSections} />
            <SessionExport store={props.store} />
            <Pages store={props.store} pages={pagesOf(props.store.state().trace)} />
            <Schedules store={props.store} schedules={state().schedules} />
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

/** One invitation the owner issued, as /share lists it. */
interface Invitation {
  readonly id: string
  readonly label: string
  readonly joinedAt: number
  readonly url: string
}

/** One JSON object's fields, or undefined for a value that is not an object. */
const fieldsOf = (value: unknown): Readonly<Record<string, unknown>> | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const entries: ReadonlyArray<[string, unknown]> = Object.entries(value)
  return Object.fromEntries(entries)
}

/** One invitation as the share route lists it; undefined for a row this page cannot read. */
const invitationOf = (value: unknown): Invitation | undefined => {
  const fields = fieldsOf(value)
  if (fields === undefined) return undefined
  const { id, label, joinedAt, url } = fields
  if (typeof id !== 'string' || typeof label !== 'string' || typeof url !== 'string') {
    return undefined
  }
  if (typeof joinedAt !== 'number') return undefined
  return { id, label, joinedAt, url }
}

/** The invitations a share reply names; undefined for a reply this page cannot read. */
const invitationsOf = (value: unknown): ReadonlyArray<Invitation> | undefined => {
  const fields = fieldsOf(value)
  if (fields === undefined) return undefined
  const items = fields['items']
  if (!Array.isArray(items)) return undefined
  const listed: Array<Invitation> = []
  for (const item of items) {
    const invitation = invitationOf(item)
    if (invitation === undefined) return undefined
    listed.push(invitation)
  }
  return listed
}

/**
 * The owner's invitation controls. A participant's page asks the same route and
 * is refused, so it never draws them: an invitation can be used but not passed on.
 * The link is the whole credential, so it is shown rather than copied silently.
 */
const Share = () => {
  const [items, setItems] = createSignal<ReadonlyArray<Invitation>>([])
  const [owner, setOwner] = createSignal(false)
  const [label, setLabel] = createSignal('')
  const [failed, setFailed] = createSignal('')
  const [copied, setCopied] = createSignal('')
  const [busy, setBusy] = createSignal(false)

  const ask = async (method: string, url: string): Promise<Response | undefined> => {
    try {
      return await fetch(url, { method, headers: { 'X-Requested-With': 'fetch' } })
    } catch {
      setFailed('the server did not answer')
      return undefined
    }
  }

  const read = async (): Promise<void> => {
    try {
      const answer = await ask('GET', '/share')
      if (answer?.status !== 200) return
      const listed = invitationsOf(await answer.json())
      if (listed === undefined) return
      setItems(listed)
      setOwner(true)
    } catch {
      // A page served without the share route simply keeps the controls hidden.
    }
  }
  onMount(() => void read())

  const invite = async (): Promise<void> => {
    setFailed('')
    setBusy(true)
    const answer = await ask('POST', '/share?label=' + encodeURIComponent(label()))
    setBusy(false)
    if (answer?.status !== 201) {
      setFailed('the server answered ' + String(answer?.status ?? 0))
      return
    }
    const added = invitationOf(await answer.json())
    if (added === undefined) {
      setFailed('the server answered an invitation this page cannot read')
      return
    }
    setItems((now) => [...now, added])
    setLabel('')
  }

  const cut = async (id: string): Promise<void> => {
    setFailed('')
    const answer = await ask('DELETE', '/share/' + encodeURIComponent(id))
    if (answer?.status !== 200) {
      setFailed('the server answered ' + String(answer?.status ?? 0))
      return
    }
    setItems((now) => now.filter((one) => one.id !== id))
  }

  const copy = async (invitation: Invitation): Promise<void> => {
    try {
      await navigator.clipboard.writeText(invitation.url)
      setCopied(invitation.id)
    } catch {
      setCopied('')
      setFailed('select the link and copy it')
    }
  }

  return (
    <Show when={owner()}>
      <span class="pane-label">share this run</span>
      <div class="panel-actions">
        <input
          class="share-label"
          type="text"
          value={label()}
          placeholder="who is joining"
          aria-label="who is joining"
          onInput={(event) => setLabel(event.currentTarget.value)}
        />
        <Button
          id="invite"
          variant="primary"
          type="button"
          disabled={busy()}
          onClick={() => void invite()}
        >
          Invite
        </Button>
      </div>
      <Show when={failed() !== ''}>
        <div class="card-hint">{failed()}</div>
      </Show>
      <Show
        when={items().length > 0}
        fallback={<div class="card-hint">nobody else can open this run yet</div>}
      >
        <ul class="share-list">
          <For each={items()}>
            {(invitation) => (
              <li class="share-row">
                <span class="share-name">{invitation.label}</span>
                <input
                  class="share-link"
                  type="text"
                  readOnly
                  value={invitation.url}
                  aria-label={'invitation link for ' + invitation.label}
                  onFocus={(event) => event.currentTarget.select()}
                />
                <Button type="button" variant="quiet" onClick={() => void copy(invitation)}>
                  {copied() === invitation.id ? 'Copied' : 'Copy'}
                </Button>
                <Button type="button" variant="quiet" onClick={() => void cut(invitation.id)}>
                  Cut
                </Button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </Show>
  )
}

/** A delegated tool as one line of the form: the name, then the argv it starts. */
const delegateTextOf = (tools: ReadonlyArray<DelegateToolView>): string =>
  tools.map((tool) => [tool.name, ...tool.argv].join(' ')).join('\n')

type ParsedTools =
  | { readonly ok: true; readonly tools: ReadonlyArray<DelegateToolView> }
  | { readonly ok: false; readonly line: number }

/** One tool per line; a line without a name or without an argv word is refused. */
const toolsFromText = (text: string): ParsedTools => {
  const tools: Array<DelegateToolView> = []
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  for (const [index, line] of lines.entries()) {
    const [name, ...argv] = line.split(/\s+/)
    if (name === undefined || name === '' || argv.length === 0) {
      return { ok: false, line: index + 1 }
    }
    tools.push({ name, argv })
  }
  return { ok: true, tools }
}

/** The values the settings pane may edit, with the sources the server resolved. */
const EditableSettings = (props: { store: SessionStore }) => {
  const t = useTranslate()
  const [search, setSearch] = createSignal('')
  const [apiKeyRef, setApiKeyRef] = createSignal('')
  const [bashTimeout, setBashTimeout] = createSignal('')
  const [parallel, setParallel] = createSignal('')
  const [depth, setDepth] = createSignal('')
  const [delegateText, setDelegateText] = createSignal('')
  const [formProblem, setFormProblem] = createSignal('')
  let loaded: EditableSettingsView | undefined

  // The pane asks once; a server that answers later fills the form, and a save
  // replaces it, but typing in between is not overwritten by an unrelated update.
  onMount(() => {
    if (props.store.state().editable === undefined) props.store.askRunSettings()
  })
  createEffect(() => {
    const view = props.store.state().editable
    if (view === undefined || view === loaded) return
    loaded = view
    setSearch(view.search.provider ?? '')
    setApiKeyRef(view.apiKeyRef.ref)
    setBashTimeout(String(view.bashTimeoutMs.value))
    setParallel(String(view.maxParallelToolCalls.value))
    setDepth(String(view.subagentDepth.value))
    setDelegateText(delegateTextOf(view.delegateTools))
  })

  const save = () => {
    const parsed = toolsFromText(delegateText())
    if (!parsed.ok) {
      setFormProblem(t('settings.invalidDelegate') + ' ' + String(parsed.line))
      return
    }
    const numbers = {
      bashTimeoutMs: Number(bashTimeout()),
      maxParallelToolCalls: Number(parallel()),
      subagentDepth: Number(depth()),
    }
    const field = Object.entries(numbers).find(([, value]) => !Number.isInteger(value))
    if (field !== undefined) {
      setFormProblem(t('settings.invalidNumber') + ' ' + field[0])
      return
    }
    setFormProblem('')
    props.store.saveRunSettings({
      search: search(),
      apiKeyRef: apiKeyRef(),
      ...numbers,
      delegateTools: parsed.tools,
    })
  }

  return (
    <Show
      when={props.store.state().editable}
      fallback={<div class="card-hint">{t('settings.reading')}</div>}
    >
      {(view) => (
        <>
          <span class="pane-label">{t('settings.edit')}</span>
          <div class="settings-form">
            <label class="settings-field">
              <span>{t('settings.searchProvider')}</span>
              <select
                id="search-provider"
                value={search()}
                onChange={(event) => setSearch(event.currentTarget.value)}
              >
                <option value="">{t('settings.searchOff')}</option>
                <For each={['brave', 'deepseek', 'exa', 'perplexity']}>
                  {(provider) => <option value={provider}>{provider}</option>}
                </For>
              </select>
              <span class="settings-source">
                {view().search.keyName === ''
                  ? t('settings.source') + ': ' + view().search.source
                  : view().search.keyName +
                    ': ' +
                    t(view().search.keyPresent ? 'settings.keyPresent' : 'settings.keyMissing') +
                    ' · ' +
                    t('settings.source') +
                    ': ' +
                    view().search.source}
              </span>
            </label>
            <label class="settings-field">
              <span>{t('settings.apiKeyRef')}</span>
              <input
                id="api-key-ref"
                type="text"
                value={apiKeyRef()}
                onInput={(event) => setApiKeyRef(event.currentTarget.value)}
                placeholder={t('settings.apiKeyRefHint')}
              />
              <span class="settings-source">
                {view().apiKeyRef.ref === ''
                  ? t('settings.none')
                  : t(view().apiKeyRef.present ? 'settings.keyPresent' : 'settings.keyMissing') +
                    ' · ' +
                    t('settings.source') +
                    ': ' +
                    view().apiKeyRef.source}
              </span>
            </label>
            <label class="settings-field">
              <span>{t('settings.bashTimeout')}</span>
              <input
                id="bash-timeout"
                type="number"
                min="1"
                max="600000"
                value={bashTimeout()}
                onInput={(event) => setBashTimeout(event.currentTarget.value)}
              />
              <span class="settings-source">
                {t('settings.source') + ': ' + view().bashTimeoutMs.source}
              </span>
            </label>
            <label class="settings-field">
              <span>{t('settings.maxParallel')}</span>
              <input
                id="max-parallel"
                type="number"
                min="1"
                max="64"
                value={parallel()}
                onInput={(event) => setParallel(event.currentTarget.value)}
              />
              <span class="settings-source">
                {t('settings.source') + ': ' + view().maxParallelToolCalls.source}
              </span>
            </label>
            <label class="settings-field">
              <span>{t('settings.subagentDepth')}</span>
              <input
                id="subagent-depth"
                type="number"
                min="0"
                max="8"
                value={depth()}
                onInput={(event) => setDepth(event.currentTarget.value)}
              />
              <span class="settings-source">
                {t('settings.source') + ': ' + view().subagentDepth.source}
              </span>
            </label>
            <label class="settings-field">
              <span>{t('settings.delegateTools')}</span>
              <textarea
                id="delegate-tools"
                rows="3"
                value={delegateText()}
                onInput={(event) => setDelegateText(event.currentTarget.value)}
                placeholder={t('settings.delegateHint')}
              />
              <span class="settings-source">{t('settings.delegateHint')}</span>
            </label>
          </div>
          <Show when={formProblem() !== '' ? formProblem() : props.store.state().settingsProblem}>
            {(problem) => <div class="settings-problem">{problem()}</div>}
          </Show>
          <div class="panel-actions">
            <Button id="save-settings" variant="primary" type="button" onClick={save}>
              {t('settings.save')}
            </Button>
          </div>
          <div class="card-hint">{t('settings.saveHint')}</div>
        </>
      )}
    </Show>
  )
}

/** Each face is named by the sheet's own word for it, so the buttons read alike in both languages. */
const familyLabel: Record<FontFamily, MessageKey> = {
  sans: 'settings.font.sans',
  serif: 'settings.font.serif',
  mono: 'settings.font.mono',
}

const Settings = (props: { store: SessionStore; settings: SettingsView | undefined }) => {
  const t = useTranslate()
  const choice = useLocaleChoice()
  return (
    <>
      <h2 class="pane-title">{t('settings.title')}</h2>
      <span class="pane-label">{t('settings.theme')}</span>
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
      <span class="pane-label">{t('settings.font')}</span>
      <div class="theme-choice" role="group" aria-label={t('settings.font')}>
        <For each={FONT_FAMILIES}>
          {(family: FontFamily) => (
            <button
              class={'theme' + (family === props.store.state().fontFamily ? ' active' : '')}
              type="button"
              data-font={family}
              aria-pressed={family === props.store.state().fontFamily}
              onClick={() => props.store.chooseFontFamily(family)}
            >
              {t(familyLabel[family])}
            </button>
          )}
        </For>
      </div>
      <span class="pane-label">{t('settings.fontSize')}</span>
      <div class="theme-choice" role="group" aria-label={t('settings.fontSize')}>
        <For each={FONT_SIZES}>
          {(size: FontSize) => (
            <button
              class={'theme' + (size === props.store.state().fontSize ? ' active' : '')}
              type="button"
              data-font-size={String(size)}
              aria-pressed={size === props.store.state().fontSize}
              onClick={() => props.store.chooseFontSize(size)}
            >
              {String(size) + 'px'}
            </button>
          )}
        </For>
      </div>
      <span class="pane-label">{t('settings.language')}</span>
      <div class="theme-choice" role="group" aria-label={t('settings.language')}>
        <For each={LOCALES}>
          {(known) => (
            <button
              class={'theme' + (known.id === choice.locale() ? ' active' : '')}
              type="button"
              data-locale={known.id}
              lang={known.id}
              aria-pressed={known.id === choice.locale()}
              onClick={() => choice.choose(known.id)}
            >
              {known.label}
            </button>
          )}
        </For>
      </div>
      <Show when={props.settings} fallback={<div class="card-hint">{t('settings.reading')}</div>}>
        {(settings) => (
          <>
            <span class="pane-label">{t('settings.run')}</span>
            <div class="panel-rows">
              {row(t('settings.model'), settings().model)}
              {row(
                t('settings.effort'),
                settings().effort === '' ? t('settings.providerChooses') : settings().effort,
              )}
              {row(t('settings.cwd'), settings().cwd)}
              {row(t('settings.sessions'), settings().sessionRoot)}
              {row(
                t('settings.settingsPath'),
                settings().settingsPath === '' ? t('settings.none') : settings().settingsPath,
              )}
            </div>
            <Show
              when={props.store.state().models}
              fallback={
                <div class="panel-actions">
                  <Button id="ask-models" type="button" onClick={() => props.store.askModels()}>
                    {t('settings.listModels')}
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
                      {t('settings.useForNewSessions')}
                    </Button>
                  </div>
                  <div class="card-hint">{t('settings.useHint')}</div>
                </>
              )}
            </Show>
          </>
        )}
      </Show>
      <EditableSettings store={props.store} />
      <Share />
    </>
  )
}

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

const Job = (props: { store: SessionStore; pane: Extract<Pane, { kind: 'job' }> }) => {
  const t = useTranslate()
  return (
    <>
      <h2 class="pane-title">{t('run.jobTitle') + props.pane.id.slice(0, 8)}</h2>
      <Show when={props.pane.detail} fallback={<div class="card-hint">{t('job.reading')}</div>}>
        {(detail) => (
          <>
            <div class="panel-rows">
              {row(t('job.command'), detail().command)}
              {row(t('job.state'), t(detail().running ? 'job.running' : 'job.done'))}
            </div>
            <pre class="job-output">
              {detail().output === '' ? t('job.noOutput') : detail().output}
            </pre>
            <div class="panel-actions">
              <Show when={detail().running}>
                <Button
                  id="stop-job"
                  type="button"
                  onClick={() => props.store.stopJob(props.pane.id)}
                >
                  {t('job.stop')}
                </Button>
              </Show>
            </div>
          </>
        )}
      </Show>
    </>
  )
}

const PANES = [
  { kind: 'changes', label: 'pane.changes', icon: 'changes' },
  { kind: 'files', label: 'pane.files', icon: 'folder' },
  { kind: 'browser', label: 'pane.browser', icon: 'web' },
  { kind: 'run', label: 'pane.run', icon: 'run' },
  { kind: 'settings', label: 'pane.settings', icon: 'settings' },
  { kind: 'trajectory', label: 'pane.turns', icon: 'turns' },
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
  const t = useTranslate()
  /** The reader's pages stay beside the pane, so a look at another tab keeps them. */
  const browser = createBrowser()
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
        <nav class="tabs" aria-label={t('pane.tabs')} ref={(element) => (strip = element)}>
          <For each={PANES}>
            {(entry) => (
              <button
                id={entry.kind}
                class={'tab' + (active(entry.kind) ? ' active' : '')}
                type="button"
                onClick={() => toggle(entry.kind)}
              >
                <Icon name={entry.icon} />
                {t(entry.label)}
              </button>
            )}
          </For>
          <Show when={ofKind(pane(), 'inspect')}>
            <button class="tab active" type="button">
              {t('pane.inspect')}
            </button>
          </Show>
          <Show when={ofKind(pane(), 'job')}>
            {(job) => (
              <button class="tab active" type="button">
                {t('pane.job') + job().id.slice(0, 8)}
              </button>
            )}
          </Show>
          <Show when={ofKind(pane(), 'preview')}>
            {(preview) => (
              <button class="tab active" type="button" title={preview().path}>
                {preview().path.split('/').at(-1) ?? preview().path}
              </button>
            )}
          </Show>
        </nav>
        <button
          id="panel-close"
          class="pane-close"
          type="button"
          aria-label={t('pane.close')}
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
          <Match when={body()?.kind === 'files'}>
            <FileTree store={props.store} />
          </Match>
          <Match when={body()?.kind === 'browser'}>
            <BrowserPane browser={browser} />
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
          <Match when={ofKind(body(), 'preview')}>
            {(preview) => <FilePreview store={props.store} path={preview().path} />}
          </Match>
        </Switch>
      </div>
    </>
  )
}
