import { startBrowserWorker, type BrowserWorkerScope } from '@jozo-harness/runtime-browser/worker'
import { parseBrowserWorkerInit } from './init.ts'

/** The scope a module worker runs in; it posts and listens like the host expects. */
type WorkerScope = BrowserWorkerScope

const scope = globalThis as unknown as WorkerScope
let started = false

/**
 * The worker's own entry. The page posts the model settings first; only then
 * does the runtime start, so a worker with no settings never reaches the model
 * and a page cannot change them mid-turn.
 */
scope.addEventListener('message', (event) => {
  const init = parseBrowserWorkerInit(event.data)
  if (init === undefined || started) return
  started = true
  startBrowserWorker(scope, {
    route: init.route,
    baseUrl: init.baseUrl,
    apiKey: () => (init.apiKey === '' ? undefined : init.apiKey),
  })
})
