import { agentPlugin } from '@jozo-harness/agent'
import { agentLoopPlugin } from '@jozo-harness/agent-loop'
import { kernelPlugin, type Plugin } from '@jozo-harness/kernel'
import { Llm, type LlmAdapter, type LlmRequest, type StreamChunk } from '@jozo-harness/llm'
import { askPlugin, safetyPlugin } from '@jozo-harness/safety'
import { sessionPlugin } from '@jozo-harness/session'
import { jsonlSessions, sessionJsonlPlugin } from '@jozo-harness/session-jsonl'
import { systemPromptPlugin } from '@jozo-harness/system-prompt'
import { toolsPlugin } from '@jozo-harness/tools'
import { tier0Plugin } from '@jozo-harness/tools-tier0'
import { tier1Plugin } from '@jozo-harness/tools-tier1'
import { Effect, Layer, Schema, Stream } from 'effect'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'
import { runCommand } from '../src/index.ts'

const textTurn = (text: string): ReadonlyArray<StreamChunk> => [
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', kind: 'stop' },
]

const toolTurn = (name: string, args: unknown): ReadonlyArray<StreamChunk> => [
  {
    type: 'block-end',
    index: 0,
    block: { type: 'tool-call', id: 'c-' + name, name, arguments: JSON.stringify(args) },
  },
  { type: 'finish', kind: 'tool-calls' },
]

const textOf = (request: LlmRequest): string =>
  request.messages
    .flatMap((message) => message.content)
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')

/** The teammate's turn is the one whose user message is the work handed to it. */
const isChildTurn = (request: LlmRequest): boolean =>
  request.messages.some(
    (message) =>
      message.role === 'user' &&
      message.content.some((block) => block.type === 'text' && block.text === 'write the guide'),
  )

const childIdIn = (request: LlmRequest): string =>
  /\[child session: ([^\]]+)\]/.exec(textOf(request))?.[1] ?? 'missing'

/** The lead spawns a teammate, hands it work, waits, then records the board. */
const leadTurn = (step: number, request: LlmRequest): ReadonlyArray<StreamChunk> => {
  if (step === 1) {
    return toolTurn('team', { action: 'spawn', name: 'builder', role: 'writes the guide' })
  }
  if (step === 2) return toolTurn('team', { action: 'create', title: 'write the guide' })
  if (step === 3)
    return toolTurn('send_message', { id: childIdIn(request), message: 'write the guide' })
  if (step === 4) return toolTurn('wait_agent', { id: childIdIn(request) })
  if (step === 5) {
    return toolTurn('team', { action: 'update', id: 'task-1', state: 'done', revision: 1 })
  }
  return textTurn('the guide is written')
}

const stubLlm = (requests: Array<LlmRequest>): Plugin<{}, Llm, never> => {
  let step = 1
  return {
    name: 'stub-llm',
    config: Schema.Struct({}),
    provides: [Llm],
    requires: [],
    layer: () =>
      Layer.succeed(Llm, {
        name: 'stub',
        capabilities: {
          toolChoice: false,
          reasoningEffort: null,
          images: 'none',
          promptCacheControl: false,
        },
        stream: (request) => {
          requests.push(request)
          if (isChildTurn(request)) return Stream.fromIterable(textTurn('the guide is written'))
          const script = leadTurn(step, request)
          step += 1
          return Stream.fromIterable(script)
        },
      } satisfies LlmAdapter),
  }
}

const profile = (root: string): string =>
  [
    'name: test',
    'plugins:',
    '  - id: kernel',
    "    name: '@jozo-harness/kernel'",
    '  - id: sessions',
    "    name: '@jozo-harness/session'",
    '  - id: session-jsonl',
    "    name: '@jozo-harness/session-jsonl'",
    '    config:',
    '      root: ' + root,
    '  - id: tools',
    "    name: '@jozo-harness/tools'",
    '  - id: system-prompt',
    "    name: '@jozo-harness/system-prompt'",
    '  - id: safety',
    "    name: '@jozo-harness/safety'",
    '    config:',
    '      preset: full',
    '  - id: ask',
    "    name: '@jozo-harness/ask'",
    '  - id: tier0',
    "    name: '@jozo-harness/tools-tier0'",
    '  - id: tier1',
    "    name: '@jozo-harness/tools-tier1'",
    '  - id: llm',
    '    name: stub-llm',
    '  - id: agent',
    "    name: '@jozo-harness/agent'",
    '  - id: agent-loop',
    "    name: '@jozo-harness/agent-loop'",
  ].join('\n')

