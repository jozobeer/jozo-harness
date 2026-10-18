import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect } from 'effect'
import { readIfPresent } from './read-text.ts'

/** A skill name is lower-case letters, digits, and dashes. It never holds a path. */
const NAME = /^[a-z0-9][a-z0-9-]*$/
/** Catalog lines stay readable: one line, this many characters at most. */
const DESCRIPTION_MAX = 160
const FRONTMATTER_FIELD = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/

/** One validated skill, as discovery found it. */
export interface SkillSummary {
  readonly name: string
  readonly description: string
  /** Absolute path of the SKILL.md this summary came from. */
  readonly path: string
}

/** The parsed content of one SKILL.md. */
export interface SkillDocument {
  readonly name: string
  readonly description: string
  readonly body: string
}

const unquote = (value: string): string => {
  const trimmed = value.trim()
  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]
  const quoted = (first === '"' && last === '"') || (first === "'" && last === "'")
  return quoted && trimmed.length >= 2 ? trimmed.slice(1, -1) : trimmed
}

/** The scalar frontmatter fields; nested structures are not skill metadata here. */
const frontmatterFields = (block: string): ReadonlyMap<string, string> => {
  const fields = new Map<string, string>()
  for (const raw of block.split('\n')) {
    const match = FRONTMATTER_FIELD.exec(raw.replace(/\r$/, ''))
    const key = match?.[1]
    const value = match?.[2]
    if (key !== undefined && value !== undefined) fields.set(key, unquote(value))
  }
  return fields
}

/**
 * Parses one SKILL.md. A document is a skill only when its frontmatter names it
 * with a safe name and describes it; anything else is not a skill at all, so no
 * later stage has to re-check it.
 */
export function parseSkillDocument(text: string): SkillDocument | undefined {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines[0]?.trim() !== '---') return undefined
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (closing < 0) return undefined
  const fields = frontmatterFields(lines.slice(1, closing).join('\n'))
  const name = fields.get('name')
  const description = fields.get('description')
  if (name === undefined || description === undefined || !NAME.test(name)) return undefined
  return {
    name,
    description,
    body: lines
      .slice(closing + 1)
      .join('\n')
      .trim(),
  }
}

const directoriesOf = (root: string): Effect.Effect<ReadonlyArray<string>> =>
  Effect.promise(() =>
    readdir(root, { withFileTypes: true }).then(
      async (entries) => {
        const names: Array<string> = []
        for (const entry of entries) {
          if (entry.isDirectory()) {
            names.push(entry.name)
            continue
          }
          if (!entry.isSymbolicLink()) continue
          // Follow a link one level so a shared skills directory can be linked in.
          // A broken link or a link to a file is no skill directory, like a missing one.
          const target = await stat(join(root, entry.name)).catch(() => undefined)
          if (target?.isDirectory() === true) names.push(entry.name)
        }
        return names
      },
      // A missing or unreadable root holds no skills; it is not a failure.
      () => [],
    ),
  )

interface FoundSkill {
  readonly document: SkillDocument
  readonly path: string
}

/** The valid skill documents directly under one root. */
const documentsIn = (root: string): Effect.Effect<ReadonlyArray<FoundSkill>> =>
  Effect.gen(function* () {
    const found: Array<FoundSkill> = []
    for (const directory of yield* directoriesOf(root)) {
      const path = join(root, directory, 'SKILL.md')
      const text = yield* readIfPresent(path)
      if (text === undefined) continue
      const document = parseSkillDocument(text)
      if (document !== undefined) found.push({ document, path })
    }
    return found
  })

/**
 * Every skill the roots hold, in root order: the first root wins a name. A file
 * that fails validation, a directory without SKILL.md, and a missing root are all
 * simply absent, because a broken skill file must not stop a session.
 */
export function discoverSkills(
  roots: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<SkillSummary>> {
  return Effect.gen(function* () {
    const found: Array<SkillSummary> = []
    const seen = new Set<string>()
    for (const root of roots) {
      for (const entry of yield* documentsIn(root)) {
        if (seen.has(entry.document.name)) continue
        seen.add(entry.document.name)
        found.push({
          name: entry.document.name,
          description: entry.document.description,
          path: entry.path,
        })
      }
    }
    return found
  })
}

/** One skill's document and where it was read from. */
export interface LoadedSkill extends SkillDocument {
  /** Absolute path of the SKILL.md this document came from. */
  readonly path: string
}

/**
 * Reads one skill by name from the first root that holds it, or undefined when no
 * root lists it or the file no longer parses. The roots are searched again here, so
 * a caller that named a skill and the catalogue it read cannot drift apart.
 */
export function loadSkill(
  roots: ReadonlyArray<string>,
  name: string,
): Effect.Effect<LoadedSkill | undefined> {
  return Effect.gen(function* () {
    const listed = yield* discoverSkills(roots)
    const match = listed.find((skill) => skill.name === name)
    if (match === undefined) return undefined
    const text = yield* readIfPresent(match.path)
    const document = text === undefined ? undefined : parseSkillDocument(text)
    // A document that stopped parsing between listing and reading is no skill now.
    return document === undefined ? undefined : { ...document, path: match.path }
  })
}

/** One catalog description: single line, trimmed, bounded. */
export const catalogDescription = (description: string): string =>
  description.replace(/\s+/g, ' ').trim().slice(0, DESCRIPTION_MAX)

/**
 * The durable catalog the model reads, or '' when no skill is available: an empty
 * catalog is not worth a message, and the model then has nothing to call.
 */
export function renderSkillCatalog(skills: ReadonlyArray<SkillSummary>): string {
  if (skills.length === 0) return ''
  return [
    '<system-reminder>',
    'A skill is a reusable set of task-specific instructions. The following skills are available in this session:',
    '',
    '<available_skills>',
    ...skills.map((skill) => '- ' + skill.name + ': ' + catalogDescription(skill.description)),
    '</available_skills>',
    '',
    "If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.",
    '</system-reminder>',
  ].join('\n')
}

export interface SkillRootsInput {
  readonly cwd: string
  /** The jzh home; its skills apply to every workspace. */
  readonly home?: string
  /** Roots from the settings file, in order. */
  readonly custom?: ReadonlyArray<string>
}

/** The skill roots of this run, project first. A repeated root appears once. */
export function skillRoots(input: SkillRootsInput): ReadonlyArray<string> {
  return [
    ...new Set([
      join(input.cwd, '.jzh', 'skills'),
      ...(input.custom ?? []),
      ...(input.home === undefined ? [] : [join(input.home, 'skills')]),
    ]),
  ]
}
