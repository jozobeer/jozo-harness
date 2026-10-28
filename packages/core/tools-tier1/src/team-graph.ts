import type { TeamTask } from './team-state.ts'

/**
 * The ids among `ids` that are not done yet. An id with no row blocks as well:
 * a dependency that vanished from the log must not count as satisfied.
 */
export const unresolved = (
  tasks: ReadonlyArray<TeamTask>,
  ids: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  ids.filter((id) => tasks.find((task) => task.id === id)?.state !== 'done')

/** The rows `id` waits on; an id with no row waits on nothing. */
const dependenciesOf = (tasks: ReadonlyArray<TeamTask>, id: string): ReadonlyArray<string> =>
  tasks.find((task) => task.id === id)?.blockedBy ?? []

/**
 * Whether following blockedBy from `from` reaches `target`. The walk stops at
 * the first sighting of an id, so a graph that already has a loop still answers.
 */
export const dependsOn = (
  tasks: ReadonlyArray<TeamTask>,
  from: string,
  target: string,
): boolean => {
  const seen = new Set<string>()
  const queue: Array<string> = [from]
  while (queue.length > 0) {
    const id = queue.pop() ?? ''
    if (id === target) return true
    const firstVisit = !seen.has(id)
    seen.add(id)
    if (firstVisit) queue.push(...dependenciesOf(tasks, id))
  }
  return false
}

/**
 * The dependency that would close a loop if `id` waited on `blockedBy`, or
 * nothing when the new edges keep the board a DAG. Only the new row's edges can
 * close a loop, so the rest of the board is read as it stands.
 */
export const cycleIn = (
  tasks: ReadonlyArray<TeamTask>,
  id: string,
  blockedBy: ReadonlyArray<string>,
): string | undefined =>
  blockedBy.find((dependency) => dependency === id || dependsOn(tasks, dependency, id))
