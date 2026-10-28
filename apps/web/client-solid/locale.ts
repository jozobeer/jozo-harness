/** Where the page keeps the reader's language, so a reload speaks the same one. */
export const LOCALE_KEY = 'jzh.locale'

/** The language every line is written in when nothing names another. */
export const DEFAULT_LOCALE = 'en'

/** The languages the page ships, each named the way its speakers name it. */
export const LOCALES = [
  { id: 'en', label: 'English' },
  { id: 'ja', label: '日本語' },
] as const

export type Locale = (typeof LOCALES)[number]['id']

/** The page's own lines in the default language. This table is the complete one. */
const english = {
  'app.name': 'jozo-harness',
  'rail.hide': 'Hide sessions',
  'rail.show': 'Show sessions',
  'rail.hideHint': 'Hide sessions (Mod+B)',
  'rail.showHint': 'Show sessions (Mod+B)',
  'rail.resize': 'Resize sessions',
  'drawer.sessions': 'sessions',
  'context.title': 'Context',
  'lens.group': 'How the session reads',
  'lens.answers': 'Chat',
  'lens.timeline': 'Timeline',
  'status.waiting': 'waiting on you',
  'welcome.title': 'New session',
  'welcome.lead': 'Nothing has been said yet. Type below and press Enter.',
  'welcome.helpA': 'lists what a session answers;',
  'welcome.helpB': 'says where it stands',
  'welcome.shell': 'a shell command asks before it runs',
  'welcome.sheet':
    'the sheet on the right carries what the session works toward, its turns, jobs and settings',
  'settings.title': 'Settings',
  'settings.theme': 'theme',
  'settings.language': 'language',
}

export type MessageKey = keyof typeof english

/**
 * Japanese names every line but the page's own name, which reads the same in
 * both languages and is left to the default table.
 */
const japanese: Partial<Record<MessageKey, string>> = {
  'rail.hide': 'セッションを隠す',
  'rail.show': 'セッションを表示',
  'rail.hideHint': 'セッションを隠す (Mod+B)',
  'rail.showHint': 'セッションを表示 (Mod+B)',
  'rail.resize': 'セッションの幅を変える',
  'drawer.sessions': 'セッション',
  'context.title': 'コンテキスト',
  'lens.group': 'セッションの読み方',
  'lens.answers': '会話',
  'lens.timeline': 'タイムライン',
  'status.waiting': '件が対応待ち',
  'welcome.title': '新しいセッション',
  'welcome.lead': 'まだ何も話していません。下に入力して Enter を押してください。',
  'welcome.helpA': 'はセッションが答えることを一覧し、',
  'welcome.helpB': 'はその立ち位置を伝えます',
  'welcome.shell': 'シェルコマンドは実行前に確認します',
  'welcome.sheet': '右のシートには、セッションが目指すもの、ターン、ジョブ、設定があります',
  'settings.title': '設定',
  'settings.theme': 'テーマ',
  'settings.language': '言語',
}

/** The lines of each language a page may draw. */
const dictionaries: Readonly<Record<Locale, Partial<Record<MessageKey, string>>>> = {
  en: english,
  ja: japanese,
}

/** True when a stored or asked-for language is one the page speaks. */
export const isLocale = (value: string): value is Locale =>
  LOCALES.some((known) => known.id === value)

/** The language part of a browser tag, so ja-JP and ja both name Japanese. */
const languageOf = (tag: string): string => tag.toLowerCase().split('-')[0] ?? ''

/**
 * The language a page opens in: what the reader chose, then what the browser
 * asks for, then the default. A language the page does not speak never wins.
 */
export const localeFrom = (kept: string | null, languages: ReadonlyArray<string>): Locale => {
  if (kept !== null && isLocale(kept)) return kept
  const spoken = languages.map(languageOf).find(isLocale)
  return spoken ?? DEFAULT_LOCALE
}

/** The browser's languages, or none when there is no browser to ask. */
export const browserLanguages = (): ReadonlyArray<string> =>
  typeof navigator === 'undefined' ? [] : navigator.languages

/**
 * One fixed line in one language. A line a language leaves out is written in
 * the default language, so the reader never sees a key in place of a sentence.
 */
export const message = (locale: Locale, key: MessageKey): string =>
  dictionaries[locale][key] ?? english[key]

/** The tag dates and numbers of a language are written with. */
const intlOf = (locale: Locale): string => (locale === 'ja' ? 'ja-JP' : 'en-US')

/** A calendar day, ordered and spelled the way the language writes it. */
export const formatDate = (locale: Locale, at: Date): string =>
  new Intl.DateTimeFormat(intlOf(locale), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(at)

/** A count said the short way the language says it, for large numbers of tokens. */
export const formatCompact = (locale: Locale, value: number): string =>
  new Intl.NumberFormat(intlOf(locale), {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value)
