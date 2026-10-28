/**
 * Turning speech into the composer's draft. The page asks the browser's own
 * recognizer for words, and only words: the microphone never reaches the model,
 * so the history holds nothing but the text the human chose to send.
 */

/** One phrase the browser heard; a result may offer more than one, the first is used. */
export interface VoiceAlternative {
  readonly transcript: string
}

/** One phrase, final once the browser stops revising it. */
export interface VoiceResult {
  readonly isFinal: boolean
  readonly 0?: VoiceAlternative
}

/** The results a recognizer reports, oldest first; the index marks the ones that changed. */
export interface VoiceResultEvent {
  readonly resultIndex: number
  readonly results: ReadonlyArray<VoiceResult>
}

export interface VoiceErrorEvent {
  readonly error: string
}

/** What the composer needs from a recognizer; the browser's own fits this shape. */
export interface VoiceRecognition {
  continuous: boolean
  interimResults: boolean
  start(): void
  stop(): void
  abort(): void
  onresult: ((event: VoiceResultEvent) => void) | null
  onerror: ((event: VoiceErrorEvent) => void) | null
  onend: (() => void) | null
}

/** A recognizer constructor, as the browser exposes it. */
export type VoiceConstructor = new () => VoiceRecognition

/** Opens one microphone; a page that has none cannot make one. */
export type VoiceFactory = () => VoiceRecognition

/** Why speech cannot be offered, in the sentence the reader is shown. */
export const NO_RECOGNITION = 'This browser cannot turn speech into text. Type the message instead.'
export const INSECURE_PAGE = 'Speech needs a secure page. Open the page over https or on localhost.'
export const UNKNOWN_FAILURE = 'Speech recognition stopped for an unknown reason.'
export const OPEN_FAILURE = 'The microphone could not be opened.'

/** The reasons a recognizer ends with, in words the reader can act on. */
const FAILURE_REASONS: Readonly<Record<string, string>> = {
  'not-allowed': 'Microphone access was refused. Allow it in the address bar and try again.',
  'permission-denied': 'Microphone access was refused. Allow it in the address bar and try again.',
  'service-not-allowed': 'This browser does not allow speech recognition here.',
  'audio-capture': 'No microphone was found.',
  'no-speech': 'No speech was heard. Try again.',
  network: 'Speech recognition needs a network connection that was not there.',
  'language-not-supported': 'This browser cannot recognize the language of this page.',
  aborted: 'Speech recognition was interrupted.',
}

/** The reason a recognizer gave for ending, said the way the reader can use it. */
export const failureReason = (error: string): string => FAILURE_REASONS[error] ?? UNKNOWN_FAILURE

/** The browser facts that decide whether this page may open a microphone. */
export interface VoiceScope {
  /** The browser's recognizer constructor, when it has one. */
  readonly recognition?: VoiceFactory
  /** Whether the page is a secure context; speech is hidden on plain http. */
  readonly secure: boolean
}

export type VoiceSupport =
  | { readonly kind: 'ready'; readonly open: VoiceFactory }
  | { readonly kind: 'missing'; readonly reason: string }

/** Whether this page may open a microphone, and when it may not, why. */
export const voiceSupport = (scope: VoiceScope): VoiceSupport => {
  if (scope.recognition !== undefined) return { kind: 'ready', open: scope.recognition }
  return { kind: 'missing', reason: scope.secure ? NO_RECOGNITION : INSECURE_PAGE }
}

/** The part of a page the recognizer is read from; the window fits it. */
export interface VoicePage {
  readonly SpeechRecognition?: VoiceConstructor
  readonly webkitSpeechRecognition?: VoiceConstructor
  readonly isSecureContext: boolean
}

declare global {
  interface Window {
    /** The speech API is not in the DOM library this repository compiles against. */
    SpeechRecognition?: VoiceConstructor
    webkitSpeechRecognition?: VoiceConstructor
  }
}

/** The recognizer this page can open, read beside the secure context it needs. */
export const browserVoice = (page: VoicePage = window): VoiceScope => {
  const Constructor = page.SpeechRecognition ?? page.webkitSpeechRecognition
  if (Constructor === undefined) return { secure: page.isSecureContext }
  return { secure: page.isSecureContext, recognition: () => new Constructor() }
}

