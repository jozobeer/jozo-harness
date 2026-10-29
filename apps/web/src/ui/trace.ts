import type { Attachment, Quote, UiSessionEvent } from '@jozo-harness/ui-protocol'

export type TraceToolStatus = 'running' | 'done' | 'error'

/** One image a tool result carried, kept so the card can draw it. */
export interface TraceImage {
  readonly mediaType: string
  /** Base64 of the image bytes. */
  readonly data: string
  /** The path the tool read; '' when the block named none. */
  readonly name: string
}

/** One file change a tool recorded while it ran. */
export interface TraceDiff {
  readonly path: string
  readonly oldStart: number
  readonly newStart: number
  readonly removed: ReadonlyArray<string>
  readonly added: ReadonlyArray<string>
}

/**
 * A question a call put to the human, when it put one: the choices it offered
 * and the answer it got. The log writes both, so a reload keeps them.
 */
export interface TraceAsk {
  readonly question: string
  readonly options: ReadonlyArray<string>
  /** The answer in the human's own words; '' while the question waits. */
  readonly answer: string
}

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
  /** The code a failed call logged; '' when it succeeded or its outcome is unknown. */
  readonly errorCode: string
  readonly output: string
  /** The images the result carried; empty for a text-only result. */
  readonly images: ReadonlyArray<TraceImage>
  /** The file changes the call recorded; empty for an old log or a read. */
  readonly diffs: ReadonlyArray<TraceDiff>
  /** The question the call asked; undefined for a call that asked none. */
  readonly ask: TraceAsk | undefined
}

/** One translated reasoning, logged beside the message it translates. */
export interface TraceTranslation {
  /** The language the reader asked for, as the page named it. */
  readonly language: string
  readonly text: string
}

/** One model call and the tools it asked for. */
export interface TraceStep {
  readonly step: number
  /** The seq of the assistant message this step recorded; 0 before one arrives. */
  readonly seq: number
  readonly startedAt: number
  readonly endedAt: number | undefined
  readonly reasoning: string
  /** The translation of `reasoning`, when the reader asked for one. */
  readonly translation: TraceTranslation | undefined
  readonly text: string
  readonly tools: ReadonlyArray<TraceTool>
}

/** A file the turn wrote, and how many calls touched it. */
export interface ChangedFile {
  readonly path: string
  readonly edits: number
}

/** The human's verdict on one answer, as the log last recorded it. */
export interface TraceFeedback {
  readonly rating: 'like' | 'dislike'
  /** The short note the human added; '' when the verdict stands alone. */
  readonly memo: string
}

/** One turn as a reader takes it in: what was asked, how it went, what it left. */
export interface TraceTurn {
  readonly turn: number
  /** What the human typed for this turn; '' when the log holds none. */
  readonly prompt: string
  /** Passages the human quoted from earlier turns, in the order they were selected. */
  readonly quotes: ReadonlyArray<Quote>
  /** Files the human attached to the message, in the order the composer showed them. */
  readonly attachments: ReadonlyArray<Attachment>
  readonly startedAt: number
  readonly endedAt: number | undefined
  /** How the turn ended ('completed', 'cancelled', …); '' while it runs. */
  readonly outcome: string
  readonly steps: ReadonlyArray<TraceStep>
  /** The text of the last step that said anything: the turn's answer. */
  readonly answer: string
  /** The seq of the assistant message that carries the answer; 0 before one. */
  readonly answerSeq: number
  /** The newest verdict on the answer; undefined until the human gives one. */
  readonly feedback: TraceFeedback | undefined
  readonly changed: ReadonlyArray<ChangedFile>
  /** True when the log wrote the call outside any turn, as a forced skill load does. */
  readonly standalone: boolean
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

/** The image parts of a content list, with only those that carry bytes. */
const imagesOf = (content: unknown): ReadonlyArray<TraceImage> =>
  Array.isArray(content)
    ? content
        .filter((part) => fieldOf(part, 'type') === 'image')
        .map((part) => ({
          mediaType: textOf(part, 'mediaType'),
          data: textOf(part, 'data'),
          name: textOf(part, 'name'),
        }))
        .filter((image) => image.data !== '')
    : []

/** The lines a diff carries, keeping only strings. */
const stringsOf = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((line): line is string => typeof line === 'string') : []

/** The file changes a result recorded, dropping anything the log did not write whole. */
const diffsOf = (value: unknown): ReadonlyArray<TraceDiff> =>
  Array.isArray(value)
    ? value.flatMap((diff) => {
        const path = textOf(diff, 'path')
        return path === ''
          ? []
          : [
              {
                path,
                oldStart: numberOf(diff, 'oldStart'),
                newStart: numberOf(diff, 'newStart'),
                removed: stringsOf(fieldOf(diff, 'removed')),
                added: stringsOf(fieldOf(diff, 'added')),
              },
            ]
      })
    : []

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
    quotes: [],
    attachments: [],
    startedAt: event.time,
    endedAt: undefined,
    outcome: '',
    steps: [],
    answer: '',
    answerSeq: 0,
    feedback: undefined,
    changed: [],
    standalone: false,
  },
]

