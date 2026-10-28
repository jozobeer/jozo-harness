import { mkdir, mkdtemp, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect } from 'effect'
import { afterAll, describe, expect, test } from 'vitest'
import type { SessionEvent } from '@jozo-harness/session'
import {
  anonymousUserIdentity,
  createTelemetryExporter,
  otlpLogsPayload,
  RECORD_BODY_LIMIT,
  resolveTelemetry,
  scopeSelects,
  type TelemetryFailure,
} from '../src/index.ts'

const root = await mkdtemp(join(tmpdir(), 'jzh-telemetry-'))

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const header: SessionEvent = {
  seq: 1,
  time: 1000,
  type: 'session/header',
  data: { formatVersion: 1, createdAt: 1000, cwd: '/work' },
}

const feedback = (seq: number): SessionEvent => ({
  seq,
  time: 2000 + seq,
  type: 'feedback/rated',
  data: { target: 1, rating: 'like', memo: 'clear' },
})

const userMessage: SessionEvent = {
  seq: 3,
  time: 3000,
  type: 'user/message',
  data: { text: 'hello', source: 'user' },
}

interface Captured {
  readonly url: string
  readonly body: string
}

interface LogsBody {
  readonly resourceLogs: ReadonlyArray<{
    readonly resource: {
      readonly attributes: ReadonlyArray<{
        readonly key: string
        readonly value: { readonly stringValue?: string; readonly intValue?: string }
      }>
    }
    readonly scopeLogs: ReadonlyArray<{
      readonly logRecords: ReadonlyArray<{
        readonly body: { readonly stringValue: string }
        readonly attributes: ReadonlyArray<{
          readonly key: string
          readonly value: { readonly stringValue?: string; readonly intValue?: string }
        }>
      }>
    }>
  }>
}

const parseLogs = (body: string): LogsBody => JSON.parse(body) as LogsBody

const recordsOf = (body: string) => {
  const parsed = parseLogs(body)
  return parsed.resourceLogs.flatMap((resource) =>
    resource.scopeLogs.flatMap((scope) => scope.logRecords),
  )
}

const attributeOf = (body: string, key: string): string | undefined => {
  const resource = parseLogs(body).resourceLogs[0]?.resource.attributes ?? []
  return resource.find((attribute) => attribute.key === key)?.value.stringValue
}

const captureFetch = (status = 200) => {
  const requests: Captured[] = []
  const fetch = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const body = typeof init?.body === 'string' ? init.body : ''
    requests.push({ url, body })
    return new Response('{}', { status })
  }
  return { fetch, requests }
}

describe('telemetry defaults', () => {
  test('resolves an unset endpoint and scope to sending nothing', () => {
    const resolved = resolveTelemetry({})
    expect(resolved.endpoint).toBe('')
    expect(resolved.scope).toBe('off')
    expect(resolved.headers).toEqual({})
    expect(resolved.identityPath.endsWith(join('.jzh', 'anonymous-user-id'))).toBe(true)
  })

  test('does not post when the scope is off', async () => {
    const captured = captureFetch()
    const exporter = createTelemetryExporter({
      endpoint: 'http://collector.invalid',
      scope: 'off',
      identity: () => Effect.succeed('anon'),
      fetch: captured.fetch,
    })
    exporter.enqueue('s-1', feedback(2))
    await Effect.runPromise(exporter.flush())
    expect(exporter.pending()).toBe(0)
    expect(captured.requests).toHaveLength(0)
  })

  test('only feedback events pass a feedback scope', () => {
    expect(scopeSelects('off', feedback(2))).toBe(false)
    expect(scopeSelects('feedback', feedback(2))).toBe(true)
    expect(scopeSelects('feedback', header)).toBe(false)
    expect(scopeSelects('feedback', userMessage)).toBe(false)
    expect(scopeSelects('all', userMessage)).toBe(true)
  })
})

