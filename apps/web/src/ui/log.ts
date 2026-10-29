import type { UiSessionEvent } from '@jozo-harness/ui-protocol'

/**
 * One logged event as the inspector lists it. The page keeps this beside the
 * folds the conversation and the trace read, so opening the log writes nothing
 * and sends nothing: the same event stream, read once more.
 */
export interface LogEvent {
  readonly seq: number
  readonly time: number
  readonly type: string
  readonly data: unknown
  /** Every key the data holds, so a reader can narrow the list to one without rescanning the log. */
  readonly keys: ReadonlyArray<string>
  /** Where the conversation draws this event; undefined for an event that draws no node. */
  readonly node: LogNode | undefined
}

/**
 * The conversation node an event belongs to: the turn, the step inside it, and
 * the call when the event is a tool's. The page marks the same three places in
 * the conversation, so a reader can go from the log to the node that grew from it.
 */
export interface LogNode {
  readonly turn: number
  readonly step: number | undefined
  readonly callId: string | undefined
}

/**
 * What the log inspector knows: every event the page has applied, and the
 * turn and step the fold is inside. A tool call written outside any open turn
 * is a load the log stands alone, as the trace reads it.
 */
export interface LogState {
  readonly events: ReadonlyArray<LogEvent>
  readonly turn: number
  readonly step: number
  readonly open: boolean
}

export const emptyLog: LogState = { events: [], turn: 0, step: 0, open: false }

const fieldOf = (data: unknown, key: string): unknown =>
  typeof data === 'object' && data !== null ? (data as Record<string, unknown>)[key] : undefined

const numberIn = (data: unknown, key: string): number | undefined => {
  const value = fieldOf(data, key)
  return typeof value === 'number' ? value : undefined
}

const textIn = (data: unknown, key: string): string => {
  const value = fieldOf(data, key)
  return typeof value === 'string' ? value : ''
}

export const foldLimit = { chars: 160, items: 24, depth: 5 } as const

/**
 * A value as the inspector shows it: long strings and long lists are cut to a
 * readable size and say how much they left out. The fold is display only; the
 * event itself stays whole.
 */
const foldString = (value: string): string =>
  value.length <= foldLimit.chars
    ? value
    : value.slice(0, foldLimit.chars) + '… (' + String(value.length) + ' chars)'

const foldArray = (value: ReadonlyArray<unknown>, depth: number): ReadonlyArray<unknown> => {
  const kept = value.slice(0, foldLimit.items).map((item) => folded(item, depth + 1))
  return value.length <= foldLimit.items
    ? kept
    : [...kept, '… (' + String(value.length - foldLimit.items) + ' more)']
}

const foldObject = (value: object, depth: number): object =>
  Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, folded(inner, depth + 1)]))

/** A value as the inspector shows it: long strings and long lists are cut to a
 * readable size and say how much they left out. The fold is display only; the
 * event itself stays whole. */
export const folded = (value: unknown, depth = 0): unknown => {
  if (typeof value === 'string') return foldString(value)
  if (Array.isArray(value)) return foldArray(value, depth)
  if (value !== null && typeof value === 'object' && depth < foldLimit.depth) {
    return foldObject(value, depth)
  }
  return value
}

/** The data as the detail panel prints it, folded and indented. */
export const dataText = (data: unknown): string => {
  try {
    return JSON.stringify(folded(data), null, 2) ?? String(data)
  } catch {
    return String(data)
  }
}

const walkEntries = (value: object, found: Set<string>, level: number): void => {
  for (const [key, child] of Object.entries(value)) {
    found.add(key)
    walkKeys(child, found, level + 1)
  }
}

const walkKeys = (value: unknown, found: Set<string>, level: number): void => {
  if (level > 6 || value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) walkKeys(item, found, level + 1)
    return
  }
  walkEntries(value, found, level)
}

/** The keys a value carries, nested ones included, so a filter can name any of them. */
export const keysOf = (value: unknown): ReadonlyArray<string> => {
  const found = new Set<string>()
  walkKeys(value, found, 0)
  return [...found]
}

/**
 * The node an event grew into. The conversation opens a turn at turn/start and
 * a step at step/start; a call written while no turn is open is a standalone
 * load, which the trace draws under turn 0.
 */
type NodeShape = 'turn' | 'step' | 'ask' | 'call'

/** The place in the conversation each event type grows; an unlisted type draws no node. */
const NODE_SHAPES: Readonly<Record<string, NodeShape>> = {
  'turn/start': 'turn',
  'turn/end': 'turn',
  'step/start': 'step',
  'step/end': 'step',
  'user/message': 'ask',
  'assistant/message': 'step',
  'assistant/attempt': 'step',
  'tool/call': 'call',
  'tool/result': 'call',
  'tool/context': 'call',
}

const callNode = (
  data: unknown,
  turn: number,
  step: number,
  open: boolean,
): LogNode | undefined => {
  const callId = textIn(data, 'callId')
  if (callId === '') return undefined
  return open ? { turn, step, callId } : { turn: 0, step: 0, callId }
}

const shapeNode = (shape: NodeShape, turn: number, step: number): LogNode => {
  if (shape === 'turn') return { turn, step: undefined, callId: undefined }
  if (shape === 'ask') return { turn, step: 0, callId: undefined }
  return { turn, step: step === 0 ? undefined : step, callId: undefined }
}

/**
 * The node an event grew into. The conversation opens a turn at turn/start and
 * a step at step/start; a call written while no turn is open is a standalone
 * load, which the trace draws under turn 0.
 */
const nodeFor = (
  event: UiSessionEvent,
  turn: number,
  step: number,
  open: boolean,
): LogNode | undefined => {
  const shape = NODE_SHAPES[event.type]
  if (shape === undefined) return undefined
  if (shape === 'call') return callNode(event.data, turn, step, open)
  if (shape === 'turn' || open) return shapeNode(shape, turn, step)
  return undefined
}

/**
 * Reads one more event. The fold follows the same turn and step markers the
 * trace does, so the node it names is the one the conversation drew.
 */
export const logAfter = (state: LogState, event: UiSessionEvent): LogState => {
  let turn = state.turn
  let step = state.step
  let open = state.open
  if (event.type === 'turn/start') {
    turn = numberIn(event.data, 'turn') ?? turn
    step = 0
    open = true
  } else if (event.type === 'turn/end') {
    open = false
  } else if (event.type === 'step/start') {
    step = numberIn(event.data, 'step') ?? step
  }
  return {
    events: [
      ...state.events,
      {
        seq: event.seq,
        time: event.time,
        type: event.type,
        data: event.data,
        keys: keysOf(event.data),
        node: nodeFor(event, turn, step, open),
      },
    ],
    turn,
    step,
    open,
  }
}
