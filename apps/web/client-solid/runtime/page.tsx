import type { SessionEvent } from '@jozo-harness/session'
import {
  createBrowserWorkerClient,
  type BrowserWorkerClient,
} from '@jozo-harness/runtime-browser/worker-client'
import { For, Show, createSignal, onCleanup, onMount } from 'solid-js'
import { browserWorkerInitFrom, type BrowserWorkerInit } from './init.ts'

/** How a failure reads in the page; a page shows a string, never a cause. */
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** Makes the client the page talks to; a test injects one over its own Worker. */
export type ClientOpener = (onEvent: (event: SessionEvent) => void) => BrowserWorkerClient

/** One tool call as the page saw it, kept for the trace under the answer. */
interface ToolCall {
  readonly name: string
  readonly arguments: string
}

/**
 * The only way the standalone page makes a worker: the URL is a bundler entry,
 * and the settings travel in the first message rather than the address.
 */
export const pageWorker = (init: BrowserWorkerInit): Worker => {
  const worker = new Worker(new URL('./worker-entry.ts', import.meta.url), {
    type: 'module',
    name: 'jzh-browser-runtime',
  })
  worker.postMessage(init)
  return worker
}

export const openBrowserWorker = (
  init: BrowserWorkerInit,
  onEvent: (event: SessionEvent) => void,
): BrowserWorkerClient =>
  createBrowserWorkerClient({ createWorker: () => pageWorker(init), onEvent })

export interface BrowserRuntimePageProps {
  /** Used by the entry point, and replaced by a fake Worker in a test. */
  readonly open?: ClientOpener
  readonly init?: BrowserWorkerInit
}

/**
 * The browser-only page: one prompt, the assistant's answer, and the tool calls
 * that produced it. It has no socket and no server state; closing the tab (or
 * this component) terminates the worker, and the memory workspace goes with it.
 */
export const BrowserRuntimePage = (props: BrowserRuntimePageProps = {}) => {
  const [draft, setDraft] = createSignal('')
  const [answer, setAnswer] = createSignal('')
  const [calls, setCalls] = createSignal<ReadonlyArray<ToolCall>>([])
  const [problem, setProblem] = createSignal('')
  const [running, setRunning] = createSignal(false)
  let client: BrowserWorkerClient | undefined

  onMount(() => {
    const open: ClientOpener =
      props.open ??
      ((onEvent) =>
        openBrowserWorker(
          props.init ?? browserWorkerInitFrom(window.location.search, window.sessionStorage),
          onEvent,
        ))
    client = open((event) => {
      if (event.type !== 'tool/call') return
      setCalls((list) => [...list, { name: event.data.name, arguments: event.data.arguments }])
    })
  })

  onCleanup(() => {
    client?.close()
  })

  const send = (): void => {
    const text = draft().trim()
    const active = client
    if (text === '' || active === undefined || running()) return
    setDraft('')
    setRunning(true)
    setProblem('')
    setAnswer('')
    void active.prompt(text).then(
      (next) => {
        setAnswer(next)
        setRunning(false)
      },
      (error: unknown) => {
        setProblem(messageOf(error))
        setRunning(false)
      },
    )
  }

  return (
    <main class="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-6">
      <header>
        <h1 class="text-lg font-semibold">jzh in this page</h1>
        <p class="text-sm opacity-70">
          The workspace and the log live in a worker. Closing this tab deletes both.
        </p>
      </header>
      <form
        data-testid="prompt-form"
        class="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          send()
        }}
      >
        <input
          aria-label="Prompt"
          class="min-w-0 flex-1 rounded border border-current/20 px-3 py-2"
          value={draft()}
          onInput={(event) => setDraft(event.currentTarget.value)}
        />
        <button
          type="submit"
          class="rounded border border-current/20 px-3 py-2"
          disabled={running()}
        >
          Run
        </button>
      </form>
      <Show when={problem() !== ''}>
        <p role="alert" class="text-sm text-red-500">
          {problem()}
        </p>
      </Show>
      <Show when={calls().length > 0}>
        <ul aria-label="Tool calls" class="flex flex-col gap-1 text-sm">
          <For each={calls()}>
            {(call) => (
              <li data-testid="tool-call" class="rounded bg-current/5 px-2 py-1 font-mono">
                {call.name}({call.arguments})
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={answer() !== ''}>
        <p data-testid="answer" class="whitespace-pre-wrap">
          {answer()}
        </p>
      </Show>
    </main>
  )
}
