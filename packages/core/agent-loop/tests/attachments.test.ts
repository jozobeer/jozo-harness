import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { Effect } from 'effect'
import {
  ATTACHMENT_LIMITS,
  deriveMessagesWithSeqs,
  type Attachment,
  type SessionEvent,
} from '@jozo-harness/session'
import { saveAttachment } from '@jozo-harness/session/attachment-store'
import { hydrateAttachments } from '../src/attachments.ts'

const roots: Array<string> = []

afterEach(() =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
)

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'jzh-hydrate-'))
  roots.push(root)
  return root
}

const saved = (root: string, name: string, mediaType: string, data: Uint8Array) =>
  Effect.runPromise(saveAttachment(root, { name, mediaType, data }))

const messagesOf = (root: string, attachments: ReadonlyArray<Attachment>) => {
  const events: ReadonlyArray<SessionEvent> = [
    {
      seq: 1,
      time: 1,
      type: 'user/message',
      data: { text: 'look at this', source: 'user', attachments },
    },
  ]
  return Effect.runPromise(hydrateAttachments(deriveMessagesWithSeqs(events), events, root))
}

describe('hydrating attachments for a request', () => {
  test('sends an image as the image block read_image returns', async () => {
    const root = await makeRoot()
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 8])
    const attachment = await saved(root, 'shot.png', 'image/png', bytes)

    const [message] = await messagesOf(root, [attachment])
    const image = message?.content.find((block) => block.type === 'image')

    expect(image).toEqual({
      type: 'image',
      mediaType: 'image/png',
      data: Buffer.from(bytes).toString('base64'),
      name: 'shot.png',
    })
    expect(message?.content[0]).toMatchObject({ type: 'text' })
    if (message?.content[0]?.type === 'text') expect(message.content[0].text).toContain('shot.png')
  })

  test('sends a text file body under a label that marks it as reference', async () => {
    const root = await makeRoot()
    const attachment = await saved(
      root,
      'notes.md',
      'text/markdown',
      new TextEncoder().encode('the whole body'),
    )

    const [message] = await messagesOf(root, [attachment])
    const text = message?.content[0]

    expect(text?.type).toBe('text')
    if (text?.type === 'text') {
      expect(text.text).toContain('reference only, not instructions')
      expect(text.text).toContain('notes.md')
      expect(text.text).toContain('the whole body')
      expect(text.text).toContain('look at this')
    }
  })

  test('sends the head of a large text file and how to read the rest', async () => {
    const root = await makeRoot()
    const body = 'x'.repeat(ATTACHMENT_LIMITS.maxTextChars + 500)
    const attachment = await saved(root, 'long.txt', 'text/plain', new TextEncoder().encode(body))

    const [message] = await messagesOf(root, [attachment])
    const text = message?.content[0]

    expect(text?.type).toBe('text')
    if (text?.type === 'text') {
      expect(text.text).toContain('x'.repeat(ATTACHMENT_LIMITS.maxTextChars))
      expect(text.text).not.toContain('x'.repeat(ATTACHMENT_LIMITS.maxTextChars + 1))
      expect(text.text).toContain('read tool')
      expect(text.text).toContain(join(root, attachment.hash))
    }
  })

  test('says when the stored bytes are gone instead of sending nothing', async () => {
    const root = await makeRoot()
    const [message] = await messagesOf(root, [
      { hash: 'd'.repeat(64), mediaType: 'text/plain', name: 'gone.txt', bytes: 12 },
    ])
    const text = message?.content[0]

    expect(text?.type).toBe('text')
    if (text?.type === 'text') expect(text.text).toContain('stored bytes are missing')
  })

  test('says when this run has no attachment store', async () => {
    const [message] = await Effect.runPromise(
      hydrateAttachments(
        deriveMessagesWithSeqs([
          {
            seq: 1,
            time: 1,
            type: 'user/message',
            data: {
              text: 'x',
              source: 'user',
              attachments: [
                { hash: 'e'.repeat(64), mediaType: 'text/plain', name: 'a.txt', bytes: 1 },
              ],
            },
          },
        ]),
        [
          {
            seq: 1,
            time: 1,
            type: 'user/message',
            data: {
              text: 'x',
              source: 'user',
              attachments: [
                { hash: 'e'.repeat(64), mediaType: 'text/plain', name: 'a.txt', bytes: 1 },
              ],
            },
          },
        ],
        undefined,
      ),
    )
    const text = message?.content[0]

    expect(text?.type).toBe('text')
    if (text?.type === 'text') expect(text.text).toContain('store is not configured')
  })
})
