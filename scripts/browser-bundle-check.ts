import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The repository root, whichever package manager script started this file. */
const root = fileURLToPath(new URL('..', import.meta.url))
const assets = join(root, 'apps/web/dist/assets')

// Import shapes that would make the worker need a Node host. The Effect runtime
// mentions `node:async_hooks` in a guarded capability probe; that is a string,
// not an import, so the patterns below look for import syntax rather than the
// bare `node:` prefix.
const NODE_IMPORTS = [
  /\bfrom\s*['"]node:/,
  /\bimport\s*\(\s*['"]node:/,
  /\bimport\s*['"]node:/,
  /\brequire\s*\(\s*['"]node:/,
  /\bfrom\s*['"](?:fs|path|os|child_process|http|https|tls)['"]/,
  /\brequire\s*\(\s*['"](?:fs|path|os|child_process|http|https|tls)['"]\s*\)/,
]

/**
 * Builds the client app and reads the worker chunk back. The page chooses the
 * browser runtime at runtime, so the worker is a separate bundle: inspecting
 * that bundle is the only way to prove the browser-only path carries no Node
 * import that a page could not resolve.
 */
const main = (): void => {
  execFileSync('vp', ['-C', 'apps/web/client-solid', 'build'], { cwd: root, stdio: 'inherit' })

  const files = readdirSync(assets).filter((name) => name.endsWith('.js'))
  const workers = files.filter((name) => name.startsWith('worker-entry-'))
  if (workers.length === 0) {
    throw new Error('the client build emitted no worker-entry chunk; the page entry did not bundle')
  }

  const offenders: string[] = []
  for (const name of workers) {
    const source = readFileSync(join(assets, name), 'utf8')
    for (const pattern of NODE_IMPORTS) {
      const match = pattern.exec(source)
      if (match !== null) offenders.push(name + ': ' + match[0])
    }
  }
  if (offenders.length > 0) {
    throw new Error('the browser worker bundle imports Node:\n' + offenders.join('\n'))
  }
  console.log(
    'browser bundle: ' + workers.join(', ') + ' has no Node imports (worker-entry chunk exists)',
  )
}

main()
