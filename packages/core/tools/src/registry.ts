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
} from './types.ts'

type AnyTool = ToolDefinition<any, any>

export interface ToolRegistry {
  /** Registers a tool until the surrounding scope closes. */
  register<A, V>(tool: ToolDefinition<A, V>): Effect.Effect<void, ToolError, Scope.Scope>
  /** Registers a monotonic policy check until the surrounding scope closes. */
  guard(guard: ToolGuard): Effect.Effect<void, never, Scope.Scope>
  /** Registers a tool filter until the surrounding scope closes. */
  restrict(restriction: ToolRestriction): Effect.Effect<void, never, Scope.Scope>
  /** Model-facing declarations after every active restriction. */
  schemas(): ReadonlyArray<ToolSchema>
  isConcurrencySafe(tool: string, argumentsJson: string): boolean
  call(request: ToolCallRequest): Effect.Effect<ToolCallOutcome>
  presentCall(tool: string, argumentsJson: string): ToolCallView
  presentResult(tool: string, argumentsJson: string, result: ToolResultView): ToolResultView
}

/** What the model sees of one tool: name, description, and the JSON Schema of its arguments. */
export const toolDeclaration = (tool: AnyTool): ToolSchema => {
  const document = Schema.toJsonSchemaDocument(tool.parameters)
  return {
    name: tool.name,
    description: tool.description,
    parameters: { ...document.schema, $defs: document.definitions },
  }
}

/** Builds a tool registry over one hook registry. */
export function makeTools(hooks: HookRegistry): ToolRegistry {
  const registered = new Map<string, AnyTool>()
  const guards = new Set<ToolGuard>()
  const restrictions = new Set<ToolRestriction>()

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
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (registered.get(tool.name) === tool) registered.delete(tool.name)
          }),
        )
      }),

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

    isConcurrencySafe: (tool, argumentsJson) => {
      const definition = registered.get(tool)
      if (definition?.isConcurrencySafe === undefined) return false
      const decoded = tryDecodeArguments(definition, argumentsJson)
      return Option.isSome(decoded) && definition.isConcurrencySafe(decoded.value)
    },

    call: (request) => {
      const tool = registered.get(request.tool)
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
      const definition = registered.get(tool)
      const fallback = { summary: callSummary(tool, argumentsJson) }
      if (definition?.presentCall === undefined) return fallback
      const decoded = tryDecodeArguments(definition, argumentsJson)
      return Option.isSome(decoded) ? definition.presentCall(decoded.value) : fallback
    },

    presentResult: (tool, argumentsJson, result) => {
      const definition = registered.get(tool)
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
