import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'

const seam = new URL('../src/', import.meta.url)

/** Every specifier a source file imports statically. */
const staticImports = (source: string): ReadonlyArray<string> =>
  [...source.matchAll(/from '([^']+)'/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  )

describe('browser worker dependencies', () => {
  test('the worker seam takes every Node-facing concern from its caller', async () => {
    const read = async (name: string): Promise<string> =>
      (await readFile(new URL(name, seam))).toString('utf8')
    const protocol = await read('worker-protocol.ts')
    const host = await read('worker-host.ts')
    const client = await read('worker-client.ts')
    const entry = await read('worker.ts')

    // The protocol, the host, the page client, and the scope entry are the new Worker surface.
    // None of them may reach a builtin: the workspace, the log, and the model
    // transport arrive as values, which is what lets a test run them under a
    // fake worker and a page run them without a disk.
    const specifiers = [
      ...staticImports(protocol),
      ...staticImports(host),
      ...staticImports(client),
      ...staticImports(entry),
    ]
    expect(specifiers.filter((specifier) => specifier.startsWith('node:'))).toEqual([])
    expect(specifiers).not.toContain('@jozo-harness/process')
    expect(specifiers).not.toContain('@jozo-harness/filesystem/node')
  })
})