describe('sending a batch', () => {
  test('posts the explicit endpoint in bounded batches', async () => {
    const captured = captureFetch()
    const exporter = createTelemetryExporter({
      endpoint: 'http://collector.invalid',
      scope: 'all',
      identity: () => Effect.succeed('anon'),
      fetch: captured.fetch,
      maxBatchEvents: 20,
    })
    for (let seq = 2; seq <= 46; seq += 1) exporter.enqueue('s-1', feedback(seq))

    await Effect.runPromise(exporter.flush())

    expect(captured.requests.map((request) => request.url)).toEqual([
      'http://collector.invalid/v1/logs',
      'http://collector.invalid/v1/logs',
      'http://collector.invalid/v1/logs',
    ])
    expect(captured.requests.map((request) => recordsOf(request.body).length)).toEqual([20, 20, 5])
  })

  test('reads the identity for each batch so a deleted file starts a new id', async () => {
    const captured = captureFetch()
    const ids = ['first-id', 'second-id']
    let index = 0
    const exporter = createTelemetryExporter({
      endpoint: 'http://collector.invalid',
      scope: 'feedback',
      identity: () => Effect.succeed(ids[index++] ?? 'exhausted'),
      fetch: captured.fetch,
      maxBatchEvents: 1,
    })
    exporter.enqueue('s-1', feedback(2))
    exporter.enqueue('s-1', feedback(3))

    await Effect.runPromise(exporter.flush())

    expect(
      captured.requests.map((request) => attributeOf(request.body, 'anonymous.user.id')),
    ).toEqual(['first-id', 'second-id'])
  })

  test('keeps the anonymous id on the resource and out of each record body', () => {
    const body = JSON.stringify(
      otlpLogsPayload({
        anonymousId: 'anon-1234',
        observedAt: 5000,
        records: [{ sessionId: 's-1', event: feedback(2) }],
      }),
    )
    const record = recordsOf(body)[0]
    expect(attributeOf(body, 'anonymous.user.id')).toBe('anon-1234')
    expect(attributeOf(body, 'service.name')).toBe('jozo-harness')
    expect(record?.body.stringValue).not.toContain('anon-1234')
    expect(JSON.stringify(record?.attributes)).not.toContain('anon-1234')
  })

  test('reports a failed delivery without failing the flush', async () => {
    const failures: TelemetryFailure[] = []
    const exporter = createTelemetryExporter({
      endpoint: 'http://collector.invalid',
      scope: 'feedback',
      identity: () => Effect.succeed('anon'),
      fetch: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:1')
      },
      report: (failure) => Effect.sync(() => failures.push(failure)),
    })
    exporter.enqueue('s-1', feedback(2))

    await Effect.runPromise(exporter.flush())

    expect(failures).toEqual([
      {
        endpoint: 'http://collector.invalid/v1/logs',
        recordCount: 1,
        reason: 'connect ECONNREFUSED 127.0.0.1:1',
      },
    ])
    expect(exporter.pending()).toBe(0)
  })

  test('cuts a record body that would make one batch huge', () => {
    const long: SessionEvent = {
      seq: 9,
      time: 9000,
      type: 'user/message',
      data: { text: 'x'.repeat(RECORD_BODY_LIMIT + 10), source: 'user' },
    }
    const body = JSON.stringify(
      otlpLogsPayload({
        anonymousId: 'anon',
        observedAt: 1,
        records: [{ sessionId: 's-1', event: long }],
      }),
    )

    expect(recordsOf(body)[0]?.body.stringValue.endsWith('…(truncated)')).toBe(true)
  })

  test('keeps the default report path from throwing', async () => {
    const exporter = createTelemetryExporter({
      endpoint: 'http://collector.invalid',
      scope: 'feedback',
      identity: () => Effect.succeed('anon'),
      fetch: async () => new Response('nope', { status: 500 }),
    })
    exporter.enqueue('s-1', feedback(2))

    await expect(Effect.runPromise(exporter.flush())).resolves.toBeUndefined()
  })

  test('reports a collector that answers with an error status', async () => {
    const failures: TelemetryFailure[] = []
    const captured = captureFetch(503)
    const exporter = createTelemetryExporter({
      endpoint: 'http://collector.invalid',
      scope: 'feedback',
      identity: () => Effect.succeed('anon'),
      fetch: captured.fetch,
      report: (failure) => Effect.sync(() => failures.push(failure)),
    })
    exporter.enqueue('s-1', feedback(2))

    await Effect.runPromise(exporter.flush())

    expect(failures[0]?.reason).toBe('collector answered HTTP 503')
  })

  test('drops the oldest events when the buffer is full', async () => {
    const captured = captureFetch()
    const exporter = createTelemetryExporter({
      endpoint: 'http://collector.invalid',
      scope: 'all',
      identity: () => Effect.succeed('anon'),
      fetch: captured.fetch,
      maxBatchEvents: 2,
      maxBufferedEvents: 2,
    })
    exporter.enqueue('s-1', feedback(2))
    exporter.enqueue('s-1', feedback(3))
    exporter.enqueue('s-1', feedback(4))
    expect(exporter.pending()).toBe(2)

    await Effect.runPromise(exporter.flush())

    const types = captured.requests.flatMap((request) =>
      recordsOf(request.body).map(
        (record) =>
          record.attributes.find((attribute) => attribute.key === 'session.event.seq')?.value
            .intValue,
      ),
    )
    expect(types).toEqual(['3', '4'])
  })
})

describe('anonymous identity', () => {
  test('keeps one id per home and starts a new one after the file is deleted', async () => {
    const path = join(root, 'identity', 'anonymous-user-id')
    const first = await Effect.runPromise(anonymousUserIdentity({ path, random: () => 'id-one' }))
    const second = await Effect.runPromise(anonymousUserIdentity({ path, random: () => 'id-two' }))

    expect(first.id).toBe('id-one')
    expect(second.id).toBe('id-one')
    expect((await stat(path)).mode & 0o077).toBe(0)

    await unlink(path)
    const third = await Effect.runPromise(anonymousUserIdentity({ path, random: () => 'id-two' }))
    expect(third.id).toBe('id-two')
  })

  test('rejects a blank identity file rather than sending an empty id', async () => {
    const path = join(root, 'blank', 'anonymous-user-id')
    await mkdir(join(root, 'blank'), { recursive: true })
    await writeFile(path, ' \n', { mode: 0o600 })

    const failure = await Effect.runPromise(
      anonymousUserIdentity({ path, random: () => 'unused' }).pipe(Effect.flip),
    )
    expect(failure.message).toContain('cannot keep the anonymous id')
  })
})
