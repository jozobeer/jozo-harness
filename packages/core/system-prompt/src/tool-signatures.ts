import type { ToolSignature } from '@jozo-harness/tools'

type JsonSchema = Readonly<Record<string, unknown>>

const isRecord = (value: unknown): value is JsonSchema =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const definitionsOf = (schema: JsonSchema): Readonly<Record<string, JsonSchema>> => {
  const definitions = schema['$defs']
  return isRecord(definitions)
    ? (Object.fromEntries(
        Object.entries(definitions).flatMap(([name, value]) =>
          isRecord(value) ? [[name, value] as const] : [],
        ),
      ) as Readonly<Record<string, JsonSchema>>)
    : {}
}

const requiredOf = (schema: JsonSchema): ReadonlySet<string> =>
  new Set(
    Array.isArray(schema['required'])
      ? schema['required'].filter((name): name is string => typeof name === 'string')
      : [],
  )

const propertiesOf = (schema: JsonSchema): Readonly<Record<string, unknown>> | undefined => {
  const properties = schema['properties']
  return isRecord(properties) ? properties : undefined
}

const referenceOf = (
  schema: JsonSchema,
  definitions: Readonly<Record<string, JsonSchema>>,
  depth: number,
): string | undefined => {
  const reference = schema['$ref']
  if (typeof reference !== 'string' || !reference.startsWith('#/$defs/')) return undefined
  const target = definitions[reference.slice('#/$defs/'.length)]
  return target === undefined || depth >= 3 ? 'unknown' : typeOf(target, definitions, depth + 1)
}

const unionOf = (
  schema: JsonSchema,
  definitions: Readonly<Record<string, JsonSchema>>,
  depth: number,
): string | undefined => {
  const union = schema['anyOf'] ?? schema['oneOf']
  if (!Array.isArray(union)) return undefined
  return union
    .map((one) => (isRecord(one) ? typeOf(one, definitions, depth) : 'unknown'))
    .join(' | ')
}

const literalOf = (schema: JsonSchema): string | undefined => {
  const options = schema['enum']
  if (Array.isArray(options)) return options.map((value) => JSON.stringify(value)).join(' | ')
  return schema['const'] === undefined ? undefined : JSON.stringify(schema['const'])
}

const primitiveOf = (type: unknown): string | undefined => {
  if (type === 'string') return 'string'
  if (type === 'integer' || type === 'number') return 'number'
  if (type === 'boolean') return 'boolean'
  return type === 'null' ? 'null' : undefined
}

const arrayOf = (
  schema: JsonSchema,
  definitions: Readonly<Record<string, JsonSchema>>,
  depth: number,
): string | undefined => {
  if (schema['type'] !== 'array') return undefined
  const items = schema['items']
  return (isRecord(items) ? typeOf(items, definitions, depth) : 'unknown') + '[]'
}

const typeListOf = (
  schema: JsonSchema,
  definitions: Readonly<Record<string, JsonSchema>>,
  depth: number,
  type: unknown,
): string | undefined => {
  if (!Array.isArray(type)) return undefined
  return type.map((one) => typeOf({ ...schema, type: one }, definitions, depth)).join(' | ')
}

const kindOf = (
  schema: JsonSchema,
  definitions: Readonly<Record<string, JsonSchema>>,
  depth: number,
): string => {
  const type = schema['type']
  if (type === undefined || type === 'object') return objectOf(schema, definitions, depth)
  return primitiveOf(type) ?? 'unknown'
}

const typeOf = (
  schema: JsonSchema,
  definitions: Readonly<Record<string, JsonSchema>>,
  depth = 0,
): string =>
  referenceOf(schema, definitions, depth) ??
  unionOf(schema, definitions, depth) ??
  literalOf(schema) ??
  arrayOf(schema, definitions, depth) ??
  typeListOf(schema, definitions, depth, schema['type']) ??
  kindOf(schema, definitions, depth)

const objectOf = (
  schema: JsonSchema,
  definitions: Readonly<Record<string, JsonSchema>>,
  depth: number,
): string => {
  const properties = propertiesOf(schema)
  if (properties === undefined) return 'Record<string, unknown>'
  const required = requiredOf(schema)
  const fields = Object.entries(properties).flatMap(([name, value]) =>
    isRecord(value)
      ? [name + (required.has(name) ? '' : '?') + ': ' + typeOf(value, definitions, depth)]
      : [],
  )
  return fields.length === 0 ? 'Record<string, unknown>' : '{ ' + fields.join('; ') + ' }'
}

/** The argument list of one tool, as a reader would write it in TypeScript. */
export const parameterList = (schema: JsonSchema): string => {
  const properties = propertiesOf(schema)
  if (properties === undefined) return ''
  const required = requiredOf(schema)
  const definitions = definitionsOf(schema)
  return Object.entries(properties)
    .flatMap(([name, value]) =>
      isRecord(value)
        ? [name + (required.has(name) ? '' : '?') + ': ' + typeOf(value, definitions)]
        : [],
    )
    .join(', ')
}

/** One line per visible tool: its name, arguments, and the type it returns. */
export const signatureLine = (tool: ToolSignature): string =>
  tool.name +
  '(' +
  parameterList(tool.parameters) +
  ') -> ' +
  typeOf(tool.output, definitionsOf(tool.output))

/** The heading that makes the signature block readable as one list. */
export const TOOL_SIGNATURES_HEADER =
  'Tools visible in this request, with the types of their arguments and result:'

/** The signature block of the tools this request may call; empty when none is visible. */
export const toolSignatureText = (signatures: ReadonlyArray<ToolSignature>): string =>
  signatures.length === 0
    ? ''
    : [TOOL_SIGNATURES_HEADER, ...signatures.map(signatureLine)].join('\n')
