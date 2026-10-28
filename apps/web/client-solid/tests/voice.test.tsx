import { describe, expect, test } from 'vitest'
import {
  INSECURE_PAGE,
  NO_RECOGNITION,
  OPEN_FAILURE,
  browserVoice,
  dictate,
  draftOf,
  closed,
  failureReason,
  heardIn,
  listen,
  revised,
  settled,
  voiceSupport,
  type VoiceRecognition,
  type VoiceResult,
  type VoiceResultEvent,
  type VoiceScope,
} from '../voice.ts'

const phrase = (text: string, isFinal: boolean): VoiceResult => ({
  isFinal,
  0: { transcript: text },
})

/** A recognizer whose microphone the test opens, hears through, and closes by hand. */
class FakeRecognition implements VoiceRecognition {
  continuous = false
  interimResults = false
  onresult: ((event: VoiceResultEvent) => void) | null = null
  onerror: ((event: { error: string }) => void) | null = null
  onend: (() => void) | null = null
  starts = 0
  stops = 0
  aborts = 0

  start(): void {
    this.starts += 1
  }

  stop(): void {
    this.stops += 1
  }

  abort(): void {
    this.aborts += 1
  }
}

/** A page that records what the microphone did to it. */
const listening = (recognition: FakeRecognition, base = '') => {
  const report: { drafts: string[]; failures: string[]; open: boolean[] } = {
    drafts: [],
    failures: [],
    open: [],
  }
  const opened: VoiceScope = { secure: true, recognition: () => recognition }
  const support = voiceSupport(opened)
  if (support.kind === 'missing') throw new Error('a fake recognizer is ready')
  const session = listen(support.open, base, {
    onDraft: (draft) => report.drafts.push(draft),
    onFailure: (reason) => report.failures.push(reason),
    onListening: (open) => report.open.push(open),
  })
  return { session, report }
}

describe('the words a microphone puts in the composer', () => {
  test('the draft the human had stays before the words the microphone heard', () => {
    const recognition = new FakeRecognition()
    const { session, report } = listening(recognition, 'explain this file')

    expect(recognition.continuous).toBe(true)
    expect(recognition.interimResults).toBe(true)
    expect(recognition.starts).toBe(1)
    expect(report.open).toEqual([true])

    recognition.onresult?.({ resultIndex: 0, results: [phrase('please', false)] })
    expect(report.drafts.at(-1)).toBe('explain this file please')

    recognition.onresult?.({
      resultIndex: 0,
      results: [phrase('please', true)],
    })
    expect(report.drafts.at(-1)).toBe('explain this file please')

    session.stop()
    expect(recognition.stops).toBe(1)
  })

  test('a phrase still being revised replaces the one before it, and settles when the microphone closes', () => {
    const recognition = new FakeRecognition()
    const { report } = listening(recognition)

    recognition.onresult?.({ resultIndex: 0, results: [phrase('open the', false)] })
    recognition.onresult?.({ resultIndex: 0, results: [phrase('open the door', false)] })
    expect(report.drafts.at(-1)).toBe('open the door')

    recognition.onend?.()
    expect(report.drafts.at(-1)).toBe('open the door')
    expect(report.open).toEqual([true, false])
  })

  test('stopping the microphone before the browser settles keeps what was heard', () => {
    const recognition = new FakeRecognition()
    const { session, report } = listening(recognition, 'note:')

    recognition.onresult?.({ resultIndex: 0, results: [phrase('half a thought', false)] })
    session.stop()

    expect(report.drafts.at(-1)).toBe('note: half a thought')
  })

  test('a refused microphone leaves the draft as it was and names the reason', () => {
    const recognition = new FakeRecognition()
    const { session, report } = listening(recognition, 'keep this')

    recognition.onresult?.({ resultIndex: 0, results: [phrase('not this', false)] })
    recognition.onerror?.({ error: 'not-allowed' })
    recognition.onend?.()

    expect(report.drafts.at(-1)).toBe('keep this')
    expect(report.failures).toEqual([failureReason('not-allowed')])
    expect(report.open).toEqual([true, false])

    // A microphone already closed takes no second stop, and no words come after the failure.
    session.stop()
    expect(recognition.stops).toBe(0)
    recognition.onresult?.({ resultIndex: 0, results: [phrase('late', true)] })
    expect(report.drafts.at(-1)).toBe('keep this')
  })

  test('a microphone that cannot open leaves the draft as it was', () => {
    const drafts: string[] = []
    const failures: string[] = []
    const nothing = listen(
      () => {
        throw new Error('no device')
      },
      'before',
      {
        onDraft: (draft) => drafts.push(draft),
        onFailure: (reason) => failures.push(reason),
        onListening: () => undefined,
      },
    )

    nothing.stop()
    expect(failures).toEqual([OPEN_FAILURE])
    expect(drafts).toEqual([])
  })

  test('a recognizer that refuses to start leaves the draft as it was', () => {
    const refusing = new FakeRecognition()
    refusing.start = () => {
      throw new Error('already started')
    }
    const { report } = listening(refusing, 'before')

    expect(report.failures).toEqual([OPEN_FAILURE])
    expect(report.drafts).toEqual([])
  })
})

describe('where speech cannot be offered', () => {
  test('a browser without the speech API says so instead of opening a microphone', () => {
    expect(voiceSupport({ secure: true })).toEqual({ kind: 'missing', reason: NO_RECOGNITION })
  })

  test('a page on plain http says it needs a secure page', () => {
    expect(voiceSupport({ secure: false })).toEqual({ kind: 'missing', reason: INSECURE_PAGE })
  })

  test('the browser tells which recognizer it has, if any', () => {
    class Constructor extends FakeRecognition {}
    const chrome = browserVoice({ isSecureContext: true, webkitSpeechRecognition: Constructor })
    expect(chrome.secure).toBe(true)
    expect(chrome.recognition).toBeTypeOf('function')

    const safari = browserVoice({ isSecureContext: true, SpeechRecognition: Constructor })
    expect(safari.recognition).toBeTypeOf('function')

    const bare = browserVoice({ isSecureContext: false })
    expect(bare.recognition).toBeUndefined()
  })

  test('a reason the page does not know still reaches the reader as a sentence', () => {
    expect(failureReason('audio-capture')).toBe('No microphone was found.')
    expect(failureReason('something-new')).toBe('Speech recognition stopped for an unknown reason.')
  })
})

describe('the dictation draft', () => {
  test('the base draft, settled phrases, and the revised phrase are joined once each', () => {
    const beginning = dictate('ask: ')
    const one = settled(beginning, 'why')
    const two = settled(one, 'not')
    const hearing = revised(two, 'now?')
    expect(draftOf(hearing)).toBe('ask: why not now?')

    const done = closed(hearing)
    expect(draftOf(done)).toBe('ask: why not now?')
    expect(done.hearing).toBe('')
  })

  test('a heard phrase that starts or ends in space does not double it', () => {
    expect(draftOf(revised(dictate(''), ' hello '))).toBe('hello')
    expect(draftOf(revised(dictate('say'), ' hello '))).toBe('say hello')
  })

  test('a result event names the finals since its index and the phrase still being revised', () => {
    const event = {
      resultIndex: 1,
      results: [phrase('old', true), phrase('new', true), phrase('next', false)],
    }
    expect(heardIn(event)).toEqual({ finals: ['new'], interim: 'next' })
    expect(heardIn({ resultIndex: 0, results: [phrase('a', true), phrase('b', true)] })).toEqual({
      finals: ['a', 'b'],
      interim: '',
    })
  })
})
