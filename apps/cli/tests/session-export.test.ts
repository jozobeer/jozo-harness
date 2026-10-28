import { afterEach, describe, expect, test } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import type { SessionEvent } from '@jozo-harness/session'
import { encodeZstdFrame } from '@jozo-harness/session-jsonl'
import { answerSessionExport, codeExchange } from '@jozo-harness/web'
import { Effect } from 'effect'
import { main } from '../src/bin.ts'

const TOKEN = 'session-export-test-token'

/** One file as the test reads it back out of the archive. */
interface Unzipped {
  readonly name: string
  readonly data: Buffer
}

/**
 * Reads one local entry back. The route writes with deflate, so the test inflates
 * the body rather than trusting the bytes it did not store.
 */
const unzip = (zip: Buffer): Unzipped => {
  const method = zip.readUInt16LE(8)
  const compressedSize = zip.readUInt32LE(18)
  const nameLength = zip.readUInt16LE(26)
  const extraLength = zip.readUInt16LE(28)
  const name = zip.subarray(30, 30 + nameLength).toString('utf8')
  const start = 30 + nameLength + extraLength
  const body = zip.subarray(start, start + compressedSize)
  return { name, data: method === 8 ? inflateRawSync(body) : Buffer.from(body) }
}

const header = (seq: number): SessionEvent => ({
  seq,
  time: 1_700_000_000_000 + seq,
  type: 'session/header',
  data: { formatVersion: 1, createdAt: 1_700_000_000_000, cwd: '/work' },
})

/** The events a transcript folds: the human's words, a tool call, and its output. */
const transcriptEvents = (): ReadonlyArray<SessionEvent> => [
  header(1),
  { seq: 2, time: 1, type: 'user/message', data: { text: 'count the files', source: 'user' } },
  {
    seq: 3,
    time: 2,
    type: 'assistant/message',
    data: {
      provider: 'stub',
      model: 'stub/model',
      stream: [],
      content: [
        { type: 'text', text: 'let me look' },
        { type: 'tool-call', id: 'c1', name: 'glob', arguments: '{"pattern":"*"}' },
      ],
    },
  },
  {
    seq: 4,
    time: 3,
    type: 'tool/result',
    data: { callId: 'c1', isError: false, content: [{ type: 'text', text: 'a.txt' }] },
  },
]

const live: Array<{ readonly server: Server; readonly close: () => Promise<void> }> = []

afterEach(async () => {
  for (const entry of live.splice(0)) {
    await entry.close()
  }
})

/** Serves the export route on a free loopback port, as the page reaches it. */
const serveExports = async (
  root: string | undefined,
  events: (id: string) => Effect.Effect<ReadonlyArray<SessionEvent>, never>,
): Promise<string> => {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    void answerSessionExport(request, response, path, {
      root,
      events,
      port: 0,
      publicOrigin: undefined,
      tailnet: undefined,
      token: TOKEN,
      codes: codeExchange(() => Date.now()),
    }).then((answered) => {
      if (answered) return
      response.writeHead(404)
      response.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('the server bound no port')
  const port = (address as AddressInfo).port
  live.push({
    server,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
      }),
  })
  return 'http://127.0.0.1:' + String(port)
}

describe('a session leaves through the page', () => {
  test('a ZIP names the log under the session id, and jzh reads it once extracted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jzh-export-'))
    const id = 'export-me'
    await mkdir(join(root, id), { recursive: true })
    const log = Buffer.concat(
      transcriptEvents().map((event) => encodeZstdFrame(JSON.stringify(event) + '\n')),
    )
    await writeFile(join(root, id, 'session.v1.jsonl.zst'), log)

    const origin = await serveExports(root, () => Effect.succeed([]))
    const answer = await fetch(origin + '/session/' + id + '/log.zip?token=' + TOKEN)
    expect(answer.status).toBe(200)
    expect(answer.headers.get('content-type')).toBe('application/zip')
    expect(answer.headers.get('content-disposition')).toBe('attachment; filename="' + id + '.zip"')

    const entry = unzip(Buffer.from(await answer.arrayBuffer()))
    expect(entry.name).toBe(id + '/session.v1.jsonl.zst')
    expect(entry.data.equals(log)).toBe(true)

    // Unpack the way a reader would and read it with this build's own command.
    const extracted = await mkdtemp(join(tmpdir(), 'jzh-export-read-'))
    await mkdir(join(extracted, id), { recursive: true })
    await writeFile(join(extracted, id, 'session.v1.jsonl.zst'), entry.data)
    const patch = join(extracted, 'profile.yml')
    await writeFile(
      patch,
      [
        'name: export-read',
        'plugins:',
        '  - id: session-jsonl',
        "    name: '@jozo-harness/session-jsonl'",
        '    config:',
        '      root: ' + extracted,
      ].join('\n'),
    )
    const out: Array<string> = []
    const err: Array<string> = []
    const code = await Effect.runPromise(
      main(['sessions', id, '--patch', patch, '--config', join(extracted, 'config.yml')], {
        stdout: (text) => out.push(text),
        stderr: (text) => err.push(text),
        cwd: extracted,
      }),
    )
    expect(code, err.join('')).toBe(0)
    expect(out.join('')).toContain('[user] count the files')
    expect(out.join('')).toContain('[tool result] a.txt')
    await rm(root, { recursive: true, force: true })
    await rm(extracted, { recursive: true, force: true })
  })

  test('a transcript marks the human words and the tool output apart', async () => {
    const events = transcriptEvents()
    const origin = await serveExports('/nowhere', () => Effect.succeed(events))
    const answer = await fetch(origin + '/session/s-1/transcript.md?token=' + TOKEN)
    expect(answer.status).toBe(200)
    expect(answer.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    const text = await answer.text()

    expect(text).toContain('# Session s-1')
    expect(text).toContain('## User\n\ncount the files')
    expect(text).toContain('## Assistant\n\nlet me look')
    expect(text).toContain('### Tool call `glob`')
    expect(text).toContain('## Tool result')
    expect(text).toContain('a.txt')
    // A tool result is its own section, never folded into what the human said.
    expect(text.indexOf('## Tool result')).toBeGreaterThan(text.indexOf('## User'))
  })

  test('a missing log or an anonymous request is refused before anything is read', async () => {
    const origin = await serveExports(undefined, () => Effect.succeed([]))
    const missing = await fetch(origin + '/session/s-1/log.zip?token=' + TOKEN)
    expect(missing.status).toBe(404)
    const anonymous = await fetch(origin + '/session/s-1/transcript.md')
    expect(anonymous.status).toBe(401)
    const traversal = await fetch(origin + '/session/..%2fsecret/log.zip?token=' + TOKEN)
    expect(traversal.status).toBe(400)
  })
})
