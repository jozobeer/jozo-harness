import type { UiSessionEvent } from '@jozo-harness/ui-protocol'

export type TraceToolStatus = 'running' | 'done' | 'error'

/** One tool call: what was asked, when, and what came back. */
export interface TraceTool {
  readonly callId: string
  readonly name: string
  readonly summary: string
  /** The arguments as the model wrote them, a JSON string. */
  readonly args: string
  readonly startedAt: number
  readonly endedAt: number | undefined
  readonly status: TraceToolStatus
  /** The result's one-line summary; '' until it arrives. */
  readonly result: string
  readonly output: string
}

/** One model call and the tools it asked for. */
export interface TraceStep {
  readonly step: number
  readonly startedAt: number
  readonly endedAt: number | undefined
  readonly reasoning: string
  readonly text: string
  readonly tools: ReadonlyArray<TraceTool>
}

/** A file the turn wrote, and how many calls touched it. */
export interface ChangedFile {
  readonly path: string
  readonly edits: number
}

/** One turn as a reader takes it in: what was asked, how it went, what it left. */
export interface TraceTurn {
  readonly turn: number
  /** What the human typed for this turn; '' when the log holds none. */
  readonly prompt: string
  readonly startedAt: number
  readonly endedAt: number | undefined
  /** How the turn ended ('completed', 'cancelled', …); '' while it runs. */
  readonly outcome: string
  readonly steps: ReadonlyArray<TraceStep>
  /** The text of the last step that said anything: the turn's answer. */
  readonly answer: string
  readonly changed: ReadonlyArray<ChangedFile>
}

/** The tools whose calls write a file the reader may want to review. */
const WRITERS: ReadonlySet<string> = new Set(['edit', 'write'])

const fieldOf = (data: unknown, key: string): unknown =>
  typeof data === 'object' && data !== null ? (data as Record<string, unknown>)[key] : undefined

const textOf = (data: unknown, key: string): string => {
  const value = fieldOf(data, key)
  return typeof value === 'string' ? value : ''
}

const numberOf = (data: unknown, key: string): number => {
  const value = fieldOf(data, key)
  return typeof value === 'number' ? value : 0
}

/** The text parts of a content list joined, for one part type. */
const partsOf = (content: unknown, type: string): string =>
  Array.isArray(content)
    ? content
        .filter((part) => fieldOf(part, 'type') === type)
        .map((part) => textOf(part, 'text'))
        .join('\n')
    : ''

/** The path an edit or write names; undefined when the arguments do not parse. */
export const writtenPath = (name: string, args: string): string | undefined => {
  if (!WRITERS.has(name)) return undefined
  try {
    const parsed: unknown = JSON.parse(args)
    const path = textOf(parsed, 'path') || textOf(parsed, 'file_path')
    return path === '' ? undefined : path
  } catch {
    return undefined
  }
}

/** Replaces the last item of a list. */
const withLast = <A>(items: ReadonlyArray<A>, change: (item: A) => A): ReadonlyArray<A> => {
  const last = items[items.length - 1]
  return last === undefined ? items : [...items.slice(0, -1), change(last)]
}

const inLastTurn = (
  turns: ReadonlyArray<TraceTurn>,
  change: (turn: TraceTurn) => TraceTurn,
): ReadonlyArray<TraceTurn> => withLast(turns, change)

const inLastStep = (
  turns: ReadonlyArray<TraceTurn>,
  change: (step: TraceStep) => TraceStep,
): ReadonlyArray<TraceTurn> =>
  inLastTurn(turns, (turn) => ({ ...turn, steps: withLast(turn.steps, change) }))

const startTurn = (turns: ReadonlyArray<TraceTurn>, event: UiSessionEvent) => [
  ...turns,
  {
    turn: numberOf(event.data, 'turn'),
    prompt: '',
    startedAt: event.time,
    endedAt: undefined,
    outcome: '',
    steps: [],
    answer: '',
    changed: [],
  },
]

const endTurn = (turns: ReadonlyArray<TraceTurn>, event: UiSessionEvent) =>
  inLastTurn(turns, (turn) => ({
    ...turn,
    endedAt: event.time,
    outcome: textOf(fieldOf(event.data, 'reason'), 'kind'),
  }))

/** The human's words reach the turn as an inbox claim; other sources are the harness's own. */
const claimPrompt = (turns: ReadonlyArray<TraceTurn>, event: UiSessionEvent) => {
  const message = fieldOf(event.data, 'message')
  if (textOf(message, 'source') !== 'user') return turns
  return inLastTurn(turns, (turn) =>
    turn.prompt === '' ? { ...turn, prompt: textOf(message, 'text') } : turn,
  )
}

