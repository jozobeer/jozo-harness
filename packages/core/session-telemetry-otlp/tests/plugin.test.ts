import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Effect, Layer } from 'effect'
import { afterAll, describe, expect, test } from 'vitest'
import { kernelPlugin, loadProfile } from '@jozo-harness/kernel'
import { Hooks } from '@jozo-harness/kernel'
import { makeSession, type SessionEvent } from '@jozo-harness/session'
import { SessionTelemetry, sessionTelemetryPlugin } from '@jozo-harness/session-telemetry-otlp'

const root = await mkdtemp(join(tmpdir(), 'jzh-telemetry-plugin-'))

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
  data: { target: 1, rating: 'like' },
})

const userMessage: SessionEvent = {
  seq: 3,
  time: 3000,
  type: 'user/message',
  data: { text: 'hello', source: 'user' },
}

interface Request {
  readonly url: string
  readonly body: string
  readonly contentType: string
}

const startCollector = async (status = 200) => {
  const requests: Request[] = []
  const server = createServer((request, response) => {
    const chunks: Array<Buffer> = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      requests.push({
        url: request.url ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
        contentType: String(request.headers['content-type'] ?? ''),
      })
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the collector has no port')
  return {
    endpoint: 'http://127.0.0.1:' + String(address.port),
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      }),
  }
}

const withTelemetry = <A, E>(
  config: Readonly<Record<string, unknown>>,
  body: (context: Context.Context<Hooks | SessionTelemetry>) => Effect.Effect<A, E>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const layer = yield* loadProfile({
        plugins: [kernelPlugin, sessionTelemetryPlugin],
        layers: [
          [
            { id: 'kernel', name: '@jozo-harness/kernel' },
            {
              id: 'telemetry',
              name: '@jozo-harness/session-telemetry-otlp',
              config,
            },
          ],
        ],
      })
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(layer)
          return yield* body(context)
        }),
      )
    }).pipe(Effect.orDie),
  )

const makeSessionWith = () =>
  makeSession({
    id: 's-1',
    events: [header],
    sink: { append: () => Effect.void, flush: () => Effect.void },
    now: () => 4000,
  })

describe('sessionTelemetry plugin', () => {
  test('sends nothing when no endpoint and no scope are configured', async () => {
    const collector = await startCollector()
    try {
      const enabled = await withTelemetry({}, (context) =>
        Effect.gen(function* () {
          const session = yield* makeSessionWith()
          const hooks = Context.get(context, Hooks)
          yield* hooks.emit('session/event', feedback(2), session)
          const telemetry = Context.get(context, SessionTelemetry)
          yield* telemetry.flush
          return telemetry.enabled
        }),
      )
      expect(enabled).toBe(false)
      expect(collector.requests).toHaveLength(0)
    } finally {
      await collector.close()
    }
  })

  test('sends nothing when an endpoint is set but the scope is not', async () => {
    const collector = await startCollector()
    try {
      const enabled = await withTelemetry({ endpoint: collector.endpoint }, (context) =>
        Effect.gen(function* () {
          const session = yield* makeSessionWith()
          const hooks = Context.get(context, Hooks)
          yield* hooks.emit('session/event', feedback(2), session)
          const telemetry = Context.get(context, SessionTelemetry)
          yield* telemetry.flush
          return telemetry.enabled
        }),
      )
      expect(enabled).toBe(false)
      expect(collector.requests).toHaveLength(0)
    } finally {
      await collector.close()
    }
  })

  test('posts only feedback events to the explicit endpoint', async () => {
    const collector = await startCollector()
    const identityPath = join(root, 'explicit', 'anonymous-user-id')
    try {
      const id = await withTelemetry(
        { endpoint: collector.endpoint, scope: 'feedback', identityPath },
        (context) =>
          Effect.gen(function* () {
            const session = yield* makeSessionWith()
            const hooks = Context.get(context, Hooks)
            yield* hooks.emit('session/event', feedback(2), session)
            yield* hooks.emit('session/event', userMessage, session)
            const telemetry = Context.get(context, SessionTelemetry)
            yield* telemetry.flush
            return { enabled: telemetry.enabled }
          }),
      )
      expect(id.enabled).toBe(true)
      expect(collector.requests).toHaveLength(1)
      expect(collector.requests[0]?.url).toBe('/v1/logs')
      expect(collector.requests[0]?.contentType).toBe('application/json')
      const body = JSON.parse(collector.requests[0]?.body ?? '{}') as {
        resourceLogs: Array<{
          resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> }
          scopeLogs: Array<{
            logRecords: Array<{
              attributes: Array<{ key: string; value: { stringValue?: string } }>
            }>
          }>
        }>
      }
      const records = body.resourceLogs.flatMap((resource) =>
        resource.scopeLogs.flatMap((scope) => scope.logRecords),
      )
      expect(records).toHaveLength(1)
      const type = records[0]?.attributes.find(
        (attribute) => attribute.key === 'session.event.type',
      )
      expect(type?.value.stringValue).toBe('feedback/rated')
      const resourceId = body.resourceLogs[0]?.resource.attributes.find(
        (attribute) => attribute.key === 'anonymous.user.id',
      )
      expect(resourceId?.value.stringValue).toMatch(/^[0-9a-f-]{36}$/)
    } finally {
      await collector.close()
    }
  })

  test('keeps the session running when the anonymous id cannot be kept', async () => {
    const collector = await startCollector()
    try {
      const result = await withTelemetry(
        {
          endpoint: collector.endpoint,
          scope: 'all',
          identityPath: '/dev/null/anonymous-user-id',
        },
        (context) =>
          Effect.gen(function* () {
            const session = yield* makeSessionWith()
            const telemetry = Context.get(context, SessionTelemetry)
            yield* session.append('feedback/rated', { target: 1, rating: 'like' })
            yield* telemetry.flush
            yield* session.append('user/message', { text: 'still here', source: 'user' })
            yield* telemetry.flush
            return {
              enabled: telemetry.enabled,
              types: session.events().map((event) => event.type),
            }
          }),
      )
      expect(result.enabled).toBe(true)
      expect(result.types).toEqual(['session/header', 'feedback/rated', 'user/message'])
      expect(collector.requests).toHaveLength(0)
    } finally {
      await collector.close()
    }
  })

  test('keeps the session running when the collector fails', async () => {
    const session = await withTelemetry(
      {
        endpoint: 'http://127.0.0.1:1',
        scope: 'all',
        identityPath: join(root, 'failing', 'anonymous-user-id'),
      },
      (context) =>
        Effect.gen(function* () {
          const created = yield* makeSessionWith()
          const telemetry = Context.get(context, SessionTelemetry)
          yield* created.append('feedback/rated', { target: 1, rating: 'like' })
          yield* telemetry.flush
          yield* created.append('user/message', { text: 'still here', source: 'user' })
          yield* telemetry.flush
          return created
        }),
    )
    expect(session.events().map((event) => event.type)).toEqual([
      'session/header',
      'feedback/rated',
      'user/message',
    ])
  })
})
