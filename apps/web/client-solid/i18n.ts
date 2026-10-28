import { createContext, useContext, type Accessor } from 'solid-js'
import { DEFAULT_LOCALE, message, type Locale, type MessageKey } from './locale.ts'

/** One fixed line, in the language the page is set to. */
export type Translate = (key: MessageKey) => string

/** What a page tells its parts about the language, and how the reader changes it. */
export interface LocaleChoice {
  readonly locale: Accessor<Locale>
  readonly choose: (locale: Locale) => void
}

/** The default language, for a part drawn on its own as a test draws one. */
const defaultChoice: LocaleChoice = {
  locale: () => DEFAULT_LOCALE,
  choose: () => undefined,
}

export const LocaleContext = createContext<LocaleChoice>(defaultChoice)

export const useLocaleChoice = (): LocaleChoice => useContext(LocaleContext) ?? defaultChoice

/** The page's fixed lines, in the language it currently speaks. */
export const useTranslate = (): Translate => {
  const choice = useLocaleChoice()
  return (key) => message(choice.locale(), key)
}