const endTurn = (turns: ReadonlyArray<TraceTurn>, event: UiSessionEvent) =>
  inLastTurn(turns, (turn) => ({
    ...turn,
    endedAt: event.time,
    outcome: textOf(fieldOf(event.data, 'reason'), 'kind'),
  }))

/** Reads the passages a message carried, dropping any entry the page cannot read. */
const quotesOf = (data: unknown): ReadonlyArray<Quote> => {
  const value = fieldOf(data, 'quotes')
  if (!Array.isArray(value)) return []
  const quotes: Array<Quote> = []
  for (const item of value) {
    const text = textOf(item, 'text')
    if (text === '') continue
    const sourceSeq = fieldOf(item, 'sourceSeq')
    quotes.push(typeof sourceSeq === 'number' ? { text, sourceSeq } : { text })
  }
  return quotes
}

/** Reads the files a message carried, dropping any entry the page cannot read. */
const attachmentsOf = (data: unknown): ReadonlyArray<Attachment> => {
  const value = fieldOf(data, 'attachments')
  if (!Array.isArray(value)) return []
  const attachments: Array<Attachment> = []
  for (const item of value) {
    const hash = textOf(item, 'hash')
    const mediaType = textOf(item, 'mediaType')
    const name = textOf(item, 'name')
    const bytes = numberOf(item, 'bytes')
    if (hash === '' || name === '') continue
    attachments.push({ hash, mediaType, name, bytes })
  }
  return attachments
}

/** The human's words reach the turn as an inbox claim; other sources are the harness's own. */
const claimPrompt = (turns: ReadonlyArray<TraceTurn>, event: UiSessionEvent) => {
  const message = fieldOf(event.data, 'message')
  if (textOf(message, 'source') !== 'user') return turns
  return inLastTurn(turns, (turn) =>
    turn.prompt === ''
      ? {
          ...turn,
          prompt: textOf(message, 'text'),
          quotes: quotesOf(message),
          attachments: attachmentsOf(message),
        }
      : turn,
  )
}

