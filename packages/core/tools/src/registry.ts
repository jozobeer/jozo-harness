import { Hooks, type HookRegistry } from '@jozo-harness/kernel'
import type { ToolSchema } from '@jozo-harness/llm'
import { Context, Effect, Layer, Option, Schema } from 'effect'
import type { Scope } from 'effect'
import { errorResult, executeTool, toolErrorInfo, tryDecodeArguments } from './pipeline.ts'
import { callSummary } from './summary.ts'
import {
  ToolError,
  type ToolCallOutcome,
  type ToolCallRequest,
  type ToolCallView,
  type ToolDefinition,
  type ToolGuard,
  type ToolRestriction,
  type ToolResultView,
  type ToolSignature,
} from './types.ts'

type AnyTool = ToolDefinition<any, any>

export interface ToolRegistry {
  /** Registers a tool until the surrounding scope closes. */
  register<A, V>(tool: ToolDefinition<A, V>): Effect.Effect<void, ToolError, Scope.Scope>
  /**
   * Withdraws a tool from what the next request is offered. A call already chosen
   * for the step that is running still runs, so taking a row away never cuts a
   * step short; the scope that registered the tool releases whatever it built.
   */
  retire(name: string): void
  /** Registers a monotonic policy check until the surrounding scope closes. */
  guard(guard: ToolGuard): Effect.Effect<void, never, Scope.Scope>
  /** Registers a tool filter until the surrounding scope closes. */
  restrict(restriction: ToolRestriction): Effect.Effect<void, never, Scope.Scope>
  /** Model-facing declarations after every active restriction. */
  schemas(): ReadonlyArray<ToolSchema>
  /** The same visible tools with both their argument and result schemas. */
  signatures(): ReadonlyArray<ToolSignature>
  isConcurrencySafe(tool: string, argumentsJson: string): boolean
  call(request: ToolCallRequest): Effect.Effect<ToolCallOutcome>
  presentCall(tool: string, argumentsJson: string): ToolCallView
  presentResult(tool: string, argumentsJson: string, result: ToolResultView): ToolResultView
}

/** The JSON Schema a provider reads, with the definitions its refs point at. */
const jsonSchemaOf = (schema: Schema.Schema<any>): Readonly<Record<string, unknown>> => {
  const document = Schema.toJsonSchemaDocument(schema)
  return { ...document.schema, $defs: document.definitions }
}

/** What the model sees of one tool: name, description, and the JSON Schema of its arguments. */
export const toolDeclaration = (tool: AnyTool): ToolSchema => ({
  name: tool.name,
  description: tool.description,
  parameters: jsonSchemaOf(tool.parameters),
})

/** Builds a tool registry over one hook registry. */
export function makeTools(hooks: HookRegistry): ToolRegistry {
  const registered = new Map<string, AnyTool>()
  // A retired tool is no longer offered, but the step that chose it may still call
  // it; the entry stays until its scope closes or another row claims the name.
  const retired = new Map<string, AnyTool>()
  const guards = new Set<ToolGuard>()
  const restrictions = new Set<ToolRestriction>()

  const toolNamed = (name: string): AnyTool | undefined => registered.get(name) ?? retired.get(name)

  const allowed = (tool: string): boolean =>
    [...restrictions].every((restriction) => restriction.allows(tool))

  return {
    register: (tool) =>
      Effect.gen(function* () {
        if (registered.has(tool.name)) {
          return yield* Effect.fail(
            new ToolError({
              code: 'duplicate-tool',
              message: `tool ${tool.name} is already registered`,
            }),
          )
        }
        registered.set(tool.name, tool)
        retired.delete(tool.name)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (registered.get(tool.name) === tool) registered.delete(tool.name)
            if (retired.get(tool.name) === tool) retired.delete(tool.name)
          }),
        )
      }),

    retire: (name) => {
      const tool = registered.get(name)
      if (tool === undefined) return
      registered.delete(name)
      retired.set(name, tool)
    },

    guard: (guard) =>
      Effect.gen(function* () {
        guards.add(guard)
        yield* Effect.addFinalizer(() => Effect.sync(() => guards.delete(guard)))
      }),

    restrict: (restriction) =>
      Effect.gen(function* () {
        restrictions.add(restriction)
        yield* Effect.addFinalizer(() => Effect.sync(() => restrictions.delete(restriction)))
      }),

    schemas: () =>
      [...registered.values()]
        .filter((tool) => allowed(tool.name))
        .map((tool) => toolDeclaration(tool)),

    signatures: () =>
      [...registered.values()]
        .filter((tool) => allowed(tool.name))
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: jsonSchemaOf(tool.parameters),
          output: jsonSchemaOf(tool.output.schema),
        })),

    isConcurrencySafe: (tool, argumentsJson) => {
      const definition = toolNamed(tool)
      if (definition?.isConcurrencySafe === undefined) return false
      const decoded = tryDecodeArguments(definition, argumentsJson)
      return Option.isSome(decoded) && definition.isConcurrencySafe(decoded.value)
    },

    call: (request) => {
      const tool = toolNamed(request.tool)
      if (tool === undefined) {
        return Effect.succeed(
          errorResult(`unknown tool: ${request.tool}`, toolErrorInfo('unknown-tool')),
        )
      }
      if (!allowed(request.tool)) {
        return Effect.succeed(
          errorResult('tool not allowed here: ' + request.tool, toolErrorInfo('denied')),
        )
      }
      return executeTool(hooks, tool, request, [...guards])
    },

    presentCall: (tool, argumentsJson) => {
      const definition = toolNamed(tool)
      const fallback = { summary: callSummary(tool, argumentsJson) }
      if (definition?.presentCall === undefined) return fallback
      const decoded = tryDecodeArguments(definition, argumentsJson)
      return Option.isSome(decoded) ? definition.presentCall(decoded.value) : fallback
    },

    presentResult: (tool, argumentsJson, result) => {
      const definition = toolNamed(tool)
      if (definition?.presentResult === undefined) return result
      const decoded = tryDecodeArguments(definition, argumentsJson)
      return Option.isSome(decoded) ? definition.presentResult(decoded.value, result) : result
    },
  }
}

/** Registry of tools and their execution pipeline. */
export class Tools extends Context.Service<Tools, ToolRegistry>()('jozo-harness/Tools') {}

export const toolsLayer: Layer.Layer<Tools, never, Hooks> = Layer.effect(
  Tools,
  Effect.map(Hooks, (hooks) => makeTools(hooks)),
)
