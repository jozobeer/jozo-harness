import { Context, Effect, Layer, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import {
  LspTools,
  lspParameters,
  lspPlugin,
  lspTool,
  normalizeLocation,
  type LspArgs,
} from '../src/index.ts'

const args = (over: Partial<LspArgs>): LspArgs => ({
  action: 'definition',
  path: 'src/a.ts',
  line: 1,
  column: 1,
  ...over,
})

const refusal = (path: string) =>
  Effect.runPromise(
    Effect.flip(lspTool.execute(args({ path }), { sessionId: 's1', cwd: '/work', callId: 'c1' })),
  )

describe('lsp tool', () => {
  test('decodes a call that counts from 1', () => {
    const decoded = Schema.decodeUnknownSync(lspParameters)(args({ line: 3, column: 7 }))

    expect(decoded.line).toBe(3)
    expect(decoded.column).toBe(7)
  })

  test('refuses a line or column below 1', () => {
    expect(() => Schema.decodeUnknownSync(lspParameters)(args({ line: 0 }))).toThrow()
    expect(() => Schema.decodeUnknownSync(lspParameters)(args({ column: 0 }))).toThrow()
  })

  test('says no server covers the extension instead of failing the run', async () => {
    const error = await refusal('notes.md')

    expect(error.code).toBe('unavailable')
    expect(error.message).toBe('no language server for .md in this run')
  })

  test('names the server a supported extension would need', async () => {
    const error = await refusal('src/a.ts')

    expect(error.code).toBe('unavailable')
    expect(error.message).toBe('no language server for .ts (typescript) in this run')
  })

  test('normalizes a server location to the 1-based shape every action returns', () => {
    const result = normalizeLocation(
      {
        uri: 'file:///work/src/a.ts',
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
      },
      'const',
    )

    expect(result).toEqual({
      uri: 'file:///work/src/a.ts',
      range: { start: { line: 1, column: 1 }, end: { line: 1, column: 4 } },
      text: 'const',
    })
  })

  test('provides the lsp tool only through its own plugin row', async () => {
    const names = await Effect.runPromise(
      Effect.scoped(
        Effect.map(Layer.build(lspPlugin.layer({})), (context) =>
          Context.get(context, LspTools).map((tool) => tool.name),
        ),
      ),
    )

    expect(names).toEqual(['lsp'])
    expect(lspPlugin.name).toBe('@jozo-harness/lsp')
  })
})
