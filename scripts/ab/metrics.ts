/**
 * What the A/B counts: tool calls, failed edits, re-reads of a file already
 * read, turns, and compactions. Both harnesses keep an append-only JSONL log and
 * spell the call the same way; the result's failure flag and the name of a
 * written summary differ, which is what the two shapes below say.
 */

export interface AbMetrics {
  readonly toolCalls: number
  /** Edit calls whose result came back as an error. */
  readonly failedEdits: number
  /** Read calls for a path this same session had already read. */
  readonly reReads: number
  readonly turns: number
  /** Summaries written when the context crossed the compaction line. */
  readonly compactions: number
  readonly tools: Readonly<Record<string, number>>
}

/**
 * The counters both harnesses share, named so a task's regime can be checked against what the
 * A/B actually keeps: a difference that names none of these cannot be read off a run.
 */
export const METRIC_NAMES = [
  'toolCalls',
  'failedEdits',
  'reReads',
  'turns',
  'compactions',
] as const satisfies ReadonlyArray<keyof AbMetrics>

/** One line of either log; both fields are read defensively. */
export interface AbEvent {
  readonly type?: unknown
  readonly data?: unknown
}

/** Where one log keeps the fact that a tool result failed. */
interface LogShape {
  /** The call a failed result answers, or undefined when the result is not a failure. */
  readonly failedCallOf: (data: Record<string, unknown>) => string | undefined
  /** The event a written summary is logged as. */
  readonly summaryType: string
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const stringOf = (value: unknown): string => (typeof value === 'string' ? value : '')

const argumentsOf = (raw: unknown): Record<string, unknown> | undefined => {
  if (typeof raw !== 'string') return asRecord(raw)
  try {
    return asRecord(JSON.parse(raw) as unknown)
  } catch {
    return undefined
  }
}

/** Both logs name a call the same way, with the arguments as a JSON string. */
const callOf = (data: Record<string, unknown>) => ({
  name: stringOf(data['name']),
  callId: stringOf(data['callId']),
  arguments: data['arguments'],
})

/**
 * The path a read named. The two harnesses spell it differently — jozo-harness `path`,
 * dsh `file_path` — and reading only one spelling counted dsh's re-reads as
 * zero, which is a measurement bug, not a behavioural difference. A read with
 * neither spelling throws, so an unknown spelling cannot pass for zero re-reads.
 */
const pathOf = (argumentsJson: unknown): string => {
  const args = argumentsOf(argumentsJson)
  const path = stringOf(args?.['path']) || stringOf(args?.['file_path'])
  if (path === '') {
    const raw = typeof argumentsJson === 'string' ? argumentsJson : JSON.stringify(argumentsJson)
    throw new Error('read without a path: ' + raw)
  }
  return path
}

const count = (events: ReadonlyArray<AbEvent>, shape: LogShape): AbMetrics => {
  const tools = new Map<string, number>()
  const readPaths = new Set<string>()
  const callNames = new Map<string, string>()
  let toolCalls = 0
  let failedEdits = 0
  let reReads = 0
  let turns = 0
  let compactions = 0

  for (const event of events) {
    const data = asRecord(event.data)
    if (data === undefined) continue
    if (event.type === 'turn/start') turns += 1
    if (event.type === shape.summaryType) compactions += 1
    if (event.type === 'tool/call') {
      const call = callOf(data)
      toolCalls += 1
      tools.set(call.name, (tools.get(call.name) ?? 0) + 1)
      callNames.set(call.callId, call.name)
      if (call.name === 'read') {
        const path = pathOf(call.arguments)
        if (readPaths.has(path)) reReads += 1
        readPaths.add(path)
      }
    }
    if (event.type === 'tool/result') {
      const callId = shape.failedCallOf(data)
      if (callId !== undefined && callNames.get(callId) === 'edit') failedEdits += 1
    }
  }
  return {
    toolCalls,
    failedEdits,
    reReads,
    turns,
    compactions,
    tools: Object.fromEntries(tools),
  }
}

/** The jozo-harness log carries the failure flat on the result's data. */
export const jozoHarnessMetrics = (events: ReadonlyArray<AbEvent>): AbMetrics =>
  count(events, {
    failedCallOf: (data) => (data['isError'] === true ? stringOf(data['callId']) : undefined),
    summaryType: 'compaction/checkpoint',
  })

/** The dsh log nests the result's message, and its failure sits inside it. */
export const dshMetrics = (events: ReadonlyArray<AbEvent>): AbMetrics =>
  count(events, {
    failedCallOf: (data) => {
      const message = asRecord(data['message'])
      return message?.['isError'] === true ? stringOf(message['toolCallId']) : undefined
    },
    summaryType: 'compaction/summary',
  })
