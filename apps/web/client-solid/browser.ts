import { createSignal, type Accessor } from 'solid-js'

/** One page the reader opened: it lives in this page, not in the session. */
export interface BrowserTab {
  readonly id: number
  readonly url: string
  readonly host: string
}

/** Why an address did not open, as the pane says it. */
export type BrowserProblem = 'invalid'

/** The reader's own pages: the address line, the tabs, and the frame. */
export interface BrowserState {
  readonly tabs: Accessor<ReadonlyArray<BrowserTab>>
  readonly current: Accessor<BrowserTab | undefined>
  readonly address: Accessor<string>
  readonly problem: Accessor<BrowserProblem | undefined>
  readonly type: (text: string) => void
  readonly open: () => void
  readonly switchTo: (id: number) => void
  readonly close: (id: number) => void
}

/** An absolute http or https address, or nothing; no other scheme reaches the frame. */
export const httpUrl = (input: string): string | undefined => {
  try {
    const url = new URL(input.trim())
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
  } catch {
    return undefined
  }
}

/**
 * The browser's state stays in the page: it takes no store, sends nothing, and
 * no visited address can reach the session log or the model's tools.
 */
export const createBrowser = (): BrowserState => {
  const [tabs, setTabs] = createSignal<ReadonlyArray<BrowserTab>>([])
  const [currentId, setCurrentId] = createSignal<number | undefined>(undefined)
  const [address, setAddress] = createSignal('')
  const [problem, setProblem] = createSignal<BrowserProblem | undefined>(undefined)
  let nextId = 0

  const current = (): BrowserTab | undefined => tabs().find((tab) => tab.id === currentId())

  const open = (): void => {
    const url = httpUrl(address())
    if (url === undefined) {
      setProblem('invalid')
      return
    }
    nextId += 1
    const tab: BrowserTab = { id: nextId, url, host: new URL(url).host }
    setTabs((now) => [...now, tab])
    setCurrentId(tab.id)
    setAddress('')
    setProblem(undefined)
  }

  const switchTo = (id: number): void => {
    setCurrentId(id)
    setProblem(undefined)
  }

  const close = (id: number): void => {
    const rest = tabs().filter((tab) => tab.id !== id)
    setTabs(rest)
    if (currentId() === id) setCurrentId(rest.at(-1)?.id)
  }

  return { tabs, current, address, problem, type: setAddress, open, switchTo, close }
}
