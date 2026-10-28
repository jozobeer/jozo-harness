import { describe, expect, test } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Effect } from 'effect'
import { answerSessionExport, codeExchange, type SessionExportGate } from '../src/server/index.ts'

interface RouteAnswer {
  readonly status: number
  readonly body: string
}

const gateOf = (root: string | undefined): SessionExportGate => ({
  root,
  events: () => Effect.succeed([]),
  port: 1,
  publicOrigin: undefined,
  tailnet: undefined,
  token: 'secret',
  codes: codeExchange(() => 0),
})

const requestOf = (path: string): IncomingMessage =>
  ({
    method: 'GET',
    url: path,
    headers: { cookie: 'jzh_web=secret' },
  }) as unknown as IncomingMessage

/** Answers one export, keeping the status and body the route wrote. */
const answerAt = async (
  root: string | undefined,
  path: string,
): Promise<RouteAnswer & { readonly handled: boolean }> => {
  const answer = { status: 0, body: '' }
  const response = {
    writeHead: (status: number) => {
      answer.status = status
    },
    end: (body?: string | Buffer) => {
      answer.body = body === undefined ? '' : String(body)
    },
  } as unknown as ServerResponse
  const handled = await answerSessionExport(requestOf(path), response, path, gateOf(root))
  return { handled, ...answer }
}

describe('the session export route', () => {
  test('answers a log path the filesystem rejects as a session with no log', async () => {
    const answered = await answerAt(join(tmpdir(), 'jzh-export-null\0root'), '/session/a/log.zip')

    expect(answered).toEqual({ handled: true, status: 404, body: 'not found' })
  })

  test('answers a log entry that is a directory as a session with no log', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jzh-export-dir-'))
    try {
      await mkdir(join(root, 'a', 'session.v1.jsonl'), { recursive: true })

      const answered = await answerAt(root, '/session/a/log.zip')

      expect(answered).toEqual({ handled: true, status: 404, body: 'not found' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