describe('a team through the command', () => {
  test('the lead spawns a teammate, hands out work, and moves the board', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-team-'))
    const requests: Array<LlmRequest> = []
    const errs: Array<string> = []
    const code = await Effect.runPromise(
      runCommand({
        profiles: [profile(root)],
        plugins: [
          kernelPlugin,
          sessionJsonlPlugin,
          sessionPlugin,
          toolsPlugin,
          systemPromptPlugin,
          safetyPlugin,
          askPlugin,
          tier0Plugin,
          tier1Plugin,
          stubLlm(requests),
          agentPlugin,
          agentLoopPlugin,
        ] as ReadonlyArray<Plugin<any, any, any>>,
        cwd: '/tmp',
        route: 'stub/model',
        task: 'get the guide written',
        subagents: true,
        stdout: () => undefined,
        stderr: (text) => {
          errs.push(text)
        },
      }),
    )

    const sessions = await Effect.runPromise(jsonlSessions({ root }).list())
    expect(errs.join('')).toBe('')
    expect(code).toBe(0)
    // The lead and its one teammate, each with its own log.
    expect(sessions).toHaveLength(2)
    const logs = await Promise.all(
      sessions.map((session) =>
        Effect.runPromise(jsonlSessions({ root }).open(session.id)).then((opened) => opened.events),
      ),
    )
    const lead = logs.find((events) => events.some((event) => event.type === 'team/spawned'))
    const child = logs.find((events) => events !== lead)
    const spoken = (
      events: ReadonlyArray<{ readonly type: string; readonly data: unknown }>,
    ): ReadonlyArray<string> =>
      events.flatMap((event) =>
        event.type === 'user/message' && (event.data as { source: string }).source === 'user'
          ? [(event.data as { text: string }).text]
          : [],
      )

    expect(
      lead?.flatMap((event) => (event.type === 'team/spawned' ? [event.data] : [])),
    ).toHaveLength(1)
    expect(
      lead?.flatMap((event) => (event.type === 'team/task/updated' ? [event.data] : [])),
    ).toEqual([{ task: { id: 'task-1', title: 'write the guide', state: 'done', revision: 2 } }])
    // The task reached the teammate as its own turn.
    expect(spoken(child ?? [])).toEqual(['write the guide'])
    // Every teammate request says who it is; the lead never reads that line.
    const childRequests = requests.filter(isChildTurn)
    expect(childRequests).toHaveLength(1)
    expect(textOf(childRequests[0] as LlmRequest)).toContain(
      'team: you are teammate "builder" (writes the guide); your Team Lead is session ',
    )
    expect(
      requests
        .filter((request) => !isChildTurn(request))
        .map(textOf)
        .join('\n'),
    ).not.toContain('team: you are teammate')

    await rm(root, { recursive: true, force: true })
  })

  test('teammates talk to each other and a task waits for its dependency', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jozo-harness-team-peers-'))
    const requests: Array<LlmRequest> = []
    const errs: Array<string> = []
    const builderTurn = (request: LlmRequest): ReadonlyArray<StreamChunk> =>
      textOf(request).includes('sent to writer: review the draft')
        ? textTurn('the draft is done')
        : toolTurn('team', { action: 'send', to: 'writer', text: 'review the draft' })
    const writerTurn = (): ReadonlyArray<StreamChunk> => textTurn('looks good')
    const isBuilder = (request: LlmRequest): boolean => textOf(request).includes('write the guide')
    const isWriter = (request: LlmRequest): boolean =>
      request.messages.some(
        (message) =>
          message.role === 'user' &&
          message.content.some(
            (block) =>
              block.type === 'text' && block.text === 'peer message from builder: review the draft',
          ),
      )
    const leadScript: ReadonlyArray<(request: LlmRequest) => ReadonlyArray<StreamChunk>> = [
      () => toolTurn('team', { action: 'spawn', name: 'builder' }),
      () => toolTurn('team', { action: 'spawn', name: 'writer' }),
      () => toolTurn('team', { action: 'create', title: 'draft the guide' }),
      () =>
        toolTurn('team', {
          action: 'create',
          title: 'publish the guide',
          blockedBy: ['task-1'],
        }),
      (request) => toolTurn('send_message', { id: childIdIn(request), message: 'write the guide' }),
      (request) => toolTurn('wait_agent', { id: childIdIn(request) }),
      // This completion must be refused while task-1 is still open.
      () => toolTurn('team', { action: 'update', id: 'task-2', state: 'done', revision: 1 }),
      () => toolTurn('team', { action: 'update', id: 'task-1', state: 'done', revision: 1 }),
      () => toolTurn('team', { action: 'update', id: 'task-2', state: 'done', revision: 1 }),
    ]
    const leadTurn = (step: number, request: LlmRequest): ReadonlyArray<StreamChunk> =>
      leadScript[step - 1]?.(request) ?? textTurn('the guide is published')
    let leadStep = 1
    const peersLlm: Plugin<{}, Llm, never> = {
      name: 'stub-llm',
      config: Schema.Struct({}),
      provides: [Llm],
      requires: [],
      layer: () =>
        Layer.succeed(Llm, {
          name: 'stub',
          capabilities: {
            toolChoice: false,
            reasoningEffort: null,
            images: 'none',
            promptCacheControl: false,
          },
          stream: (request) => {
            requests.push(request)
            if (isWriter(request)) return Stream.fromIterable(writerTurn())
            if (isBuilder(request)) return Stream.fromIterable(builderTurn(request))
            const script = leadTurn(leadStep, request)
            leadStep += 1
            return Stream.fromIterable(script)
          },
        } satisfies LlmAdapter),
    }
    const code = await Effect.runPromise(
      runCommand({
        profiles: [profile(root)],
        plugins: [
          kernelPlugin,
          sessionJsonlPlugin,
          sessionPlugin,
          toolsPlugin,
          systemPromptPlugin,
          safetyPlugin,
          askPlugin,
          tier0Plugin,
          tier1Plugin,
          peersLlm,
          agentPlugin,
          agentLoopPlugin,
        ] as ReadonlyArray<Plugin<any, any, any>>,
        cwd: '/tmp',
        route: 'stub/model',
        task: 'get the guide published',
        subagents: true,
        stdout: () => undefined,
        stderr: (text) => {
          errs.push(text)
        },
      }),
    )

    const sessions = await Effect.runPromise(jsonlSessions({ root }).list())
    expect(errs.join('')).toBe('')
    expect(code).toBe(0)
    expect(sessions).toHaveLength(3)
    const logs = await Promise.all(
      sessions.map((session) =>
        Effect.runPromise(jsonlSessions({ root }).open(session.id)).then((opened) => opened.events),
      ),
    )
    const lead = logs.find((events) => events.some((event) => event.type === 'team/spawned'))
    const builder = logs.find((events) =>
      events.some(
        (event) => event.type === 'user/message' && event.data.text === 'write the guide',
      ),
    )
    const writer = logs.find((events) => events !== lead && events !== builder)

    expect(
      lead?.flatMap((event) => (event.type === 'team/spawned' ? [event.data] : [])),
    ).toHaveLength(2)
    if (lead === undefined || writer === undefined) throw new Error('the run left no team logs')
    // The peer message is in the writer's own log, sent by the builder, not relayed by the lead.
    expect(writer.flatMap((event) => (event.type === 'team/message' ? [event.data] : []))).toEqual([
      expect.objectContaining({
        from: 'builder',
        to: 'writer',
        text: 'review the draft',
        fromSession: expect.any(String),
        at: expect.any(String),
      }),
    ])
    expect(lead.flatMap((event) => (event.type === 'team/message' ? [event.data] : []))).toEqual([])
    // The writer's next turn reads the message from its runtime context.
    expect(requests.filter(isWriter).map(textOf).join('\n')).toContain(
      'team inbox: builder: review the draft',
    )
    // Completing the dependent task before its dependency is refused, and the
    // refusal names the open task on the next request.
    expect(requests.map(textOf).join('\n')).toContain(
      'cannot complete task-2: waiting on task-1 (pending)',
    )
    // The board still reaches done once the dependency lands.
    expect(
      lead
        .flatMap((event) => (event.type === 'team/task/updated' ? [event.data.task] : []))
        .map((task) => [task.id, task.state]),
    ).toEqual([
      ['task-1', 'done'],
      ['task-2', 'done'],
    ])

    await rm(root, { recursive: true, force: true })
  })
})
