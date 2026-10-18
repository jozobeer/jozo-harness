import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { Agent } from '@jozo-harness/agent'
import { makeHooks } from '@jozo-harness/kernel'
import {
  makeCommands,
  type Session,
  type SessionEvent,
  type SessionEventMap,
} from '@jozo-harness/session'
import { Effect, Fiber, Stream, type Scope } from 'effect'
import { makeUiHost } from '../src/index.ts'
import type { UiHost } from '@jozo-harness/ui-protocol'

interface FakeInput {
  readonly session: Session
  readonly agent: Agent
  readonly hooks: ReturnType<typeof makeHooks>
  readonly otherSession: Session
  readonly otherAgent: Agent
  readonly submitted: Array<string>
  readonly cancelled: Array<string>
  /** Every effort a command switched this session to. */
  readonly efforts: Array<string>
  /** Every route a command switched this session to. */
  readonly routes: Array<string>
  append<K extends keyof SessionEventMap>(type: K, data: SessionEventMap[K]): Effect.Effect<void>
}

const makeInput = (): FakeInput => {
  const hooks = makeHooks()
  const submitted: Array<string> = []
  const cancelled: Array<string> = []
  const efforts: Array<string> = []
  const routes: Array<string> = []
  const events: Array<SessionEvent> = []
  const holder: { session?: Session } = {}
  const session = {
    id: 'session-main',
    header: { formatVersion: 1, createdAt: 0, cwd: '/work' },
    events: () => [...events],
    append: (type: string, data: unknown) =>
      Effect.gen(function* () {
        const event = {
          seq: events.length + 1,
          time: 1_700_000_000_000 + events.length,
          type,
          data,
        } as SessionEvent
        events.push(event)
        yield* hooks.emit('session/event', event, holder.session as Session)
      }),
    flush: () => Effect.void,
    derive: () => [],
  } as unknown as Session
  holder.session = session
  const otherEvents: Array<SessionEvent> = []
  const otherHolder: { session?: Session } = {}
  const otherSession = {
    id: 'session-child',
    header: { formatVersion: 1, createdAt: 0, cwd: '/work' },
    events: () => [...otherEvents],
    append: () => Effect.void,
    flush: () => Effect.void,
    derive: () => [],
  } as unknown as Session
  otherHolder.session = otherSession
  const agent = {
    session,
    followup: (message: { text: string }) =>
      Effect.sync(() => {
        submitted.push(message.text)
      }),
    cancel: (cause: string) =>
      Effect.sync(() => {
        cancelled.push(cause)
      }),
    setEffort: (effort: string) =>
      Effect.sync(() => {
        efforts.push(effort)
      }),
    setRoute: (route: string) =>
      Effect.sync(() => {
        routes.push(route)
      }),
  } as unknown as Agent
  const otherAgent = { session: otherSession } as unknown as Agent
  return {
    session,
    agent,
    hooks,
    otherSession,
    otherAgent,
    submitted,
    cancelled,
    efforts,
    routes,
    append: (type, data) => session.append(type, data) as Effect.Effect<void>,
  }
}

const withHost = <A, E>(
  input: FakeInput,
  run: (host: UiHost) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const host = yield* makeUiHost({
          session: input.session,
          agent: input.agent,
          hooks: input.hooks,
        })
        return yield* run(host)
      }),
    ),
  )

/** A host with commands registered, which the fake input does not build itself. */
const withCommands = <A, E>(
  input: FakeInput,
  run: (host: UiHost) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const commands = makeCommands()
        yield* commands.register({
          name: 'echo',
          summary: 'says what it is told',
          run: (text) => Effect.succeed({ ok: true, text: 'echo: ' + text }),
        })
        const host = yield* makeUiHost({
          session: input.session,
          agent: input.agent,
          hooks: input.hooks,
          commands,
        })
        return yield* run(host)
      }),
    ),
  )

/** One skill root holding a single SKILL.md, so a slash can name it. */
const skillRoot = async (name: string, body = 'the steps'): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'jozo-harness-host-skill-'))
  await mkdir(join(root, name), { recursive: true })
  await writeFile(
    join(root, name, 'SKILL.md'),
    '---\nname: ' + name + '\ndescription: ' + name + ' does things\n---\n\n' + body + '\n',
  )
  return root
}

/**
 * A host whose catalog holds the given roots and whose registry holds 'echo'. The
 * skill 'review' is in the catalog only, so 'echo' is the one name both sides claim.
 */
