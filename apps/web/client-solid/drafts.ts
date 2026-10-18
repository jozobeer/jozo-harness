import { draftKey } from '../src/ui/draft.ts'

/**
 * The surface of the browser's storage this page uses, written here rather than
 * read from the DOM library, so the store that drives the page can run where no
 * browser is in scope.
 */
declare const localStorage: {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

/** The draft an earlier visit left for one session; a browser that refuses storage keeps none. */
export const readDraft = (sessionId: string): string => {
  try {
    return localStorage.getItem(draftKey(sessionId)) ?? ''
  } catch {
    // A private window may refuse to be read; the draft lives for this visit only.
    return ''
  }
}

/** Keeps one session's draft for the next visit, or forgets it once it is sent. */
export const writeDraft = (sessionId: string, text: string): void => {
  try {
    if (text === '') localStorage.removeItem(draftKey(sessionId))
    else localStorage.setItem(draftKey(sessionId), text)
  } catch {
    // Storing a draft is a convenience; a browser that refuses it is not a failure.
  }
}
