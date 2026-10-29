import { Schema } from 'effect'
import { registerLogOnlySessionEvents } from './projections.ts'
import { registerSessionEventSchemas, type SessionEventSchemaMap } from './schemas.ts'
import type { SessionEvent } from './events.ts'

/** The composition a session runs with: what was chosen, and what it added up to. */
export interface Preset {
  /** The profile documents, first layer first, as the caller named them. */
  readonly profiles: ReadonlyArray<string>
  /** Every tool the session could call when it started. */
  readonly tools: ReadonlyArray<string>
}

declare module './events.ts' {
  interface SessionEventMap {
    'preset/selected': Preset
    /** The set a human picked for this session; the build's own record is above. */
    'composition/selected': Preset
  }
}

const presetSchema = Schema.Struct({
  profiles: Schema.Array(Schema.String),
  tools: Schema.Array(Schema.String),
})

/** Schemas for the session events this module adds. */
export const presetEventSchemas: SessionEventSchemaMap = new Map<string, Schema.Schema<unknown>>([
  ['preset/selected', presetSchema],
  ['composition/selected', presetSchema],
])

registerSessionEventSchemas(presetEventSchemas)
// Which tools a session is offered is the harness's business, not the model's.
registerLogOnlySessionEvents(['preset/selected', 'composition/selected'])

/** The composition this session recorded, or nothing when it never recorded one. */
export const currentPreset = (events: ReadonlyArray<SessionEvent>): Preset | undefined => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'preset/selected') return event.data
  }
  return undefined
}

const names = (values: ReadonlyArray<string>): string =>
  values.length === 0 ? 'none' : values.join(', ')

/** How a composition reads in one line. */
export const describePreset = (preset: Preset): string =>
  'profiles ' + names(preset.profiles) + '; ' + String(preset.tools.length) + ' tools'

const sorted = (values: ReadonlyArray<string>): ReadonlyArray<string> => [...values].sort()

/** The tools one set has that the other does not, in a stable order. */
const difference = (
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
): ReadonlyArray<string> => sorted(left.filter((value) => !right.includes(value)))

/**
 * How this run's composition differs from the one a session recorded. A profile
 * change alters what the session is; a tool that went missing removes what its
 * history used; a tool that arrived is one more capability.
 */
export interface PresetChange {
  readonly profilesChanged: boolean
  readonly gone: ReadonlyArray<string>
  readonly added: ReadonlyArray<string>
}

/** The difference between the recorded composition and this run's, or nothing when they agree. */
export const presetChange = (recorded: Preset, current: Preset): PresetChange | undefined => {
  const profilesChanged = names(sorted(recorded.profiles)) !== names(sorted(current.profiles))
  const gone = difference(recorded.tools, current.tools)
  const added = difference(current.tools, recorded.tools)
  if (!profilesChanged && gone.length === 0 && added.length === 0) return undefined
  return { profilesChanged, gone, added }
}

/**
 * The composition after a human picked a tool set. The profiles stay what the
 * session was built from; only what the model is offered changes.
 */
export const presetWithTools = (preset: Preset, tools: ReadonlyArray<string>): Preset => ({
  profiles: preset.profiles,
  tools: [...tools],
})

/** What choosing one tool set against the set in effect would take. */
export interface CompositionPlan {
  /** Asked for, but this run cannot offer it, so the set cannot be written. */
  readonly missing: ReadonlyArray<string>
  /** Offered now, not in the set. */
  readonly added: ReadonlyArray<string>
  /** In the set, not asked for now. */
  readonly removed: ReadonlyArray<string>
}

/** The difference a choice would make, computed before anything is written. */
export const compositionPlan = (
  offered: ReadonlyArray<string>,
  current: ReadonlyArray<string>,
  wanted: ReadonlyArray<string>,
): CompositionPlan => ({
  missing: sorted(wanted.filter((name) => !offered.includes(name))),
  added: difference(wanted, current).filter((name) => offered.includes(name)),
  removed: difference(current, wanted),
})

/** Whether a set may be written as it is: a tool this run cannot offer is no choice. */
export const compositionWritable = (plan: CompositionPlan): boolean => plan.missing.length === 0

/** The set a human last picked for this session, or nothing when they picked none. */
export const selectedPreset = (events: ReadonlyArray<SessionEvent>): Preset | undefined => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'composition/selected') return event.data
  }
  return undefined
}

/** The set in effect for this session: the human's choice outranks the build's record. */
export const effectivePreset = (events: ReadonlyArray<SessionEvent>): Preset | undefined =>
  selectedPreset(events) ?? currentPreset(events)

/**
 * The tools the newest record offers the model, or every tool when no human
 * chose a set. A build's own record does not narrow the request: a row wired
 * mid-run adds tools the session never recorded, and those stay usable. A
 * human's choice does narrow it, from the next step on, while the layers behind
 * the run stay as they were built.
 */
export const presetTools = <A extends { readonly name: string }>(
  events: ReadonlyArray<SessionEvent>,
  tools: ReadonlyArray<A>,
): ReadonlyArray<A> => {
  const chosen = selectedPreset(events)
  return chosen === undefined ? tools : tools.filter((tool) => chosen.tools.includes(tool.name))
}

/**
 * Whether this run may pick up the change without asking. A tool the build added
 * is one more thing the session can do; losing a tool or changing the profile
 * changes what the session is, and only the human can say that.
 */
export const presetResumable = (change: PresetChange): boolean =>
  !change.profilesChanged && change.gone.length === 0

/**
 * Why running this session under a different composition would be a mistake, in
 * the words a human needs to fix it. Nothing when the two agree.
 */
export const presetProblem = (recorded: Preset, current: Preset): string | undefined => {
  const change = presetChange(recorded, current)
  if (change === undefined) return undefined
  const lines: Array<string> = []
  if (change.profilesChanged) {
    lines.push('profiles: ' + names(recorded.profiles) + ' -> ' + names(current.profiles))
  }
  if (change.gone.length > 0) lines.push('tools gone: ' + change.gone.join(', '))
  if (change.added.length > 0) lines.push('tools new: ' + change.added.join(', '))
  return (
    'this session was started with ' +
    describePreset(recorded) +
    ';\n  ' +
    lines.join('\n  ') +
    '\nstart a new session, or pass --allow-preset-change to continue under this one'
  )
}
