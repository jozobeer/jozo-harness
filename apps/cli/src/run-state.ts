import type { SessionEvent } from '@jozo-harness/session'
import type { RunStateView } from '@jozo-harness/web'

export type TodoItemView = RunStateView['todos'][number]
export type TodoStatus = TodoItemView['status']

/** What the Run pane folds out of one session log. */
export interface RunContextView {
  readonly todos: RunStateView['todos']
  readonly todoCounts: RunStateView['todoCounts']
  readonly skills: RunStateView['skills']
  readonly promptSections: RunStateView['promptSections']
}

type CallData = Extract<SessionEvent, { type: 'tool/call' }>['data']

const statuses: ReadonlyArray<TodoStatus> = ['pending', 'in_progress', 'completed']

const recordOf = (raw: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

const statusOf = (value: unknown): TodoStatus | undefined =>
  typeof value === 'string' && (statuses as ReadonlyArray<string>).includes(value)
    ? (value as TodoStatus)
    : undefined

const todoItemOf = (entry: unknown): TodoItemView | undefined => {
  if (typeof entry !== 'object' || entry === null) return undefined
  const record = entry as Record<string, unknown>
  const status = statusOf(record.status)
  return typeof record.content === 'string' && status !== undefined
    ? { content: record.content, status }
    : undefined
}

/** The list a todo_write call asked for, or undefined when the arguments are not that list. */
const todoItemsOf = (raw: string): ReadonlyArray<TodoItemView> | undefined => {
  const listed = recordOf(raw)?.todos
  if (!Array.isArray(listed)) return undefined
  const items: Array<TodoItemView> = []
  for (const entry of listed) {
    const item = todoItemOf(entry)
    if (item === undefined) return undefined
    items.push(item)
  }
  return items
}

const countsOf = (todos: ReadonlyArray<TodoItemView>): RunStateView['todoCounts'] => ({
  pending: todos.filter((todo) => todo.status === 'pending').length,
  inProgress: todos.filter((todo) => todo.status === 'in_progress').length,
  completed: todos.filter((todo) => todo.status === 'completed').length,
})

const skillNameOf = (raw: string): string | undefined => {
  const name = recordOf(raw)?.name
  return typeof name === 'string' ? name : undefined
}

interface Fold {
  todos: ReadonlyArray<TodoItemView>
  skills: Array<string>
  promptSections: ReadonlyArray<string>
}

const applyTodo = (fold: Fold, raw: string): void => {
  const items = todoItemsOf(raw)
  if (items !== undefined) fold.todos = items
}

const applySkill = (fold: Fold, seen: Set<string>, raw: string): void => {
  const name = skillNameOf(raw)
  if (name === undefined || seen.has(name)) return
  seen.add(name)
  fold.skills.push(name)
}

const applyResult = (
  fold: Fold,
  seen: Set<string>,
  call: CallData | undefined,
  isError: boolean,
): void => {
  if (isError || call === undefined) return
  if (call.name === 'todo_write') applyTodo(fold, call.arguments)
  if (call.name === 'skill') applySkill(fold, seen, call.arguments)
}

/**
 * Folds the newest plan, the skills that loaded successfully, and the sections of
 * the newest system prompt. The log is append-only, so the newest record wins.
 */
export const runContextOf = (events: ReadonlyArray<SessionEvent>): RunContextView => {
  const calls = new Map<string, CallData>()
  const seen = new Set<string>()
  const fold: Fold = { todos: [], skills: [], promptSections: [] }
  for (const event of events) {
    if (event.type === 'system/message') {
      fold.promptSections = event.data.sections ?? []
    } else if (event.type === 'tool/call') {
      calls.set(event.data.callId, event.data)
    } else if (event.type === 'tool/result') {
      applyResult(fold, seen, calls.get(event.data.callId), event.data.isError)
    }
  }
  return {
    todos: fold.todos,
    todoCounts: countsOf(fold.todos),
    skills: fold.skills,
    promptSections: fold.promptSections,
  }
}

export interface TodosView {
  readonly todos: RunStateView['todos']
  readonly counts: RunStateView['todoCounts']
}

export const todosOf = (events: ReadonlyArray<SessionEvent>): TodosView => {
  const context = runContextOf(events)
  return { todos: context.todos, counts: context.todoCounts }
}

export const skillsOf = (events: ReadonlyArray<SessionEvent>): RunContextView['skills'] =>
  runContextOf(events).skills

export const promptSectionsOf = (
  events: ReadonlyArray<SessionEvent>,
): RunContextView['promptSections'] => runContextOf(events).promptSections
