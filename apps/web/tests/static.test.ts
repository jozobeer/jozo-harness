import { describe, expect, test } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { staticPath, staticResponse } from '../src/server/index.ts'
/** Writes a file, making the directories above it, because the file may not be there yet. */
const writeFileDeep = async (path: string, text: string | Uint8Array): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

describe('static files', () => {
  test('the root and plain names stay inside the root', () => {
    expect(staticPath('/srv/app', '/')).toBe('/srv/app/index.html')
    expect(staticPath('/srv/app', '/main.js')).toBe('/srv/app/main.js')
    expect(staticPath('/srv/app', '/assets/app.css')).toBe('/srv/app/assets/app.css')
  })

  test('a directory request serves the page inside it', () => {
    expect(staticPath('/srv/app', '/solid/')).toBe('/srv/app/solid/index.html')
    expect(staticPath('/srv/app', '/deep/nested/')).toBe('/srv/app/deep/nested/index.html')
  })

  test('paths that climb out are refused, encoded or not', () => {
    expect(staticPath('/srv/app', '/../secret')).toBeUndefined()
    expect(staticPath('/srv/app', '/%2e%2e/secret')).toBeUndefined()
    expect(staticPath('/srv/app', '/a/../../secret')).toBeUndefined()
    expect(staticPath('/srv/app', '/%zz')).toBeUndefined()
    expect(staticPath('/srv/app', '/bad\u0000name')).toBeUndefined()
  })

  test('a present file answers with its type and a missing one does not answer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-static-'))
    await writeFileDeep(join(root, 'index.html'), '<h1>jozo-harness</h1>')
    const found = await staticResponse(root, '/')
    expect(found?.headers.get('content-type')).toBe('text/html; charset=utf-8')
    // The startup URL carries the token until the page strips it, so the page
    // must not name that address to another request or leave it in a cache.
    expect(found?.headers.get('referrer-policy')).toBe('no-referrer')
    expect(found?.headers.get('cache-control')).toBe('no-store')
    expect(await found?.text()).toBe('<h1>jozo-harness</h1>')
    expect(await staticResponse(root, '/missing.js')).toBeUndefined()
    await rm(root, { recursive: true, force: true })
  })
})
