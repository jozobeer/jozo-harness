/** Where the page keeps the reader's language, so a reload speaks the same one. */
export const LOCALE_KEY = 'jzh.locale'

/** The languages the page ships, each named the way its speakers name it. */
export const LOCALES = [
  { id: 'en', label: 'English' },
  { id: 'ja', label: '日本語' },
] as const

export type Locale = (typeof LOCALES)[number]['id']

/** The language every line is written in when nothing names another. */
export const DEFAULT_LOCALE: Locale = 'en'

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
  'status.reconnecting': 'reconnecting…',
  'status.approval': 'waiting for your approval',
  'status.ask': 'answer the question and press Enter',
  'status.working': 'working…',
  'status.ready': 'ready',
  'when.now': 'now',
  'when.yesterday': 'yesterday',
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
  'settings.reading': 'reading the settings…',
  'settings.run': 'run',
  'settings.model': 'model',
  'settings.effort': 'effort',
  'settings.providerChooses': '(the provider chooses)',
  'settings.cwd': 'cwd',
  'settings.sessions': 'sessions',
  'settings.settingsPath': 'settings',
  'settings.none': '(none)',
  'settings.listModels': 'List models',
  'settings.useForNewSessions': 'Use for new sessions',
  'settings.useHint':
    'each session opened from now on starts from it; the settings file keeps it for later runs, and the seat switches the session in front of you',
  'board.search': 'Search sessions…',
  'board.searchLabel': 'Search sessions',
  'board.sessions': 'Sessions',
  'board.waiting': 'Waiting on you',
  'board.recent': 'Recent',
  'board.showArchived': 'Show archived',
  'board.hideArchived': 'Hide archived',
  'board.showEmpty': 'Show empty',
  'board.hideEmpty': 'Hide empty',
  'board.showMore': 'Show more',
  'board.noMatch': 'No sessions match',
  'session.name': 'Session name',
  'session.actions': 'Session actions',
  'menu.rename': 'Rename',
  'menu.pin': 'Pin',
  'menu.unpin': 'Unpin',
  'menu.archive': 'Archive',
  'menu.unarchive': 'Unarchive',
  'menu.copyId': 'Copy session ID',
  'menu.copied': 'Copied',
  'menu.copyFailed': 'Copy failed',
  'menu.delete': 'Delete',
  'menu.deleteAria': 'Delete session',
  'menu.deleteAsked': 'Delete this session?',
  'menu.deleteHint': 'Its log is removed. Pages it published remain.',
  'menu.deleteForever': 'Delete permanently',
  'menu.cancel': 'Cancel',
  'workspace.label': 'Workspace for a new session',
  'workspace.none': 'No workspace yet',
  'workspace.newSession': 'New session',
  'workspace.add': 'Add workspace',
  'workspace.addTitle': 'Add workspace',
  'workspace.reading': 'Reading folders…',
  'workspace.up': '↑ Up',
  'workspace.empty': 'No folders here',
  'composer.placeholder': 'Message jozo-harness…  (Enter sends, Shift+Enter adds a line)',
  'composer.quotes': 'passages the next message quotes',
  'composer.removeQuote': 'remove this quotation',
  'composer.removeQuoteAria': 'Remove quoted passage ',
  'composer.quoteSelection': 'Quote selection',
  'composer.quoteSelectionHint': 'quote the selected text in the next message',
  'composer.attachments': 'files the next message attaches',
  'composer.removeAttachment': 'remove this attachment',
  'composer.removeAttachmentAria': 'Remove attached file ',
  'composer.listening': 'Listening… the words go into the draft. Stop when you are done.',
  'composer.attach': 'Attach files',
  'composer.attachHint': 'Attach images or text files (or drop them here)',
  'composer.dictateStart': 'Start dictation',
  'composer.dictateStop': 'Stop dictation',
  'composer.dictateStartHint': 'Turn speech into text in this draft',
  'composer.dictateStopHint': 'Stop dictation and keep the words in the draft',
  'composer.send': 'Send the message',
  'composer.sendHint': 'Send the message (Enter)',
  'composer.stop': 'Stop the run',
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
  'status.reconnecting': '再接続中…',
  'status.approval': '承認待ちです',
  'status.ask': '質問に答えて Enter を押してください',
  'status.working': '実行中…',
  'status.ready': '待機中',
  'when.now': 'たった今',
  'when.yesterday': '昨日',
  'welcome.title': '新しいセッション',
  'welcome.lead': 'まだ何も話していません。下に入力して Enter を押してください。',
  'welcome.helpA': 'はセッションが答えることを一覧し、',
  'welcome.helpB': 'はその立ち位置を伝えます',
  'welcome.shell': 'シェルコマンドは実行前に確認します',
  'welcome.sheet': '右のシートには、セッションが目指すもの、ターン、ジョブ、設定があります',
  'settings.title': '設定',
  'settings.theme': 'テーマ',
  'settings.language': '言語',
  'settings.reading': '設定を読んでいます…',
  'settings.run': '実行',
  'settings.model': 'モデル',
  'settings.effort': '推論の強さ',
  'settings.providerChooses': '（プロバイダが選びます）',
  'settings.cwd': '作業ディレクトリ',
  'settings.sessions': 'セッションの保存先',
  'settings.settingsPath': '設定ファイル',
  'settings.none': '（なし）',
  'settings.listModels': 'モデルを一覧',
  'settings.useForNewSessions': '新しいセッションに使う',
  'settings.useHint':
    'これ以降に開くセッションはここから始まります。設定ファイルは以後の実行のために保存し、席は目の前のセッションを切り替えます',
  'board.search': 'セッションを検索…',
  'board.searchLabel': 'セッションを検索',
  'board.sessions': 'セッション',
  'board.waiting': '対応待ち',
  'board.recent': '最近',
  'board.showArchived': 'アーカイブを表示',
  'board.hideArchived': 'アーカイブを隠す',
  'board.showEmpty': '空を表示',
  'board.hideEmpty': '空を隠す',
  'board.showMore': 'もっと見る',
  'board.noMatch': '一致するセッションはありません',
  'session.name': 'セッション名',
  'session.actions': 'セッションの操作',
  'menu.rename': '名前を変更',
  'menu.pin': '固定',
  'menu.unpin': '固定を解除',
  'menu.archive': 'アーカイブ',
  'menu.unarchive': 'アーカイブを解除',
  'menu.copyId': 'セッション ID をコピー',
  'menu.copied': 'コピーしました',
  'menu.copyFailed': 'コピーに失敗',
  'menu.delete': '削除',
  'menu.deleteAria': 'セッションを削除',
  'menu.deleteAsked': 'このセッションを削除しますか？',
  'menu.deleteHint': 'ログは削除されます。公開したページは残ります。',
  'menu.deleteForever': '完全に削除',
  'menu.cancel': 'キャンセル',
  'workspace.label': '新しいセッションの作業場所',
  'workspace.none': '作業場所がまだありません',
  'workspace.newSession': '新しいセッション',
  'workspace.add': '作業場所を追加',
  'workspace.addTitle': '作業場所を追加',
  'workspace.reading': 'フォルダを読んでいます…',
  'workspace.up': '↑ 上へ',
  'workspace.empty': 'ここにフォルダはありません',
  'composer.placeholder': 'jozo-harness にメッセージ… （Enter で送信、Shift+Enter で改行）',
  'composer.quotes': '次のメッセージが引用する箇所',
  'composer.removeQuote': 'この引用を外す',
  'composer.removeQuoteAria': '引用した箇所を外す ',
  'composer.quoteSelection': '選択範囲を引用',
  'composer.quoteSelectionHint': '選択中のテキストを次のメッセージで引用する',
  'composer.attachments': '次のメッセージが添付するファイル',
  'composer.removeAttachment': 'この添付を外す',
  'composer.removeAttachmentAria': '添付ファイルを外す ',
  'composer.listening': '聞き取り中… 言葉は下書きに入ります。終わったら停止してください。',
  'composer.attach': 'ファイルを添付',
  'composer.attachHint': '画像やテキストファイルを添付（ここにドロップも可）',
  'composer.dictateStart': '音声入力を開始',
  'composer.dictateStop': '音声入力を停止',
  'composer.dictateStartHint': '音声をこの下書きのテキストにする',
  'composer.dictateStopHint': '音声入力を止め、言葉は下書きに残す',
  'composer.send': 'メッセージを送信',
  'composer.sendHint': 'メッセージを送信 (Enter)',
  'composer.stop': '実行を停止',
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

/** A calendar day as a row says it, without the year. */
export const formatShortDate = (locale: Locale, at: Date): string =>
  new Intl.DateTimeFormat(intlOf(locale), { month: 'short', day: 'numeric' }).format(at)

/** A count said the short way the language says it, for large numbers of tokens. */
export const formatCompact = (locale: Locale, value: number): string =>
  new Intl.NumberFormat(intlOf(locale), {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value)