const startStep = (turns: ReadonlyArray<TraceTurn>, event: UiSessionEvent) =>
  inLastTurn(turns, (turn) => ({
    ...turn,
    steps: [
      ...turn.steps,
      {
        step: numberOf(event.data, 'step'),
        startedAt: event.time,
        endedAt: undefined,
        reasoning: '',
        text: '',
        tools: [],
      },
    ],
  }))

const endStep = (turns: ReadonlyArray<TraceTurn>, event: UiSessionEvent) =>
  inLastStep(turns, (step) => ({ ...step, endedAt: event.time }))

const assistantSaid = (turns: ReadonlyArray<TraceTurn>, event: UiSessionEvent) => {
  const content = fieldOf(event.data, 'content')
  const text = partsOf(content, 'text')
  const said = inLastStep(turns, (step) => ({
    ...step,
    reasoning: partsOf(content, 'reasoning'),
    text,
  }))
  return text === '' ? said : inLastTurn(said, (turn) => ({ ...turn, answer: text }))
}

const withChange = (
  changed: ReadonlyArray<ChangedFile>,
  path: string,
): ReadonlyArray<ChangedFile> =>
  changed.some((file) => file.path === path)
    ? changed.map((file) => (file.path === path ? { ...file, edits: file.edits + 1 } : file))
    : [...changed, { path, edits: 1 }]

const callTool = (turns: ReadonlyArray<TraceTurn>, event: UiSessionEvent) => {
  const tool: TraceTool = {
    callId: textOf(event.data, 'callId'),
    name: textOf(event.data, 'name'),
    summary: textOf(event.data, 'summary'),
    args: textOf(event.data, 'arguments'),
    startedAt: event.time,
    endedAt: undefined,
    status: 'running',
    result: '',
    output: '',
  }
  const path = writtenPath(tool.name, tool.args)
  const called = inLastStep(turns, (step) => ({ ...step, tools: [...step.tools, tool] }))
  return path === undefined
    ? called
    : inLastTurn(called, (turn) => ({ ...turn, changed: withChange(turn.changed, path) }))
}

const settleTool = (turns: ReadonlyArray<TraceTurn>, event: UiSessionEvent) => {
  const callId = textOf(event.data, 'callId')
  const settled = (tool: TraceTool): TraceTool => ({
    ...tool,
    endedAt: event.time,
    status: fieldOf(event.data, 'isError') === true ? 'error' : 'done',
    result: textOf(event.data, 'summary'),
    output: partsOf(fieldOf(event.data, 'content'), 'text'),
  })
  return inLastStep(turns, (step) => ({
    ...step,
    tools: step.tools.map((tool) => (tool.callId === callId ? settled(tool) : tool)),
  }))
}

type Fold = (turns: ReadonlyArray<TraceTurn>, event: UiSessionEvent) => ReadonlyArray<TraceTurn>

/** The events the trace reads, by name: one lookup instead of a chain of tests. */
const FOLDS: Readonly<Record<string, Fold>> = {
  'turn/start': startTurn,
  'turn/end': endTurn,
  'agent/inbox/claimed': claimPrompt,
  'step/start': startStep,
  'step/end': endStep,
  'assistant/message': assistantSaid,
  'tool/call': callTool,
  'tool/result': settleTool,
}

/** Folds one event into the turns so far. */
export const traceAfter = (
  turns: ReadonlyArray<TraceTurn>,
  event: UiSessionEvent,
): ReadonlyArray<TraceTurn> => {
  const fold = FOLDS[event.type]
  return fold === undefined ? turns : fold(turns, event)
}

/** Every turn a log holds, oldest first. */
export const traceOf = (log: ReadonlyArray<UiSessionEvent>): ReadonlyArray<TraceTurn> =>
  log.reduce(traceAfter, [] as ReadonlyArray<TraceTurn>)

/** Every tool call of a turn, in the order the steps asked for them. */
export const toolsOf = (turn: TraceTurn): ReadonlyArray<TraceTool> =>
  turn.steps.flatMap((step) => step.tools)

/**
 * Where a running turn's axis ends: the last moment its log records. The clock
 * would move it every second, rescaling every finished bar on the lane; a new
 * event moves it only when there is something new to place.
 */
export const axisEndOf = (turn: TraceTurn): number =>
  turn.endedAt ??
  Math.max(
    turn.startedAt,
    ...turn.steps.flatMap((step) => [
      step.startedAt,
      step.endedAt ?? step.startedAt,
      ...step.tools.flatMap((tool) => [tool.startedAt, tool.endedAt ?? tool.startedAt]),
    ]),
  )
