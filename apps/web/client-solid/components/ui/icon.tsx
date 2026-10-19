import { createUniqueId, type JSX } from 'solid-js'

const line = (d: string): JSX.Element => <path class="icon-line" d={d} />
const ring = (cx: number, cy: number, r: number): JSX.Element => (
  <circle class="icon-line" cx={cx} cy={cy} r={r} />
)
const dot = (cx: number, cy: number, r: number): JSX.Element => (
  <circle class="icon-fill" cx={cx} cy={cy} r={r} />
)
const PAGE = 'M4 2h5l3 3v9H4z'

/**
 * The line icons the page draws itself, so it carries no icon package. Working
 * and waiting are the mug's, not these: beer means work or a wait, nothing else.
 */
const SHAPES = {
  'chevron-down': () => line('M3.5 6 8 10.5 12.5 6'),
  square: () => <rect class="icon-line" x="2.75" y="2.75" width="10.5" height="10.5" rx="2.5" />,
  // The check is cut out of the box, so it shows whatever the box sits on.
  'check-square': (id: string) => (
    <>
      <mask id={id}>
        <rect width="16" height="16" fill="white" />
        <path
          d="M5 8.2l2 2 4-4.2"
          fill="none"
          stroke="black"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </mask>
      <rect x="2" y="2" width="12" height="12" rx="3" fill="currentColor" mask={`url(#${id})`} />
    </>
  ),
  // A finish is a dot, not a check: the row's words say what was done, the dot only how it went.
  done: () => dot(8, 8, 3.5),
  failed: () => dot(8, 8, 3.5),
  idle: () => ring(8, 8, 2.5),
  plus: () => line('M8 3v10M3 8h10'),
  search: () => [ring(7, 7, 4.25), line('M10.2 10.2 13.5 13.5')],
  folder: () => line('M2 4.5h4l1.5 1.5H14v6.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z'),
  clock: () => [ring(8, 8, 5.75), line('M8 5v3l2 1.5')],
  answers: () =>
    line(
      'M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7.5L4.5 14v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z',
    ),
  timeline: () => line('M2.5 4h6M5 8h8.5M3.5 12h5'),
  changes: () => line('M8 2.5v5M5.5 5h5M5.5 11.5h5M3 14h10'),
  run: () => line('M2 8.5h2.8l1.7-4.5 3 9 1.7-4.5H14'),
  settings: () => [
    line('M2.5 4.5h1.8M7.7 4.5h5.8M2.5 11.5h6.3M12.2 11.5h1.3'),
    ring(6, 4.5, 1.7),
    ring(10.5, 11.5, 1.7),
  ],
  turns: () => [line('M6 4h7.5M6 8h7.5M6 12h7.5'), dot(3, 4, 1), dot(3, 8, 1), dot(3, 12, 1)],
  close: () => line('M4 4l8 8M12 4l-8 8'),
  read: () => line(PAGE + 'M9 2v3h3M6 8.5h4M6 11h3'),
  write: () => line(PAGE + 'M9 2v3h3M8 7.5v4.5M5.8 9.8h4.4'),
  edit: () => line('M10.5 2.5l3 3L6 13H3v-3zM9 4l3 3'),
  bash: () => [
    <rect class="icon-line" x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />,
    line('M4.5 6.5 6.5 8l-2 1.5M8 10h3.5'),
  ],
  code: () => line('M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5'),
  grep: () => [ring(7, 7, 4.25), line('M10.2 10.2 13.5 13.5M5.5 7h3')],
  web: () => [
    ring(8, 8, 5.75),
    line('M2.25 8h11.5M8 2.25c2 2 2 9.5 0 11.5M8 2.25c-2 2-2 9.5 0 11.5'),
  ],
  skill: () =>
    line(
      'M8 4.2C6.5 3.2 4.5 3 2.5 3.3v9c2-.3 4 0 5.5 1 1.5-1 3.5-1.3 5.5-1v-9C11.5 3 9.5 3.2 8 4.2zM8 4.2v9',
    ),
  subagent: () => [
    ring(4, 3.8, 1.6),
    ring(4, 12.2, 1.6),
    ring(12, 6, 1.6),
    line('M4 5.4v5.2M4 10c0-2.6 2.2-4 6.4-4'),
  ],
  todo: () => line('M2.5 4.5l1.2 1.2 2-2.2M8 4.5h5.5M2.5 11.5l1.2 1.2 2-2.2M8 11.5h5.5'),
  job: () => [line('M3 5.5h10M3 8h10M3 10.5h6'), dot(12, 11, 1.6)],
  ask: () => [
    ring(8, 8, 5.75),
    line('M6.3 6.3a1.8 1.8 0 1 1 2.5 1.7c-.5.2-.8.6-.8 1.1v.3'),
    dot(8, 11.3, 0.8),
  ],
  image: () => [
    <rect class="icon-line" x="2.25" y="3" width="11.5" height="10" rx="1.5" />,
    ring(6, 6.5, 1),
    line('M2.5 11.5l3.3-3 3 2.6 2-1.6 2.7 2.2'),
  ],
  tool: () => line('M8 3 13 8 8 13 3 8z'),
  send: () => line('M8 13V3.5M4 7.5l4-4 4 4'),
  stop: () => <rect class="icon-fill" x="4" y="4" width="8" height="8" rx="1.8" />,
  model: () => [
    <rect class="icon-line" x="4" y="4" width="8" height="8" rx="1.5" />,
    line(
      'M6.5 1.8v2.2M9.5 1.8v2.2M6.5 12v2.2M9.5 12v2.2M1.8 6.5H4M1.8 9.5H4M12 6.5h2.2M12 9.5h2.2',
    ),
  ],
  effort: () => line('M2.5 12a5.5 5.5 0 1 1 11 0M8 12l2.6-3.2'),
  approval: () =>
    line('M8 1.8l5 2v4.3c0 3-2.2 5-5 6.1-2.8-1.1-5-3.1-5-6.1V3.8zM5.8 8.2l1.5 1.5 3-3'),
} satisfies Record<string, (id: string) => JSX.Element>

export type IconName = keyof typeof SHAPES

/** One icon on a 16px grid, drawn in the colour of the text around it. */
export const Icon = (props: { name: IconName; class?: string }) => {
  const id = createUniqueId()
  return (
    <svg class={'icon ' + (props.class ?? '')} viewBox="0 0 16 16" aria-hidden="true">
      {SHAPES[props.name](id)}
    </svg>
  )
}

const TOOL_ICONS: Readonly<Record<string, IconName>> = {
  read: 'read',
  write: 'write',
  edit: 'edit',
  bash: 'bash',
  run_code: 'code',
  grep: 'grep',
  glob: 'grep',
  web_fetch: 'web',
  web_search: 'web',
  skill: 'skill',
  subagent: 'subagent',
  team: 'subagent',
  send_message: 'subagent',
  wait_agent: 'subagent',
  list_agents: 'subagent',
  interrupt_agent: 'subagent',
  todo_write: 'todo',
  ask_user: 'ask',
  read_image: 'image',
}

/** The icon a tool's row wears: its own when it has one, a job's for every job_*, else a plain mark. */
export const toolIconOf = (name: string): IconName =>
  TOOL_ICONS[name] ?? (name.startsWith('job_') ? 'job' : 'tool')
