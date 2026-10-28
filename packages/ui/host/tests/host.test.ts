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
import type { UiEvent, UiHost } from '@jozo-harness/ui-protocol'

interface FakeInput {
  readonly session: Session
  readonly agent: Agent
  readonly hooks: ReturnType<typeof makeHooks>
  readonly otherSession: Session
  readonly otherAgent: Agent
  readonly submitted: Array<string>
  /** Every line the host put on the running turn's step queue. */
  readonly steered: Array<string>
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
  const steered: Array<string> = []
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
    steer: (message: { text: string }) =>
      Effect.sync(() => {
        steered.push(message.text)
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
    steered,
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

  test('a slash reads a skill the model catalog hides', async () => {
    const input = makeInput()
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-host-skill-'))
    try {
      await mkdir(join(root, 'by-hand'), { recursive: true })
      await writeFile(
        join(root, 'by-hand', 'SKILL.md'),
        '---\nname: by-hand\ndescription: Only a human runs this\nmodelInvocable: false\n---\n\nrun it by hand\n',
      )

      await withSkills(input, [root], (host) =>
        Effect.gen(function* () {
          yield* host.submit('/by-hand')

          const result = input.session.events().find((event) => event.type === 'tool/result')
          expect(result?.type === 'tool/result' ? result.data.isError : true).toBe(false)
          expect(
            JSON.stringify(result?.type === 'tool/result' ? result.data.content : ''),
          ).toContain('run it by hand')
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

  test('a steer joins the running turn, while a plain submit waits for the next one', async () => {
    const input = makeInput()
    await withHost(input, (host) =>
      Effect.gen(function* () {
        yield* host.submit('join now', 'steer')
        yield* host.submit('after this')
        expect(input.steered).toEqual(['join now'])
        expect(input.submitted).toEqual(['after this'])
      }),
    )
  })

  test('a command still answers at once when the line asks to steer', async () => {
    const input = makeInput()
    await withCommands(input, (host) =>
      Effect.gen(function* () {
        yield* host.submit('/echo hi', 'steer')
        expect(input.steered).toEqual([])
        expect(input.submitted).toEqual([])
        expect(
          input.session.events().filter((event) => event.type === 'command/done'),
        ).toHaveLength(1)
      }),
    )
  })

  test('a forced skill sends its arguments to the mode the line asked for', async () => {
    const input = makeInput()
    const root = await skillRoot('review', '# review\ncheck the diff')
    try {
      await withSkills(input, [root], (host) =>
        Effect.gen(function* () {
          yield* host.submit('/review the last commit', 'steer')
          expect(input.steered).toEqual(['the last commit'])
          expect(input.submitted).toEqual([])
        }),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
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

  test('an event logged while history is read still reaches the subscriber', async () => {
    const input = makeInput()
    await withHost(input, (host) =>
      Effect.gen(function* () {
        yield* input.append('user/message', { text: 'before', source: 'user' })
        // The snapshot is taken while the subscription is already live. An event
        // published from that read used to miss the subscriber, because it was
        // added only after every historical line had been queued.
        let replayed = false
        const stored = input.session.events.bind(input.session)
        input.session.events = () => {
          const snapshot = stored()
          if (!replayed) {
            replayed = true
            const event = {
              seq: snapshot.length + 1,
              time: 1,
              type: 'user/message',
              data: { text: 'during', source: 'user' },
            } as SessionEvent
            Effect.runSync(input.hooks.emit('session/event', event, input.session))
          }
          return snapshot
        }
        const collected = yield* host.events.pipe(Stream.take(2), Stream.runCollect)
        expect(
          [...collected].flatMap((event) =>
            event.kind === 'session' && event.event.type === 'user/message'
              ? [(event.event.data as { text: string }).text]
              : [],
          ),
        ).toEqual(['before', 'during'])
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

  test('a log that died inside a turn is closed when the host opens it', async () => {
    const input = makeInput()
    // The run that asked for approval was killed before it could write the
    // answer or close its turn. Without a repair, every page that opens this
    // log draws the approval card and the running marker again.
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* input.append('turn/start', { turn: 1 })
        yield* input.append('step/start', { step: 1 })
        yield* input.append('assistant/message', {
          provider: 'fake',
          model: 'model',
          content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }],
          stream: [],
        })
        yield* input.append('tool/call', { callId: 'c1', name: 'bash', arguments: '{}' })
        yield* input.append('safety/approval/requested', {
          callId: 'c1',
          tool: 'bash',
          reason: 'outside the preset',
        })
      }),
    )
    await withHost(input, () =>
      Effect.gen(function* () {
        yield* Effect.void
        const events = input.session.events()
        const result = events.find((event) => event.type === 'tool/result')
        expect(result?.type === 'tool/result' ? result.data.isError : false).toBe(true)
        expect(events.filter((event) => event.type === 'step/end')).toHaveLength(1)
        const end = events.find((event) => event.type === 'turn/end')
        expect(end?.type === 'turn/end' ? end.data.reason : undefined).toEqual({
          kind: 'interrupted',
        })
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

  test('a second subscriber follows the same live log the first one reads', async () => {
    const input = makeInput()
    await withHost(input, (host) =>
      Effect.gen(function* () {
        // Two devices read one host: neither takes the other's copy of the log.
        const first = yield* Effect.forkScoped(host.events.pipe(Stream.take(3), Stream.runCollect))
        const second = yield* Effect.forkScoped(host.events.pipe(Stream.take(3), Stream.runCollect))
        yield* Effect.sleep(10)
        yield* input.append('safety/approval/requested', {
          callId: 'c1',
          tool: 'bash',
          reason: 'outside the preset',
        })
        yield* input.append('safety/approval/answered', { callId: 'c1', approved: true })
        yield* input.append('user/message', { text: 'after the approval', source: 'user' })
        const typesOf = (events: ReadonlyArray<UiEvent>): ReadonlyArray<string> =>
          events.flatMap((event) => (event.kind === 'session' ? [event.event.type] : []))
        const one = [...(yield* Fiber.join(first))]
        const two = [...(yield* Fiber.join(second))]
        expect(typesOf(one)).toEqual([
          'safety/approval/requested',
          'safety/approval/answered',
          'user/message',
        ])
        expect(typesOf(two)).toEqual(typesOf(one))
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