const withSkills = <A, E>(
  input: FakeInput,
  roots: ReadonlyArray<string>,
  run: (host: UiHost) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const commands = makeCommands()
        yield* commands.register({
          name: 'echo',
          summary: 'says what it is told',
          run: (text) => Effect.succeed({ ok: true, text: 'echo: ' + text }),
        })
        const host = yield* makeUiHost({
          session: input.session,
          agent: input.agent,
          hooks: input.hooks,
          commands,
          skills: roots,
        })
        return yield* run(host)
      }),
    ),
  )

describe('ui host', () => {
  test('a slash naming a skill loads it and sends its arguments as the turn', async () => {
    const input = makeInput()
    const root = await skillRoot('review', '# review\ncheck the diff')
    try {
      await withSkills(input, [root], (host) =>
        Effect.gen(function* () {
          yield* host.submit('/review the last commit')

          const calls = input.session
            .events()
            .filter((event) => event.type === 'tool/call')
            .map((event) => event.data as { name?: string; arguments?: string; summary?: string })
          // The summary is the source a skill card shows, not just its name.
          expect(calls).toEqual([
            {
              name: 'skill',
              arguments: '{"name":"review"}',
              summary: join(root, 'review', 'SKILL.md'),
              callId: expect.any(String),
            },
          ])

          const results = input.session
            .events()
            .filter((event) => event.type === 'tool/result')
            .map((event) => event.data as { isError?: boolean; content?: unknown })
          expect(results).toHaveLength(1)
          expect(results[0]?.isError).toBe(false)
          expect(JSON.stringify(results[0]?.content)).toContain('check the diff')

          // The arguments, not the slash line, are the human's turn.
          expect(input.submitted).toEqual(['the last commit'])
          // The card is the log's record, not a command answer.
          expect(input.session.events().some((event) => event.type === 'command/done')).toBe(false)
        }),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a registered command wins the name a skill also holds', async () => {
    const input = makeInput()
    const root = await skillRoot('echo', 'skill body that must not load')
    try {
      await withSkills(input, [root], (host) =>
        Effect.gen(function* () {
          yield* host.submit('/echo hi')

          expect(input.submitted).toEqual([])
          expect(input.session.events().some((event) => event.type === 'tool/call')).toBe(false)
          const answered = input.session
            .events()
            .filter((event) => event.type === 'command/done')
            .map((event) => event.data as { text?: string })
          expect(answered.map((one) => one.text)).toEqual(['echo: hi'])
        }),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a command is answered without waking the model', async () => {
    const input = makeInput()
    await withCommands(input, (host) =>
      Effect.gen(function* () {
        yield* host.submit('/echo hi')
        expect(input.submitted).toEqual([])
        expect(input.session.events().map((event) => event.type)).toEqual([
          'command/run',
          'command/done',
        ])
        // A line that is no command still becomes the model's next turn.
        yield* host.submit('do it')
        expect(input.submitted).toEqual(['do it'])
      }),
    )
  })

  test('an unknown command is answered through the log, not the model', async () => {
    const input = makeInput()
    await withCommands(input, (host) =>
      Effect.gen(function* () {
        yield* host.submit('/nope')
        expect(input.submitted).toEqual([])
        const events = input.session.events().filter((event) => event.type === 'command/done')
        expect(events).toHaveLength(1)
        const answer = (events[0]?.data ?? {}) as { name?: string; ok?: boolean; text?: string }
        expect(answer).toMatchObject({ name: 'nope', ok: false })
        expect(answer.text).toContain('unknown command: nope')
        expect(answer.text).toContain('/echo')
      }),
    )
  })

  test('a subscriber receives the log as history in order', async () => {
    const input = makeInput()
    await withHost(input, (host) =>
      Effect.gen(function* () {
        yield* input.append('user/message', { text: 'first', source: 'user' })
        yield* input.append('user/message', { text: 'second', source: 'user' })
        const collected = yield* host.events.pipe(Stream.take(2), Stream.runCollect)
        expect([...collected].map((event) => event.kind)).toEqual(['session', 'session'])
        expect(
          [...collected].flatMap((event) =>
            event.kind === 'session' && event.event.type === 'user/message'
              ? [(event.event.data as { text: string }).text]
              : [],
          ),
        ).toEqual(['first', 'second'])
      }),
    )
  })

  test('an approval waits for the command and the command answers it', async () => {
    const input = makeInput()
    await withHost(input, (host) =>
      Effect.gen(function* () {
        yield* input.append('safety/approval/requested', {
          callId: 'c1',
          tool: 'bash',
          reason: 'outside the preset',
        })
        const waiting = yield* Effect.forkScoped(
          host.answerApproval({ callId: 'c1', tool: 'bash', reason: 'outside the preset' }),
        )
        yield* host.approve('c1', true)
        expect(yield* Fiber.join(waiting)).toBe(true)
      }),
    )
  })

  test('a missing approval is denied instead of hanging', async () => {
    const input = makeInput()
    await withHost(input, (host) =>
      Effect.gen(function* () {
        expect(yield* host.answerApproval({ callId: 'gone', tool: 'bash', reason: '' })).toBe(false)
      }),
    )
  })

  test('a question waits for the answer command', async () => {
    const input = makeInput()
    await withHost(input, (host) =>
      Effect.gen(function* () {
        yield* input.append('interaction/ask/requested', {
          id: 'a1',
          question: 'which one?',
          options: [],
        })
        const waiting = yield* Effect.forkScoped(
          host.answerAsk({ id: 'a1', question: 'which one?', options: [] }),
        )
        yield* host.answer('a1', 'the second')
        expect(yield* Fiber.join(waiting)).toBe('the second')
      }),
    )
  })

  test('a question that outlived the run that asked it still takes the answer', async () => {
    const input = makeInput()
    // The question is in the log this run resumed from, so no hook of this run
    // registered a waiter for it: a page that reopened the session draws the
    // question again, and the answer has nowhere to go unless it is carried.
    await Effect.runPromise(
      input.append('interaction/ask/requested', {
        id: 'q1',
        question: 'which colour?',
        options: ['blue', 'red'],
      }),
    )
    await withHost(input, (host) =>
      Effect.gen(function* () {
        // The reader's word is still input for the session, so it becomes the next
        // message rather than nothing, and the log says the question was answered.
        yield* host.answer('q1', 'blue')
        expect(input.submitted).toEqual(['blue'])
        expect(input.session.events().map((event) => event.type)).toEqual([
          'interaction/ask/requested',
          'interaction/ask/answered',
        ])
      }),
    )
  })

  test('submit and cancel reach the agent', async () => {
    const input = makeInput()
    await withHost(input, (host) =>
      Effect.gen(function* () {
        yield* host.submit('do it')
        yield* host.cancel()
        expect(input.submitted).toEqual(['do it'])
        expect(input.cancelled).toEqual(['user'])
      }),
    )
  })

  test('events from another session or agent never reach the UI', async () => {
    const input = makeInput()
    await withHost(input, (host) =>
      Effect.gen(function* () {
        yield* input.hooks.emit(
          'session/event',
          {
            seq: 1,
            time: 0,
            type: 'user/message',
            data: { text: 'child work', source: 'user' },
          } as SessionEvent,
          input.otherSession,
        )
        yield* input.hooks.emit(
          'agent/assistant-stream',
          {
            time: 0,
            chunk: { type: 'text-delta', index: 0, text: 'child text' },
          },
          input.otherAgent,
        )
        yield* input.append('user/message', { text: 'main work', source: 'user' })
        const collected = yield* host.events.pipe(Stream.take(1), Stream.runCollect)
        expect([...collected]).toHaveLength(1)
        expect(
          [...collected].flatMap((event) =>
            event.kind === 'session' && event.event.type === 'user/message'
              ? [(event.event.data as { text: string }).text]
              : [],
          ),
        ).toEqual(['main work'])
      }),
    )
  })

  test('a live event reaches a subscriber that already read history', async () => {
    const input = makeInput()
    await withHost(input, (host) =>
      Effect.gen(function* () {
        yield* input.append('user/message', { text: 'before', source: 'user' })
        const first = yield* Effect.forkScoped(host.events.pipe(Stream.take(2), Stream.runCollect))
        yield* Effect.sleep(10)
        yield* input.append('user/message', { text: 'live', source: 'user' })
        yield* Effect.sleep(10)
        const collected = yield* Fiber.join(first)
        expect([...collected].map((event) => event.kind)).toEqual(['session', 'session'])
      }),
    )
  })

  test('the effort a UI asks for is switched on the agent behind it', async () => {
    const input = makeInput()
    await withHost(input, (host) =>
      Effect.gen(function* () {
        yield* host.setEffort('high')
        // The empty effort is the UI's way of letting the provider choose again.
        yield* host.setEffort('')
      }),
    )

    expect(input.efforts).toEqual(['high', ''])
  })

  test('the model a UI picks is switched on the agent behind it', async () => {
    const input = makeInput()
    await withHost(input, (host) =>
      Effect.gen(function* () {
        yield* host.setModel('stub/other')
      }),
    )

    expect(input.routes).toEqual(['stub/other'])
  })
})
