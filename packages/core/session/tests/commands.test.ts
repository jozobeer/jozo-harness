import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import {
  commandEventSchemas,
  commandHelp,
  makeCommands,
  makeSession,
  type CommandOutcome,
} from '../src/index.ts'

const header = () =>
  ({
    seq: 1,
    time: 0,
    type: 'session/header',
    data: { formatVersion: 1, createdAt: 0, cwd: '/work' },
  }) as const

const build = () =>
  Effect.gen(function* () {
    const session = yield* makeSession({
      id: 's-1',
      events: [header()],
      sink: { append: () => Effect.void, flush: () => Effect.void },
      now: () => 1,
    })
    const commands = makeCommands()
    yield* commands.register({
      name: 'echo',
      summary: 'says what it is told',
      run: (input): Effect.Effect<CommandOutcome> =>
        Effect.succeed({ ok: true, text: 'echo: ' + input }),
    })
    yield* commands.register({
      name: 'boom',
      summary: 'always fails',
      run: () => Effect.die('the command blew up'),
    })
    return { session, commands }
  })

describe('the command registry', () => {
  test('a line that names a command is recognised, anything else is not', async () => {
    const { commands } = await Effect.runPromise(build())

    expect(commands.parse('/echo hello there')).toEqual({ name: 'echo', input: 'hello there' })
    expect(commands.parse('  /echo   spaced  out ')).toEqual({ name: 'echo', input: 'spaced  out' })
    expect(commands.parse('hello /echo')).toBeUndefined()
    expect(commands.parse('/')).toBeUndefined()
    expect(commands.parse('just a message')).toBeUndefined()
  })

  test('running records the command and its answer in the log', async () => {
    const { session, commands } = await Effect.runPromise(build())

    const outcome = await Effect.runPromise(commands.run('/echo hi', session))

    expect(outcome).toEqual({ ok: true, text: 'echo: hi' })
    const events = session.events().filter((event) => event.type.startsWith('command/'))
    expect(events.map((event) => event.type)).toEqual(['command/run', 'command/done'])
    expect(events[0]?.data).toMatchObject({ commandId: 'cmd-1', name: 'echo', input: 'hi' })
    expect(events[1]?.data).toMatchObject({ commandId: 'cmd-1', ok: true, text: 'echo: hi' })
  })

  test('an unknown command answers with what there is, and the refusal reaches the log', async () => {
    const { session, commands } = await Effect.runPromise(build())

    const outcome = await Effect.runPromise(commands.run('/nope', session))

    expect(outcome?.ok).toBe(false)
    expect(outcome?.text).toContain('unknown command: nope')
    expect(outcome?.text).toContain('/echo')
    // A page only hears answers through the log, so the refusal is written there.
    const events = session.events().filter((event) => event.type.startsWith('command/'))
    expect(events.map((event) => event.type)).toEqual(['command/run', 'command/done'])
    expect(events[0]?.data).toMatchObject({ commandId: 'cmd-1', name: 'nope', input: '' })
    expect(events[1]?.data).toMatchObject({
      commandId: 'cmd-1',
      name: 'nope',
      ok: false,
      text: outcome?.text,
    })
    expect(await Effect.runPromise(commands.run('not a command', session))).toBeUndefined()
  })

  test('a command that blows up is still one the human hears about', async () => {
    const { session, commands } = await Effect.runPromise(build())

    const outcome = await Effect.runPromise(commands.run('/boom', session))

    expect(outcome?.ok).toBe(false)
    expect(outcome?.text).toContain('the command blew up')
    expect(session.events().map((event) => event.type)).toContain('command/done')
  })

  test('two commands cannot take the same name', async () => {
    const { commands } = await Effect.runPromise(build())

    const again = await Effect.runPromise(
      commands.register({
        name: 'echo',
        summary: 'again',
        run: () => Effect.succeed({ ok: true, text: '' }),
      }),
    ).catch((error: unknown) => error)

    expect(String(again)).toContain('already')
  })

  test('help names every command with its summary', async () => {
    const { commands } = await Effect.runPromise(build())

    const text = commandHelp(commands.list())

    expect(text).toContain('/echo')
    expect(text).toContain('says what it is told')
    expect(commandHelp([])).toContain('no commands')
  })

  test('the events this registry writes are declared', () => {
    expect([...commandEventSchemas.keys()]).toEqual(['command/run', 'command/done'])
  })
})