const startStep = (turns: ReadonlyArray<TraceTurn>, event: UiSessionEvent) =>
  inLastTurn(turns, (turn) => ({
    ...turn,
    steps: [
      ...turn.steps,
      {
        step: numberOf(event.data, 'step'),
        seq: 0,
        startedAt: event.time,
        endedAt: undefined,
        reasoning: '',
        translation: undefined,
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
    seq: event.seq,
    reasoning: partsOf(content, 'reasoning'),
    text,
  }))
  return text === ''
    ? said
    : inLastTurn(said, (turn) => ({ ...turn, answer: text, answerSeq: event.seq }))
}

/** A later verdict on the same answer replaces the earlier one, as the log folds newest last. */
const rateAnswer = (
  turns: ReadonlyArray<TraceTurn>,
  event: UiSessionEvent,
): ReadonlyArray<TraceTurn> => {
  const target = numberOf(event.data, 'target')
  const rating = textOf(event.data, 'rating')
  if (rating !== 'like' && rating !== 'dislike') return turns
  return turns.map((turn) =>
    turn.answerSeq === target
      ? { ...turn, feedback: { rating, memo: textOf(event.data, 'memo') } }
      : turn,
  )
}

const withChange = (
  changed: ReadonlyArray<ChangedFile>,
  path: string,
): ReadonlyArray<ChangedFile> =>
  changed.some((file) => file.path === path)
    ? changed.map((file) => (file.path === path ? { ...file, edits: file.edits + 1 } : file))
    : [...changed, { path, edits: 1 }]

const toolOf = (event: UiSessionEvent): TraceTool => ({
  callId: textOf(event.data, 'callId'),
  name: textOf(event.data, 'name'),
  summary: textOf(event.data, 'summary'),
  args: textOf(event.data, 'arguments'),
  startedAt: event.time,
  endedAt: undefined,
  status: 'running',
  result: '',
  errorCode: '',
  output: '',
  images: [],
  diffs: [],
  ask: undefined,
})

/** True while the last entry is a turn still running; a load written outside one is not. */
const turnOpen = (turns: ReadonlyArray<TraceTurn>): boolean => {
  const last = turns[turns.length - 1]
  return last !== undefined && !last.standalone && last.endedAt === undefined
}

/** A call the log wrote outside any turn: it stands alone because no turn holds it. */
const standaloneTurn = (
  turns: ReadonlyArray<TraceTurn>,
  tool: TraceTool,
  event: UiSessionEvent,
): ReadonlyArray<TraceTurn> => [
  ...turns,
  {
    turn: 0,
    prompt: '',
    quotes: [],
    attachments: [],
    startedAt: event.time,
    endedAt: undefined,
    outcome: '',
    steps: [
      {
        step: 0,
        seq: 0,
        startedAt: event.time,
        endedAt: undefined,
        reasoning: '',
        translation: undefined,
        text: '',
        tools: [tool],
      },
    ],
    answer: '',
    answerSeq: 0,
    feedback: undefined,
    changed: [],
    standalone: true,
  },
]

const callTool = (turns: ReadonlyArray<TraceTurn>, event: UiSessionEvent) => {
  const tool = toolOf(event)
  if (!turnOpen(turns)) return standaloneTurn(turns, tool, event)
  const path = writtenPath(tool.name, tool.args)
  const called = inLastStep(turns, (step) => ({ ...step, tools: [...step.tools, tool] }))
  return path === undefined
    ? called
    : inLastTurn(called, (turn) => ({ ...turn, changed: withChange(turn.changed, path) }))
}

const settleTool = (turns: ReadonlyArray<TraceTurn>, event: UiSessionEvent) => {
  const callId = textOf(event.data, 'callId')
  const withResult = (tool: TraceTool): TraceTool => ({
    ...tool,
    endedAt: event.time,
    status: fieldOf(event.data, 'isError') === true ? 'error' : 'done',
    result: textOf(event.data, 'summary'),
    errorCode: textOf(fieldOf(event.data, 'error'), 'code'),
    output: partsOf(fieldOf(event.data, 'content'), 'text'),
    images: imagesOf(fieldOf(event.data, 'content')),
    diffs: diffsOf(fieldOf(event.data, 'diffs')),
  })
  const settled = inLastStep(turns, (step) => ({
    ...step,
    tools: step.tools.map((tool) => (tool.callId === callId ? withResult(tool) : tool)),
  }))
  // A load outside a turn has no turn/end to close it: its result is the end.
  return inLastTurn(settled, (turn) => (turn.standalone ? { ...turn, endedAt: event.time } : turn))
}

/**
 * One call, wherever the turn it belongs to sits: a question is asked after the
 * call that asks it, and the answer may follow in a later event.
 */
const inTool = (
  turns: ReadonlyArray<TraceTurn>,
  callId: string,
  change: (tool: TraceTool) => TraceTool,
): ReadonlyArray<TraceTurn> =>
  turns.map((turn) => ({
    ...turn,
    steps: turn.steps.map((step) => ({
      ...step,
      tools: step.tools.map((tool) => (tool.callId === callId ? change(tool) : tool)),
    })),
  }))

/** A question kept with the call that asked it, so its card can show what was chosen. */
const askedHuman = (turns: ReadonlyArray<TraceTurn>, event: UiSessionEvent) => {
  const id = textOf(event.data, 'id')
  const question = textOf(event.data, 'question')
  if (id === '' || question === '') return turns
  return inTool(turns, id, (tool) => ({
    ...tool,
    ask: { question, options: stringsOf(fieldOf(event.data, 'options')), answer: '' },
  }))
}

/** The answer lands on the call that asked; a call that asked nothing has none to take. */
const answeredHuman = (turns: ReadonlyArray<TraceTurn>, event: UiSessionEvent) => {
  const id = textOf(event.data, 'id')
  const answer = textOf(event.data, 'answer')
  if (id === '' || answer === '') return turns
  return inTool(turns, id, (tool) =>
    tool.ask === undefined ? tool : { ...tool, ask: { ...tool.ask, answer } },
  )
}

/**
 * A translation lands on the step whose assistant message it names. The original
 * reasoning stays where the assistant message put it; a later translation of the
 * same message replaces the earlier one, as the log folds newest last.
 */
const translated = (
  turns: ReadonlyArray<TraceTurn>,
  event: UiSessionEvent,
): ReadonlyArray<TraceTurn> => {
  const target = numberOf(event.data, 'target')
  const text = textOf(event.data, 'text')
  if (target === 0 || text === '') return turns
  const translation: TraceTranslation = { language: textOf(event.data, 'language'), text }
  return turns.map((turn) => ({
    ...turn,
    steps: turn.steps.map((step) => (step.seq === target ? { ...step, translation } : step)),
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
  'reasoning/translation': translated,
  'tool/call': callTool,
  'tool/result': settleTool,
  'interaction/ask/requested': askedHuman,
  'interaction/ask/answered': answeredHuman,
  'feedback/rated': rateAnswer,
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
