import { Tools } from '@jozo-harness/tools'
import { Context, Effect, Layer, type Scope } from 'effect'
import { builtinContexts, builtinSections, type BuiltinOptions } from './builtin.ts'
import {
  PromptError,
  type AssembleContext,
  type PromptBuild,
  type PromptSection,
  type RuntimeContextEntry,
  type RuntimeContextSubject,
} from './types.ts'

export interface SystemPromptShape {
  /** Registers a section until the surrounding scope closes. Duplicate names fail. */
  section(section: PromptSection): Effect.Effect<void, PromptError, Scope.Scope>
  sections(): ReadonlyArray<PromptSection>
  /** Registers one runtime fact until the surrounding scope closes. Duplicate names fail. */
  context(entry: RuntimeContextEntry): Effect.Effect<void, PromptError, Scope.Scope>
  contexts(): ReadonlyArray<RuntimeContextEntry>
  render(context: AssembleContext): Effect.Effect<string, PromptError>
  /**
   * The runtime snapshot of this subject: the registered facts in order, or '' when
   * none has a value. What changes between requests reaches the model here, not in
   * the system prompt.
   */
  runtimeContext(subject: RuntimeContextSubject): Effect.Effect<string>
  /** The system text plus the model-facing tools of the current context. */
  build(context: AssembleContext): Effect.Effect<PromptBuild, PromptError, Tools>
  /**
   * Whether this registry may carry the GUI fact. The run decides it from the
   * system-prompt row; a session registers the fact only when a page serves it.
   */
  readonly devContext: boolean
}

const VARIABLE = /\{\{([A-Za-z0-9_-]+)\}\}/g

/** The first line of every runtime snapshot. */
export const RUNTIME_CONTEXT_HEADER = 'Current runtime context:'

/** The line that says an older snapshot no longer speaks for the session. */
export const RUNTIME_CONTEXT_SUPERSEDES =
  'This snapshot supersedes any earlier runtime-context snapshot.'

const compareEntries = (
  left: { readonly name: string; readonly order: number },
  right: { readonly name: string; readonly order: number },
): number => {
  if (left.order !== right.order) return left.order - right.order
  if (left.name === right.name) return 0
  return left.name < right.name ? -1 : 1
}

const interpolate = (
  text: string,
  context: AssembleContext,
): Effect.Effect<string, PromptError> => {
  const missing: Array<string> = []
  const rendered = text.replace(VARIABLE, (_match: string, name: string) => {
    const value = context.variables[name]
    if (value === undefined) {
      missing.push(name)
      return `{{${name}}}`
    }
    return value
  })
  return missing.length === 0
    ? Effect.succeed(rendered)
    : Effect.fail(
        new PromptError({
          code: 'unknown-variable',
          message: `unknown prompt variables: ${missing.join(', ')}`,
        }),
      )
}

/** Builds an in-memory prompt section and runtime context registry. */
export function makeSystemPrompt(
  options: { readonly devContext?: boolean } = {},
): SystemPromptShape {
  const registered = new Map<string, PromptSection>()
  const contexts = new Map<string, RuntimeContextEntry>()

  const assemble = (
    context: AssembleContext,
  ): Effect.Effect<
    { readonly text: string; readonly sections: ReadonlyArray<string> },
    PromptError
  > =>
    Effect.gen(function* () {
      const complete = [...registered.values()].filter((section) => section.complete === true)
      if (complete.length > 1) {
        return yield* Effect.fail(
          new PromptError({
            code: 'multiple-complete',
            message: `complete prompt sections: ${complete.map((section) => section.name).join(', ')}`,
          }),
        )
      }
      const chosen =
        complete[0] !== undefined ? complete : [...registered.values()].sort(compareEntries)
      const texts: Array<string> = []
      const sections: Array<string> = []
      for (const section of chosen) {
        const raw = typeof section.text === 'function' ? section.text(context) : section.text
        // A section may render nothing: the tool guidance does when no visible tool has any.
        const text = yield* interpolate(raw, context)
        if (text === '') continue
        texts.push(text)
        sections.push(section.name)
      }
      return { text: texts.join('\n\n'), sections }
    })

  const render = (context: AssembleContext): Effect.Effect<string, PromptError> =>
    Effect.map(assemble(context), (built) => built.text)

  return {
    devContext: options.devContext ?? true,

    section: (section) =>
      Effect.gen(function* () {
        if (registered.has(section.name)) {
          return yield* Effect.fail(
            new PromptError({
              code: 'duplicate-section',
              message: `prompt section ${section.name} is already registered`,
            }),
          )
        }
        registered.set(section.name, section)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (registered.get(section.name) === section) registered.delete(section.name)
          }),
        )
      }),

    sections: () => [...registered.values()],

    context: (entry) =>
      Effect.gen(function* () {
        if (contexts.has(entry.name)) {
          return yield* Effect.fail(
            new PromptError({
              code: 'duplicate-context',
              message: `runtime context ${entry.name} is already registered`,
            }),
          )
        }
        contexts.set(entry.name, entry)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (contexts.get(entry.name) === entry) contexts.delete(entry.name)
          }),
        )
      }),

    contexts: () => [...contexts.values()],

    runtimeContext: (subject) =>
      Effect.gen(function* () {
        const lines: Array<string> = []
        for (const entry of [...contexts.values()].sort(compareEntries)) {
          const text = yield* entry.text(subject)
          if (text !== undefined && text !== '') lines.push('- ' + text)
        }
        return lines.length === 0
          ? ''
          : [RUNTIME_CONTEXT_HEADER, RUNTIME_CONTEXT_SUPERSEDES, ...lines].join('\n')
      }),

    render,

    build: (context) =>
      Effect.gen(function* () {
        const tools = yield* Tools
        const schemas = tools.schemas()
        const built = yield* assemble({
          ...context,
          tools: schemas,
          signatures: tools.signatures(),
        })
        return { system: built.text, sections: built.sections, tools: schemas }
      }),
  }
}

/** Prompt registry of the application. */
export class SystemPrompt extends Context.Service<SystemPrompt, SystemPromptShape>()(
  'jozo-harness/SystemPrompt',
) {}

/**
 * The registry the application runs with: a fresh registry that already holds the
 * built-in sections and runtime contexts. A duplicate built-in name is a
 * programming error, not input.
 */
export const systemPromptLayerWith = (options: BuiltinOptions = {}): Layer.Layer<SystemPrompt> =>
  Layer.effect(
    SystemPrompt,
    Effect.gen(function* () {
      const prompt = makeSystemPrompt(
        options.devContext === undefined ? {} : { devContext: options.devContext },
      )
      for (const section of builtinSections(options)) yield* prompt.section(section)
      for (const entry of builtinContexts(options)) yield* prompt.context(entry)
      return prompt
    }).pipe(Effect.orDie),
  )

export const systemPromptLayer: Layer.Layer<SystemPrompt> = systemPromptLayerWith()