/** What the microphone has put beside the draft so far. */
export interface Dictation {
  /** The draft as it stood when recording started; a failure puts it back. */
  readonly base: string
  /** Every phrase the browser has settled, in the order heard. */
  readonly spoken: string
  /** The phrase the browser is still revising. */
  readonly hearing: string
}

export const dictate = (base: string): Dictation => ({ base, spoken: '', hearing: '' })

/** Joins what the human had with what was heard, without eating or doubling a space. */
const beside = (before: string, heard: string): string => {
  const phrase = heard.trim()
  if (phrase === '') return before
  return before === '' || /\s$/.test(before) ? before + phrase : before + ' ' + phrase
}

/** The line the composer should hold: the old draft, then what was heard. */
export const draftOf = (dictation: Dictation): string =>
  beside(beside(dictation.base, dictation.spoken), dictation.hearing)

/** Adds a phrase the browser has settled. */
export const settled = (dictation: Dictation, phrase: string): Dictation => ({
  ...dictation,
  spoken: beside(dictation.spoken, phrase),
})

/** Replaces the phrase still being revised, which the next report may correct. */
export const revised = (dictation: Dictation, phrase: string): Dictation => ({
  ...dictation,
  hearing: phrase,
})

/** The phrase still being revised counts as spoken once the microphone closes. */
export const closed = (dictation: Dictation): Dictation => ({
  ...dictation,
  spoken: beside(dictation.spoken, dictation.hearing),
  hearing: '',
})

export interface Heard {
  /** Phrases the browser has settled since it last reported. */
  readonly finals: ReadonlyArray<string>
  /** The phrase it is still revising, empty when it has none. */
  readonly interim: string
}

/** The words in a result event, read from the first result that changed. */
export const heardIn = (event: VoiceResultEvent): Heard => {
  const finals: string[] = []
  let interim = ''
  for (let index = event.resultIndex; index < event.results.length; index += 1) {
    const result = event.results[index]
    if (result === undefined) continue
    const phrase = result[0]?.transcript ?? ''
    if (result.isFinal) finals.push(phrase)
    else interim = phrase
  }
  return { finals, interim }
}

/** What the page does with the microphone: put words in the draft, or say why not. */
export interface VoiceHandlers {
  /** The draft the composer should hold, whenever the browser revises what it heard. */
  readonly onDraft: (draft: string) => void
  /** The draft went back to what it was before recording, and this is why. */
  readonly onFailure: (reason: string) => void
  /** Whether the microphone is open, so the button can offer stop. */
  readonly onListening: (listening: boolean) => void
}

/** A microphone the page can close; nothing here sends the draft. */
export interface Listening {
  stop(): void
  abort(): void
}

const NOTHING: Listening = { stop: () => undefined, abort: () => undefined }

/**
 * Opens the microphone and folds what it hears into the draft. The human's own
 * words stay at the front, and a failure hands back the draft untouched.
 */
export const listen = (make: VoiceFactory, base: string, handlers: VoiceHandlers): Listening => {
  let dictation = dictate(base)
  let failure: string | undefined
  let ended = false
  let open = false
  let recognition: VoiceRecognition
  try {
    recognition = make()
  } catch {
    handlers.onFailure(OPEN_FAILURE)
    return NOTHING
  }
  const show = (next: Dictation): void => {
    dictation = next
    handlers.onDraft(draftOf(next))
  }
  const shut = (): void => {
    if (!open) return
    open = false
    handlers.onListening(false)
  }
  const fail = (error: string): void => {
    if (error === 'aborted') return
    failure = failureReason(error)
    show(dictate(base))
    handlers.onFailure(failure)
    shut()
  }
  recognition.continuous = true
  recognition.interimResults = true
  recognition.onresult = (event) => {
    if (failure !== undefined) return
    const heard = heardIn(event)
    for (const phrase of heard.finals) dictation = settled(dictation, phrase)
    show(revised(dictation, heard.interim))
  }
  recognition.onerror = (event) => fail(event.error)
  recognition.onend = () => {
    ended = true
    shut()
    if (failure !== undefined) return
    show(closed(dictation))
  }
  try {
    recognition.start()
  } catch {
    handlers.onFailure(OPEN_FAILURE)
    return NOTHING
  }
  open = true
  handlers.onListening(true)
  return {
    stop: () => {
      if (ended) return
      show(closed(dictation))
      recognition.stop()
    },
    abort: () => {
      if (ended) return
      ended = true
      recognition.abort()
      shut()
    },
  }
}
